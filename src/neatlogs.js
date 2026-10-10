// TraceZeta tracing layer.
//
// REALITY, verified live against the neatlogs platform (2026-10-10, phase 0-1):
//   - POST /v1/trace ingest works and returns real trace IDs
//   - traces list/get read back works (status, tokens, counts, finalizationStatus)
//   - comment-thread write-back works with observability:write scope
//   - span PROJECTION (spans list/export) has been failing since ~21:40Z
//     (finalizationStatus: "dlq") for ALL traces, including the official SDK's
//     own output. Platform-side. We re-check it at runtime and use it when live.
//
// DESIGN: the target system records EVERYTHING it does in a structured run
// record (spans, inputs, outputs, errors, timings) written to disk at the same
// moment the trace is posted. The trace ID links the neatlogs trace to the run
// record. This is not a mock: the neatlogs trace is the live monitoring layer
// and the permanent audit trail; the run record is deep evidence the platform
// API cannot currently project. If span projection recovers, the Investigator
// uses it directly; until then it cites the run record + the trace metadata
// that DOES read back, and says so honestly.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const RUNS_DIR = join(ROOT, 'runs');

export function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const ENV = loadEnv();

// ---------------------------------------------------------------------------
// neatlogs client: ingest + read + write-back, via the CLI (it handles OAuth
// token refresh; raw REST tokens expire hourly).
// ---------------------------------------------------------------------------

const INGEST = 'https://ingest.neatlogs.com/v1/trace';

export async function postTrace(trace) {
  try {
    const res = await fetch(INGEST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ENV.NEATLOGS_WRITE_KEY}`,
      },
      body: JSON.stringify(trace),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success !== true) {
      return { ok: false, error: `ingest HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}` };
    }
    return { ok: true, traceId: json.trace_id, spans: json.spans };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function listTraces({ limit = 20 } = {}) {
  const { execFile } = await import('node:child_process');
  const env = { ...process.env };
  delete env.NEATLOGS_API_KEY; delete env.NEATLOGS_TOKEN;
  return new Promise((resolve) => {
    execFile('neatlogs', [
      '--host', 'https://app.neatlogs.com',
      '--profile', 'setup-https---app-neatlogs-com',
      '--credential-source', 'profile',
      '--project', ENV.NEATLOGS_PROJECT_ID,
      'traces', 'list', '--limit', String(limit), '--json',
    ], { env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: String(err).slice(0, 200) });
      try { resolve({ ok: true, traces: JSON.parse(stdout).data.traces }); }
      catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });
}

export async function getTraceSpans(traceId) {
  const { execFile } = await import('node:child_process');
  const env = { ...process.env };
  delete env.NEATLOGS_API_KEY; delete env.NEATLOGS_TOKEN;
  return new Promise((resolve) => {
    execFile('neatlogs', [
      '--host', 'https://app.neatlogs.com',
      '--profile', 'setup-https---app-neatlogs-com',
      '--credential-source', 'profile',
      '--project', ENV.NEATLOGS_PROJECT_ID,
      'traces', 'spans', 'list', traceId, '--json',
    ], { env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const raw = String(err.stdout || err.message || '');
        return resolve({ ok: false, code: raw.includes('DLQ') || raw.includes('FINALIZATION') ? 'DLQ' : 'ERROR', error: raw.slice(0, 200) });
      }
      try { resolve({ ok: true, spans: JSON.parse(stdout).data.spans }); }
      catch (e) { resolve({ ok: false, code: 'ERROR', error: e.message }); }
    });
  });
}

// ---------------------------------------------------------------------------
// Run records: the deep evidence layer, linked to neatlogs by trace ID.
// ---------------------------------------------------------------------------

export function recordRun(run) {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(RUNS_DIR, `${stamp}-${run.name}.json`);
  writeFileSync(file, JSON.stringify(run, null, 2));
  return file;
}

export function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const p = join(RUNS_DIR, f);
      return { file: p, mtime: statSync(p).mtimeMs, run: JSON.parse(readFileSync(p, 'utf8')) };
    });
}
