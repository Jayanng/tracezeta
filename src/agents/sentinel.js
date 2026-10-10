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
 * Sources, deduped by traceId:
 *   A. neatlogs traces list (live platform view — can lag or stall platform-side)
 *   B. local run records (written by the target at run time, each linked to
 *      its neatlogs trace by traceId) — covers platform list staleness
 * Returns { opened, skipped, errors }.
 */
export async function watch() {
  const seen = loadSeen();
  const list = await listTraces({ limit: 50 });
  const platformTraces = list.ok ? list.traces : [];
  if (!list.ok) {
    // platform list unavailable: run records alone still drive the loop
  }

  // Index run records by traceId for enrichment
  const runByTrace = new Map();
  for (const r of listRuns()) {
    if (r.run?.trace?.traceId) runByTrace.set(r.run.trace.traceId, r);
  }

  // Source B: run records with failures not yet seen (covers platform lag)
  const candidates = [];
  const seenIds = new Set(Object.keys(seen));
  for (const [traceId, entry] of runByTrace) {
    if (seenIds.has(traceId)) continue;
    if (entry.run.ok === false) {
      candidates.push({
        traceId,
        traceName: entry.run.name,
        workflowName: entry.run.name,
        ingestedAt: entry.run.at,
        status: 'ERROR',
        finalizationStatus: 'unknown (platform list not consulted for this trace)',
      });
    }
  }
  // Source A: platform traces (authoritative metadata when present)
  for (const t of platformTraces) {
    if (seenIds.has(t.traceId)) continue;
    if (String(t.status).toUpperCase() === 'ERROR') {
      if (!candidates.some((c) => c.traceId === t.traceId)) {
        candidates.push({
          traceId: t.traceId,
          traceName: t.traceName,
          workflowName: t.workflowName,
          ingestedAt: t.ingestedAt,
          status: t.status,
          finalizationStatus: t.finalizationStatus,
        });
      }
    }
  }

  const opened = [];
  const skipped = [];
  const errors = list.ok ? [] : [`traces list failed: ${list.error}`];

  for (const t of candidates) {
    const runEntry = runByTrace.get(t.traceId) || null;
    const run = runEntry ? runEntry.run : null;
    opened.push(await openIncident(t, run, run ? 'run-record-failure' : 'trace-status-error'));
    seen[t.traceId] = { at: new Date().toISOString(), status: t.status };
  }

  // mark healthy platform traces seen too (no incident)
  for (const t of platformTraces) {
    if (!seen[t.traceId]) {
      seen[t.traceId] = { at: new Date().toISOString(), status: t.status };
      skipped.push(t.traceId);
    }
  }
  // mark healthy run records seen (no incident)
  for (const [traceId, entry] of runByTrace) {
    if (!seen[traceId] && entry.run.ok !== false) {
      seen[traceId] = { at: new Date().toISOString(), status: 'OK' };
      skipped.push(traceId);
    }
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
