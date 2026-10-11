// TraceZeta Orchestrator.
//
// Drives the full loop: watch -> investigate -> propose fix -> verify ->
// accept/reject/iterate. One command runs the entire agent team against the
// live target system and neatlogs project.
//
// Exit status reflects the loop outcome:
//   0 = all incidents resolved (or none open)
//   1 = incidents remain open after the loop
//
// Every stage's output is a durable JSON artifact: incidents/, diagnoses/,
// fixes/, verifications/. The orchestrator only links them together.

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from './sentinel.js';
import { investigate } from './investigator.js';
import { proposeFix } from './fixer.js';
import { verify } from './verifier.js';
import { traceStage, sentinelStage, investigatorStage, fixerStage, verifierStage } from './selftrace.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const LOOP_DIR = join(ROOT, 'loop-runs');

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

function listIncidents(status) {
  const dir = join(ROOT, 'incidents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => readJson(join(dir, f)))
    .filter((inc) => status ? inc.status === status : true);
}

/**
 * Full autonomous cycle. Max rounds bounds iteration (a fix that keeps
 * failing is escalated, not looped forever).
 */
export async function runLoop({ maxRounds = 2 } = {}) {
  const report = {
    startedAt: new Date().toISOString(),
    stages: [],
    outcome: null,
  };

  // Stage 1: Sentinel watch
  const w = await watch();
  report.stages.push({ agent: 'sentinel', opened: w.opened.length, errors: w.errors });
  await traceStage('sentinel-watch', sentinelStage(w));

  // Stage 2: for each open incident, Investigator -> Fixer -> Verifier
  const openIncidents = listIncidents('open');
  let resolved = 0;
  let unresolved = 0;
  const escalations = [];

  for (const incident of openIncidents) {
    const incFile = join(ROOT, 'incidents', `${incident.id}.json`);
    let rounds = 0;
    let accepted = false;

    while (rounds < maxRounds && !accepted) {
      rounds++;

      // Investigate
      const diagnosis = await investigate(incident);
      report.stages.push({
        agent: 'investigator', incident: incident.id, round: rounds,
        verdict: diagnosis.verdict,
        rootCauses: diagnosis.rootCauses?.map((r) => r.id) || [],
      });
      await traceStage(`investigate-${incident.id}`, investigatorStage(incident.id, diagnosis));
      if (diagnosis.verdict !== 'ROOT_CAUSE_IDENTIFIED') {
        escalations.push({ incident: incident.id, reason: `investigation ${diagnosis.verdict}` });
        unresolved++;
        break;
      }

      // Propose fix
      const fixResult = proposeFix(incident, diagnosis);
      await traceStage(`propose-fix-${incident.id}`, fixerStage(fixResult));
      if (!fixResult.proposed) {
        escalations.push({ incident: incident.id, reason: `fixer refused: ${fixResult.reason}` });
        unresolved++;
        break;
      }
      const fix = fixResult.fix;

      // Verify (re-runs the target for real)
      const verification = await verify(incident, diagnosis, fix);
      report.stages.push({
        agent: 'verifier', incident: incident.id, round: rounds,
        verdict: verification.verdict,
        beforeFailing: verification.before.failingSteps.length,
        afterFailing: verification.after.failingSteps.length,
      });
      await traceStage(`verify-${incident.id}`, verifierStage(verification));

      if (verification.accepted) {
        accepted = true;
        fix.applied = true;
        const fixPath = join(ROOT, 'fixes', `${incident.id}-fix.json`);
        writeFileSync(fixPath, JSON.stringify(fix, null, 2));
        incident.status = 'resolved';
        incident.resolvedAt = new Date().toISOString();
        incident.resolution = {
          diagnosisFile: diagnosis.file,
          fixFile: fixPath,
          verificationFile: verification.file,
          afterTraceId: verification.after.traceId,
        };
        writeFileSync(incFile, JSON.stringify(incident, null, 2));
        resolved++;
      } else if (rounds >= maxRounds) {
        escalations.push({ incident: incident.id, reason: `verification ${verification.verdict} after ${rounds} rounds` });
        incident.status = 'escalated';
        writeFileSync(incFile, JSON.stringify(incident, null, 2));
        unresolved++;
      }
      // else: loop again — re-point the incident at the NEW run record (the
      // partially-fixed run) so round 2 diagnoses what remains, not the
      // original failure again
      incident.trace = { ...(incident.trace || {}), traceId: verification.after.traceId || incident.trace?.traceId };
      incident.runFile = verification.after.runFile || incident.runFile;
      writeFileSync(incFile, JSON.stringify(incident, null, 2));
    }
  }

  report.outcome = {
    incidentsOpenAtStart: openIncidents.length,
    resolved,
    unresolved,
    escalations,
  };
  report.finishedAt = new Date().toISOString();

  if (!existsSync(LOOP_DIR)) mkdirSync(LOOP_DIR, { recursive: true });
  const file = join(LOOP_DIR, `loop-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  report.file = file;
  return report;
}

// CLI: node src/agents/orchestrator.js [--rounds N]
if (process.argv[1] && process.argv[1].endsWith('orchestrator.js')) {
  const rounds = parseInt(process.argv.find((a) => a.startsWith('--rounds='))?.split('=')[1] || '2', 10);
  const report = await runLoop({ maxRounds: rounds });
  console.log(JSON.stringify({
    outcome: report.outcome,
    stages: report.stages,
    file: report.file,
  }, null, 2));
  process.exit(report.outcome.unresolved > 0 ? 1 : 0);
}
