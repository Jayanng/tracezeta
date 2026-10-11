// TraceZeta Verifier.
//
// Proves a fix: applies the proposed repairs to the task, re-runs the target,
// and compares BEFORE vs AFTER at the span level. Red-teams the fix by
// checking it fixed exactly the failing steps and changed nothing else.
// Acceptance requires: all previously-failing steps now pass, all previously-
// passing steps still pass, and the new trace + run record exist.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTask } from '../target/index.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const VERIFICATIONS_DIR = join(ROOT, 'verifications');

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

/**
 * Verify a fix end to end.
 * @param incident   the incident record
 * @param diagnosis  the diagnosis record
 * @param fixRecord  the fix record (with repairs)
 */
export async function verify(incident, diagnosis, fixRecord) {
  const runFile = diagnosis.evidenceSources.runFile;
  if (!runFile) {
    // no run record = no before-state to re-run against; honest refusal
    return {
      incidentId: incident.id,
      verifiedAt: new Date().toISOString(),
      accepted: false,
      verdict: 'FIX_REJECTED: no run record for the failing trace (no before-state)',
    };
  }
  const beforeRun = readJson(runFile);
  const beforeTask = beforeRun.task;
  const beforeSpans = beforeRun.spans || [];
  const failingBefore = beforeSpans.filter((s) => s.status === 'ERROR').map((s) => s.name);
  const passingBefore = beforeSpans.filter((s) => s.status === 'OK').map((s) => s.name);

  // 1. Build the fixed task from the repairs
  const repairs = fixRecord.repairs || [];
  const fixedTask = JSON.parse(JSON.stringify(beforeTask));
  fixedTask.name = `${beforeTask.name}-after-fix`;
  // mark the re-run as a VERIFICATION run: the Sentinel must not open new
  // incidents for the loop's own retries (outage fork protection)
  fixedTask.verification = true;
  // apply in order: each repair consumes the matching step of its tool
  // (matched by argument identity, then tool order); remove: true DELETES the
  // step. Indexes go stale the moment a splice shifts the array.
  const consumed = new Set();
  const removedByRepair = [];
  for (const repair of repairs) {
    // match by ARGUMENT IDENTITY when the repair carries its original args —
    // matching by tool+order alone deletes/re-writes the WRONG instance when a
    // tool is called more than once (a healthy call can precede the failing one)
    const byArgs = repair.original && Object.keys(repair.original).length
      ? (s) => s.tool === repair.tool && !consumed.has(s)
          && JSON.stringify(s.args) === JSON.stringify(repair.original)
      : (s) => s.tool === repair.tool && !consumed.has(s);
    const step = fixedTask.steps.find(byArgs) || fixedTask.steps.find((s) => s.tool === repair.tool && !consumed.has(s));
    if (!step) continue;
    consumed.add(step);
    if (repair.remove === true) {
      fixedTask.steps.splice(fixedTask.steps.indexOf(step), 1);
      removedByRepair.push(repair.tool);
    } else {
      if (repair.replaceToolWith) {
        // wrong-tool fix: swap the tool and use the ORIGINAL args (e.g.
        // {query: 'founders'}) — the args were valid, the tool choice was wrong
        step.tool = repair.replaceToolWith;
        if (repair.original && Object.keys(repair.original).length) {
          step.args = JSON.parse(JSON.stringify(repair.original));
        }
      } else {
        step.args = repair.repaired;
      }
    }
  }

  // 2. Re-run the target with the fixed task (real run, new trace, new record)
  const after = await runTask(fixedTask);
  // the after spans live in the after run RECORD (runTask returns no spans
  // field). FAIL CLOSED: if the record cannot be read, the comparison cannot
  // run and the fix is NOT verified (an empty array would silently accept).
  let afterSpans = null;
  try {
    if (after.runFile) afterSpans = readJson(after.runFile).spans || [];
  } catch { afterSpans = null; }
  if (afterSpans === null) {
    return {
      incidentId: incident.id,
      accepted: false,
      verdict: 'FIX_REJECTED: after run record unreadable — the span comparison cannot run',
      after: { traceId: after.traceId, runFile: after.runFile, failingSteps: [], passingSteps: [] },
    };
  }
  const failingAfter = afterSpans.filter((s) => s.status === 'ERROR').map((s) => s.name);
  const passingAfter = afterSpans.filter((s) => s.status === 'OK').map((s) => s.name);

  // 3. Red-team the fix: exactly the intended changes. Steps REMOVED by an
  // approved remove:true repair are reported as removed (they neither pass nor
  // fail — they are gone by design), never counted as "now passing".
  const removedNames = new Set(removedByRepair.flatMap((t) => [`tool:${t}`, t]));
  const failingAccounted = failingBefore.filter((s) => !removedNames.has(s));
  const nowPassing = failingAccounted.filter((s) => passingAfter.includes(s));
  const stillFailing = failingAccounted.filter((s) => failingAfter.includes(s));
  const regressed = passingBefore.filter((s) => failingAfter.includes(s)); // healthy steps broke
  const dropped = passingBefore.filter((s) => !afterSpans.some((a) => a.name === s));

  const accepted = stillFailing.length === 0 && regressed.length === 0
    && dropped.length === 0 && after.ok === true;

  const verification = {
    incidentId: incident.id,
    fixFile: fixRecord.file || null,
    verifiedAt: new Date().toISOString(),
    accepted,
    before: {
      traceId: beforeRun.trace?.traceId || incident.trace.traceId,
      runFile: diagnosis.evidenceSources.runFile,
      failingSteps: failingBefore,
      passingSteps: passingBefore,
    },
    after: {
      traceId: after.traceId,
      runFile: after.runFile,
      failingSteps: failingAfter,
      passingSteps: passingAfter,
      traceError: after.traceError,
    },
    comparison: {
      nowPassing,
      stillFailing,
      regressedHealthySteps: regressed,
      droppedSteps: dropped,
      removedByRepair,
    },
    verdict: accepted
      ? (removedByRepair.length ? `FIX_VERIFIED (step removed: ${removedByRepair.join(', ')})` : 'FIX_VERIFIED')
      : stillFailing.length
        ? 'FIX_INCOMPLETE: steps still failing'
        : regressed.length
          ? 'FIX_REJECTED: regressed previously-healthy steps'
          : dropped.length
            ? 'FIX_REJECTED: previously-healthy steps disappeared from the run'
            : 'FIX_REJECTED',
  };

  if (!existsSync(VERIFICATIONS_DIR)) mkdirSync(VERIFICATIONS_DIR, { recursive: true });
  const file = join(VERIFICATIONS_DIR, `${incident.id}-verification.json`);
  writeFileSync(file, JSON.stringify(verification, null, 2));
  verification.file = file;
  return verification;
}

// CLI: node src/agents/verifier.js <incident.json> <diagnosis.json> <fix.json>
if (process.argv[1] && process.argv[1].endsWith('verifier.js')) {
  const [, , incidentPath, diagnosisPath, fixPath] = process.argv;
  if (!incidentPath || !diagnosisPath || !fixPath) {
    console.error('usage: node src/agents/verifier.js <incident.json> <diagnosis.json> <fix.json>');
    process.exit(2);
  }
  const v = await verify(readJson(incidentPath), readJson(diagnosisPath), readJson(fixPath));
  console.log(JSON.stringify({
    verdict: v.verdict,
    beforeFailing: v.before.failingSteps,
    afterFailing: v.after.failingSteps,
    nowPassing: v.comparison.nowPassing,
    regressed: v.comparison.regressedHealthySteps,
    newTraceId: v.after.traceId,
  }, null, 2));
  process.exit(v.accepted ? 0 : 1);
}
