// TraceZeta target system: a small, REAL tool-calling agent.
//
// This is the system the Breaker attacks and the Sentinel watches. Its tools
// do genuine work against real endpoints and real files. Nothing here is
// mocked: the whole point is that failures in this system are real failures,
// captured as real neatlogs traces.
//
// Every run is traced to ingest.neatlogs.com/v1/trace via the documented
// HTTP contract (nested JSON, one POST per completed run).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postTrace, recordRun } from '../neatlogs.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME = join(ROOT, 'runtime');
if (!existsSync(RUNTIME)) mkdirSync(RUNTIME, { recursive: true });

// ---------------------------------------------------------------------------
// REAL tools. Each does genuine work; each can genuinely fail.
// ---------------------------------------------------------------------------

/** Fetches live exchange rates from a real public API. */
async function getExchangeRate({ base = 'USD', quote = 'EUR' } = {}) {
  if (typeof base !== 'string' || typeof quote !== 'string') {
    throw new ToolError('get_exchange_rate requires string params base and quote');
  }
  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new ToolError(`exchange API returned HTTP ${res.status}`);
  const data = await res.json();
  const rate = data?.rates?.[quote];
  if (typeof rate !== 'number') throw new ToolError(`no rate for ${base}->${quote}`);
  return { base, quote, rate, fetchedAt: new Date().toISOString() };
}

/** Real file persistence with schema validation — malformed writes fail. */
function saveRecord({ name, payload } = {}) {
  if (!name || typeof name !== 'string' || /[^a-z0-9_-]/i.test(name)) {
    throw new ToolError('save_record: name must be alphanumeric/underscore');
  }
  if (!payload || typeof payload !== 'object') {
    throw new ToolError('save_record: payload must be an object');
  }
  const file = join(RUNTIME, `record-${name}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return { saved: file, bytes: JSON.stringify(payload).length };
}

/** Reads back what save_record wrote — wrong names fail. */
function readRecord({ name } = {}) {
  if (!name || typeof name !== 'string') {
    throw new ToolError('read_record requires a string name');
  }
  const file = join(RUNTIME, `record-${name}.json`);
  if (!existsSync(file)) throw new ToolError(`read_record: no record named '${name}'`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Real date arithmetic — invalid input genuinely fails. */
function computeSchedule({ startDate, days } = {}) {
  if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new ToolError('compute_schedule: startDate must be YYYY-MM-DD');
  }
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new ToolError('compute_schedule: days must be an integer 1-365');
  }
  const d = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new ToolError('compute_schedule: invalid date');
  d.setUTCDate(d.getUTCDate() + days);
  return { startDate, days, endDate: d.toISOString().slice(0, 10) };
}

class ToolError extends Error {
  constructor(msg) { super(msg); this.name = 'ToolError'; this.isToolError = true; }
}

// The agent's real tool registry. The Breaker's job is to make the agent
// MISUSE these: wrong tool, malformed arguments, missing params.
const TOOLS = {
  get_exchange_rate: getExchangeRate,
  save_record: saveRecord,
  read_record: readRecord,
  compute_schedule: computeSchedule,
};

const TOOL_SCHEMAS = {
  get_exchange_rate: {
    description: 'Fetch a live exchange rate from a public API',
    params: { base: 'string currency code', quote: 'string currency code' },
    required: ['base', 'quote'],
  },
  save_record: {
    description: 'Persist a JSON record to the runtime directory',
    params: { name: 'alphanumeric record name', payload: 'object' },
    required: ['name', 'payload'],
  },
  read_record: {
    description: 'Read back a previously saved record',
    params: { name: 'record name' },
    required: ['name'],
  },
  compute_schedule: {
    description: 'Add N days to a date, ISO output',
    params: { startDate: 'YYYY-MM-DD', days: 'integer 1-365' },
    required: ['startDate', 'days'],
  },
};

// ---------------------------------------------------------------------------
// The agent loop. Simple, deterministic, genuinely fallible.
// ---------------------------------------------------------------------------

/**
 * Execute a task: an ordered list of tool calls the agent performs.
 * The current "brain" is a thin rule-based router over the task spec.
 * The Breaker corrupts the spec (or the router) and watches the run fail.
 */
async function runTask(task) {
  const t0 = Date.now();
  const traceChildren = [];
  const spans = [];
  let ok = true;
  const results = [];

  for (const step of task.steps || []) {
    const s0 = Date.now();
    const child = {
      name: `tool:${step.tool}`,
      kind: 'TOOL',
      tool_name: step.tool,
      input: step.args,
    };
    try {
      const fn = TOOLS[step.tool];
      if (!fn) throw new ToolError(`unknown tool '${step.tool}'`);
      const out = await fn(step.args);
      child.output = out;
      child.status = 'OK';
      results.push({ step: step.tool, ok: true, out });
    } catch (e) {
      child.status = 'ERROR';
      child.error = e.message;
      ok = false;
      results.push({ step: step.tool, ok: false, error: e.message });
    }
    child.duration_ms = Date.now() - s0;
    traceChildren.push(child);
    spans.push(child);
  }

  // 1. Live monitoring: the neatlogs trace (root becomes WORKFLOW, children TOOL).
  const trace = {
    name: task.name || 'target-run',
    project: 'tracezeta',
    children: traceChildren,
  };
  const t = await postTrace(trace);

  // 2. Deep evidence: the run record, linked by traceId.
  const run = {
    name: task.name || 'target-run',
    at: new Date().toISOString(),
    ok,
    trace: t.ok ? { traceId: t.traceId, spans: t.spans } : { error: t.error },
    task,
    spans,
  };
  const runFile = recordRun(run);

  return {
    ok,
    results,
    traceId: t.ok ? t.traceId : null,
    traceError: t.ok ? null : t.error,
    runFile,
    durationMs: Date.now() - t0,
  };
}

export { runTask, TOOLS, TOOL_SCHEMAS, ToolError };

// Direct execution: node src/target/index.js <taskfile.json>
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const taskFile = process.argv[2];
  if (!taskFile) {
    console.error('usage: node src/target/index.js <task.json>');
    process.exit(2);
  }
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));
  const result = await runTask(task);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
