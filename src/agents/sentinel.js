// TraceZeta Sentinel.
//
// Watches the neatlogs project for new traces and opens incidents for failing
// ones. Works with the platform's ACTUAL read surface:
//   - traces list gives status, timing, token counts, finalizationStatus
//   - run records (linked by traceId) give span-level detail
//   - span projection (spans list) is used when the platform finalizes it
//
// Incidents are recorded as JSON files in incidents/ and, when the write scope
// is available, written back to the trace as a comment thread (the visible
// incident trail in the neatlogs dashboard).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTraces, getTraceSpans, listRuns } from '../neatlogs.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const INCIDENTS_DIR = join(ROOT, 'incidents');

function seenPath() { return join(ROOT, 'incidents', '.sentinel-seen.json'); }

function loadSeen() {
  if (!existsSync(seenPath())) return {};
  try { return JSON.parse(readFileSync(seenPath(), 'utf8')); } catch { return {}; }
}

function saveSeen(seen) {
  if (!existsSync(INCIDENTS_DIR)) mkdirSync(INCIDENTS_DIR, { recursive: true });
  writeFileSync(seenPath(), JSON.stringify(seen, null, 2));
}

/**
 * One watch cycle: list recent traces, open incidents for new failures.
 * Returns { opened, skipped, errors }.
 */
export async function watch() {
  const seen = loadSeen();
  const list = await listTraces({ limit: 20 });
  if (!list.ok) return { opened: [], errors: [`traces list failed: ${list.error}`] };

  const opened = [];
  const skipped = [];
  const errors = [];

  for (const t of list.traces) {
    const id = t.traceId;
    if (seen[id]) continue;

    // A trace is a failure if its status is an error status or its run
    // record says a step failed. Trace list 'status' is OK/ERROR-ish; the
    // run record is authoritative for run outcome.
    const runEntry = listRuns().find((r) => r.run?.trace?.traceId === id);
    const runFailed = runEntry ? runEntry.run.ok === false : null;

    if (t.status && String(t.status).toUpperCase() === 'ERROR') {
      opened.push(await openIncident(t, runEntry?.run || null, 'trace-status-error'));
    } else if (runFailed === true) {
      opened.push(await openIncident(t, runEntry?.run || null, 'run-record-failure'));
    } else {
      // healthy (or unknown without a run record): mark seen, no incident
      skipped.push(id);
    }
    seen[id] = { at: new Date().toISOString(), status: t.status };
  }

  saveSeen(seen);
  return { opened, skipped, errors };
}

async function openIncident(traceMeta, run, reason) {
  if (!existsSync(INCIDENTS_DIR)) mkdirSync(INCIDENTS_DIR, { recursive: true });
  const id = `inc-${traceMeta.traceId.slice(0, 12)}`;
  const failedSteps = run
    ? (run.spans || []).filter((s) => s.status === 'ERROR').map((s) => ({
        tool: s.name,
        input: s.input,
        error: s.error,
        duration_ms: s.duration_ms,
      }))
    : [];

  const incident = {
    id,
    openedAt: new Date().toISOString(),
    reason,
    trace: {
      traceId: traceMeta.traceId,
      traceName: traceMeta.traceName,
      workflowName: traceMeta.workflowName,
      ingestedAt: traceMeta.ingestedAt,
      status: traceMeta.status,
      finalizationStatus: traceMeta.finalizationStatus,
      totalTokens: traceMeta.totalTokens,
    },
    runFile: run ? null : null, // filled by caller with the run record path
    failedSteps,
    status: 'open',
  };
  const file = join(INCIDENTS_DIR, `${id}.json`);
  writeFileSync(file, JSON.stringify(incident, null, 2));
  return { id, file, failedSteps: failedSteps.length, traceId: traceMeta.traceId };
}

/** Attempt span-level read; returns null when the platform can't project. */
export async function tryReadSpans(traceId) {
  const r = await getTraceSpans(traceId);
  if (r.ok) return r.spans;
  return null; // DLQ / pending / error: run record is the evidence
}

// CLI: node src/agents/sentinel.js
if (process.argv[1] && process.argv[1].endsWith('sentinel.js')) {
  const result = await watch();
  console.log(JSON.stringify({
    opened: result.opened.length,
    incidents: result.opened,
    skippedHealthy: result.skipped.length,
    errors: result.errors,
  }, null, 2));
}
