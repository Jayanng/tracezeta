// TraceZeta source repair: stage 4 — the full flow, wired into the Fixer.
//
// FLOW (the deep path, attempted when task-spec strategies refuse):
//   1. classifyCodeDefects (3 tests: shape, isolation, reproduction)
//   2. sandbox grant (ONE writable file: the tool's implementation;
//      the judging apparatus is unreadable+writable-never, OS-enforced)
//   3. agy session inside the sandbox patches the code (minimal, scoped)
//   4. the anti-reward-hacking gate judges the patch:
//      reproduction / recovery / error-preservation / no-regression / bounded diff
//   5. ACCEPTED -> recorded as AWAITING_HUMAN_REVIEW with the full diff.
//      The loop NEVER applies a source patch itself; a human reviews and
//      commits. (For the demo: the human is us.)
//   6. REJECTED -> the patch is REVERTED on disk and the refusal recorded.
//
// This module replaces the earlier prompt-only draft (source-repair.js):
// every guarantee here is enforced (OS ACLs, live probes), not requested.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantSingleFileWrite, verifyBoundary, snapshot, diffVsSnapshot, PROTECTED_SET } from './sandbox.js';
import { runGate, recordProposal } from './gate.js';
import { classifyCodeDefects, withReproduction } from './classifier.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RECORDS_DIR = join(ROOT, 'fixes', 'source-repairs');

/** Map a tool name to its implementation file (the only writable target). */
function toolSourceFile(tool) {
  const crustTools = ['company_search', 'company_enrich', 'person_search', 'job_search', 'web_search', 'social_post_search', 'credits_check'];
  const targetTools = ['get_exchange_rate', 'save_record', 'read_record', 'compute_schedule'];
  if (crustTools.includes(tool)) return join(ROOT, 'src', 'crustdata.js');
  if (targetTools.includes(tool)) return join(ROOT, 'src', 'target', 'index.js');
  return null;
}

/** One live step probe (same contract the gate uses). */
async function runStep(step) {
  const probeFile = join(ROOT, 'runtime', 'flow-probe.mjs');
  writeFileSync(probeFile, `
import { CRUST_TOOLS } from '${join(ROOT, 'src/crustdata.js').replace(/\\/g, '/')}';
import { TOOLS as T2 } from '${join(ROOT, 'src/target/index.js').replace(/\\/g, '/')}';
const ALL = { ...CRUST_TOOLS, ...T2 };
const step = ${JSON.stringify(step)};
try {
  const fn = ALL[step.tool];
  if (!fn) { console.log(JSON.stringify({ status: 'ERROR', error: 'unknown tool ' + step.tool })); process.exit(0); }
  const out = await fn(step.args);
  console.log(JSON.stringify({ status: 'OK', output: out }));
} catch (e) {
  console.log(JSON.stringify({ status: 'ERROR', error: e.message }));
}
`);
  try {
    const out = execFileSync('node', [probeFile], { encoding: 'utf8', timeout: 90000 });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (e) {
    return { status: 'ERROR', error: String(e.message || e).slice(0, 200) };
  }
}

/** Known-bad probe inputs per tool (must ALWAYS fail — the error oracle). */
function knownBadStepsFor(tool, failingArgs) {
  const kb = {
    company_search: [{ tool, args: { query: 42 } }],
    company_enrich: [{ tool, args: { domain: 'not a domain!!' } }, { tool, args: { domain: 'doesnotexist12345xyz.com' } }],
    person_search: [{ tool, args: { query: '' } }],
    job_search: [{ tool, args: { title: 7 } }],
    web_search: [{ tool, args: { query: '' } }],
    social_post_search: [{ tool, args: { text: '' } }],
    get_exchange_rate: [{ tool, args: { base: 'USD' } }],
    save_record: [{ tool, args: { name: 'bad name!', payload: {} } }],
    compute_schedule: [{ tool, args: { startDate: '2026-13-45', days: 14 } }],
  };
  return kb[tool] || [];
}

/** Healthy probe inputs per tool (must ALWAYS pass — regression oracle). */
function healthyStepsFor(tool) {
  const h = {
    company_search: [{ tool, args: { query: 'AI observability', limit: 2 } }],
    company_enrich: [{ tool, args: { domain: 'neatlogs.com' } }],
    person_search: [{ tool, args: { query: 'AI engineer', limit: 2 } }],
    job_search: [{ tool, args: { title: 'AI Engineer', limit: 2 } }],
    web_search: [{ tool, args: { query: 'neatlogs' } }],
    get_exchange_rate: [{ tool, args: { base: 'USD', quote: 'EUR' } }],
    compute_schedule: [{ tool, args: { startDate: '2026-10-11', days: 14 } }],
    save_record: [{ tool, args: { name: 'gateprobe', payload: { t: 1 } } }],
    credits_check: [{ tool, args: {} }],
  };
  return h[tool] || [];
}

/**
 * The full source-repair flow for one incident.
 * Returns a record; the loop treats 'proposedForReview' as the terminal
 * success state (a human applies the patch after reviewing the diff).
 */
export async function attemptSourceRepair(incident, diagnosis, runRecord) {
  const record = {
    incidentId: incident.id,
    at: new Date().toISOString(),
    stages: [],
    outcome: null,
  };

  // 1. CLASSIFY (hard 3-test classifier)
  const candidates = classifyCodeDefects(runRecord);
  if (!candidates.length) {
    record.outcome = 'not-a-code-defect';
    record.stages.push({ classify: 'no candidates survived the 3-test classifier' });
    return record;
  }
  const confirmed = await withReproduction(candidates, runStep);
  if (!confirmed.length) {
    record.outcome = 'not-reproducible';
    record.stages.push({ classify: `${candidates.length} candidates, none reproduced on re-probe (flaky/env, not a stable code defect)` });
    return record;
  }
  const target = confirmed[0];
  const targetFile = toolSourceFile(target.tool);
  if (!targetFile || !existsSync(targetFile)) {
    record.outcome = 'no-source-file';
    record.stages.push({ classify: `no implementation file mapped for tool '${target.tool}'` });
    return record;
  }
  record.stages.push({ classify: { tool: target.tool, error: target.error, reproduced: target.reproduced, targetFile } });

  // 2. SANDBOX (grant ONE file; verify the boundary live before the session)
  const before = snapshot(targetFile);
  let revoke;
  try {
    revoke = grantSingleFileWrite(targetFile);
  } catch (e) {
    record.outcome = 'sandbox-grant-failed';
    record.stages.push({ sandbox: String(e.message || e).slice(0, 200) });
    return record;
  }
  const boundary = verifyBoundary(targetFile);
  record.stages.push({ sandbox: { boundarySound: boundary.sound } });
  if (!boundary.sound) {
    revoke();
    record.outcome = 'boundary-unsound';
    record.stages.push({ sandbox: { violations: boundary.protectedBlocked } });
    return record;
  }

  // 3. AGY SESSION (inside the sandbox: reads repo, writes ONLY targetFile)
  // agy needs: HOME=/tmp/tz-home (its credential state), PATH for node.
  // The temp home is prepared once per host (see sandbox notes).
  let sessionOut = '';
  try {
    const prompt = `The tool '${target.tool}' in this repo has a code defect. Live error: "${target.error}" with input ${JSON.stringify(target.step.args)}. Its implementation is in ${targetFile}. Diagnose the defect from the error and the code, and apply a minimal, scoped fix to that file ONLY. You are running in a sandbox where ONLY this file is writable — access denied to other files is EXPECTED and by design, do not treat it as a blocker. Do not refactor, do not add try/catch around the tool body, do not change error behavior for invalid inputs. Make the edit directly (you CAN write that file). Reply with one paragraph: the defect and the fix.`;
    const r = execFileSync('sudo', [
      '-u', 'tracezeta-fix',
      '--', 'env', `HOME=/tmp/tz-home`, `PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin`,
      '/home/ubuntu/.local/bin/agy', '-p', prompt,
    ], {
      cwd: ROOT, encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    sessionOut = String(r).slice(0, 1000);
    record.stages.push({ repairSession: 'completed' });
  } catch (e) {
    revoke();
    record.outcome = 'repair-session-failed';
    record.stages.push({ repairSession: String(e.message || e).slice(0, 250) });
    return record;
  } finally {
    // ALWAYS revoke the grant, even on success
    try { revoke(); } catch { /* already revoked */ }
  }

  // 4. THE GATE (anti-reward-hacking; runs as owner, outside the sandbox)
  const changed = diffVsSnapshot(targetFile, before);
  if (!changed) {
    record.outcome = 'no-change-made';
    record.stages.push({ gate: 'the repair session made no changes' });
    return record;
  }
  const gate = await runGate({
    targetFile,
    failingStep: target.step,
    knownBadSteps: knownBadStepsFor(target.tool, target.step.args),
    healthySteps: healthyStepsFor(target.tool),
  });
  record.stages.push({ gate: { accepted: gate.accepted, verdict: gate.verdict || gate.rejection } });

  // 5. RECORD / REVERT
  const { file, proposal } = recordProposal(incident.id, gate, targetFile);
  if (gate.accepted) {
    record.outcome = 'proposedForReview';
    record.proposalFile = file;
    record.summary = sessionOut;
    record.proposalStatus = 'AWAITING_HUMAN_REVIEW';
    // the patch STAYS on disk as an uncommitted change for human review
  } else {
    record.outcome = 'rejected-by-gate';
    record.proposalFile = file;
    record.rejection = gate.rejection;
    // revert the rejected patch: restore the snapshot
    writeFileSync(targetFile, before);
    record.reverted = true;
  }

  if (!existsSync(RECORDS_DIR)) mkdirSync(RECORDS_DIR, { recursive: true });
  const recFile = join(RECORDS_DIR, `${incident.id}-flow.json`);
  writeFileSync(recFile, JSON.stringify(record, null, 2));
  record.flowFile = recFile;
  return record;
}
