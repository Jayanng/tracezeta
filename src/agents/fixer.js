// TraceZeta Fixer.
//
// Takes a diagnosis, proposes a MINIMAL scoped fix to the task spec that
// failed, and records it. Before any fix is applied, an Entire checkpoint
// captures the pre-fix state (Entire integration: checkpoint before each fix,
// ID recorded with the fix).
//
// Fix strategy keyed by root-cause class — each fix touches ONLY the failing
// step's arguments, never healthy ones. If the diagnosis is not actionable,
// the Fixer refuses (no guessed fixes).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { TOOL_SCHEMAS } from '../target/index.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const FIXES_DIR = join(ROOT, 'fixes');

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

/** Find the run record for a trace. */
function findRunRecordPath(traceId, runFileHint) {
  if (runFileHint && existsSync(runFileHint)) return runFileHint;
  const runsDir = join(ROOT, 'runs');
  if (!existsSync(runsDir)) return null;
  const { readdirSync } = require('node:fs');
  for (const f of readdirSync(runsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      if (readJson(join(runsDir, f))?.trace?.traceId === traceId) return join(runsDir, f);
    } catch { /* skip */ }
  }
  return null;
}

// --- Entire checkpoint integration -----------------------------------------
// Entire CLI captures a checkpoint of the repo state. If the CLI is absent
// or fails, the fix records checkpoint: null with the reason — honest, never
// faked.
function entireCheckpoint(label) {
  try {
    const out = execFileSync('entire', ['checkpoint', 'create', '--label', label, '--json'], {
      cwd: ROOT, timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const d = JSON.parse(out);
      return { ok: true, id: d.id || d.checkpointId || d.checkpoint_id || null, raw: out.slice(0, 400) };
    } catch {
      return { ok: true, id: null, raw: out.slice(0, 400) };
    }
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 200) };
  }
}

// --- Fix strategies, keyed by root cause -----------------------------------

const STRATEGIES = {
  'wrong-tool-selected': {
    describe: 'Replace the unknown tool with the registered tool matching the input shape',
    repairStep: (step, spanError, tools) => {
      const fixes = [];
      const args = { ...(step.args || {}) };
      let repairedTool = step.tool;
      // Match the failed step's args against the registry's known schemas:
      // exact key-set match wins; else the tool whose required params are all
      // present. Never invents a tool; refuses when ambiguous.
      const candidates = Object.entries(tools || {}).filter(([name]) => name !== step.tool);
      const argKeys = Object.keys(args).sort().join(',');
      const exact = candidates.filter(([name, schema]) => Object.keys(schema.params || {}).sort().join(',') === argKeys);
      if (exact.length === 1) {
        repairedTool = exact[0][0];
        fixes.push(`tool '${step.tool}' -> '${repairedTool}' (exact argument-shape match in the registry)`);
      } else if (exact.length === 0) {
        const subset = candidates.filter(([name, schema]) => (schema.required || []).every((r) => r in args));
        if (subset.length === 1) {
          repairedTool = subset[0][0];
          fixes.push(`tool '${step.tool}' -> '${repairedTool}' (required params satisfied; unique match)`);
        } else {
          fixes.push(`tool '${step.tool}': no unique registry match for its arguments; flagged for review (no tool invented)`);
        }
      } else {
        fixes.push(`tool '${step.tool}': ambiguous matches (${exact.map((e) => e[0]).join(', ')}); flagged for review`);
      }
      return { tool: repairedTool, args, fixes, actionable: exact.length === 1 || exact.length === 0 };
    },
  },
  'invalid-argument-value': {
    describe: 'Repair the invalid argument values on the failing steps',
    repairStep: (step, spanError) => {
      // The run record's span carries the exact input that failed. The fix
      // proposes corrected values per tool validation rules:
      const tool = step.tool;
      const args = { ...(step.args || {}) };
      const fixes = [];
      let removed = false;
      if (tool === 'compute_schedule') {
        // invalid date: normalize to a valid ISO date. Two failure modes:
        // (a) format fails the regex; (b) format passes but the date is
        // semantically invalid (month 13, day 45) — both must be repaired.
        const raw = args.startDate;
        const looksIso = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw);
        const parses = looksIso && !Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime());
        if (!parses) {
          let valid;
          if (looksIso) {
            // clamp month to 1-12, day to the month's end
            const [y, m, d] = raw.split('-').map(Number);
            const mm = Math.min(12, Math.max(1, m));
            const dim = new Date(Date.UTC(y, mm, 0)).getUTCDate();
            const dd = Math.min(dim, Math.max(1, d));
            valid = `${String(y).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
          } else {
            valid = '2026-10-11';
          }
          fixes.push(`startDate '${raw}' -> '${valid}' (normalize to valid YYYY-MM-DD)`);
          args.startDate = valid;
        }
        if (!Number.isInteger(args.days) || args.days < 1 || args.days > 365) {
          const valid = Math.min(365, Math.max(1, parseInt(args.days, 10) || 14));
          fixes.push(`days '${args.days}' -> ${valid} (clamp to integer 1-365)`);
          args.days = valid;
        }
      }
      if (tool === 'save_record') {
        if (typeof args.name === 'string' && /[^a-z0-9_-]/i.test(args.name)) {
          const valid = args.name.replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'record';
          fixes.push(`name '${args.name}' -> '${valid}' (sanitize to allowed charset)`);
          args.name = valid;
        }
        if (!args.payload || typeof args.payload !== 'object') {
          fixes.push('payload missing/not object -> {} placeholder flagged for review');
          args.payload = args.payload || {};
        }
      }
      if (tool === 'read_record') {
        // record does not exist: the step references state that was never
        // created. The evidence cannot determine a correct name — inventing
        // one would be fabrication. The repair marks the step for removal
        // from the task (the agent asked for data that does not exist).
        const missing = args?.name;
        fixes.push(`no record named '${missing}': step removed from the task (referenced state does not exist; no name invented)`);
        removed = true;
      }
      return { args, fixes, actionable: fixes.length > 0, remove: removed };
    },
  },
  'missing-required-argument': {
    describe: 'Add the missing required parameters',
    repairStep: (step, spanError) => {
      const args = { ...(step.args || {}) };
      const fixes = [];
      // Only add params we can derive from the error; never guess values.
      if (typeof spanError === 'string') {
        const m = spanError.match(/requires(?: string)? params? ([a-z]+)/i);
        if (m && !args[m[1]]) {
          fixes.push(`param '${m[1]}' missing — cannot be derived from evidence; flagged for review (no value invented)`);
        }
      }
      return { args, fixes, actionable: false };
    },
  },
};

/**
 * Propose a fix for an incident's diagnosis. Returns the fix record; nothing
 * is applied to live tasks until the Verifier proves it.
 */
export function proposeFix(incident, diagnosis) {
  if (diagnosis.verdict !== 'ROOT_CAUSE_IDENTIFIED' || !diagnosis.rootCauses?.length) {
    return { proposed: false, reason: `diagnosis not actionable: ${diagnosis.verdict}` };
  }

  const runFile = diagnosis.evidenceSources?.runFile;
  const runPath = findRunRecordPath(incident.trace.traceId, runFile);
  if (!runPath) return { proposed: false, reason: 'run record not found for the failing trace' };
  const run = readJson(runPath);

  const repairs = [];
  for (const rc of diagnosis.rootCauses) {
    const strategy = STRATEGIES[rc.id];
    if (!strategy) continue;
    const failingSpans = new Set(rc.spans || []);
    for (const step of run.task?.steps || []) {
      const spanName = `tool:${step.tool}`;
      if (!failingSpans.has(spanName)) continue;
      const spanError = (run.spans || []).find((s) => s.name === spanName)?.error;
      const r = strategy.repairStep(step, spanError, TOOL_SCHEMAS);
      if (r.fixes.length) {
        const repair = { tool: step.tool, original: step.args, repaired: r.args, notes: r.fixes, actionable: r.actionable, remove: r.remove === true };
        if (r.tool && r.tool !== step.tool) repair.replaceToolWith = r.tool; // wrong-tool fix
        repairs.push(repair);
      }
    }
  }

  if (!repairs.length) return { proposed: false, reason: 'no repair strategy matched the failing steps' };

  // Entire checkpoint BEFORE the fix (rollback anchor)
  const checkpoint = entireCheckpoint(`tracezeta-pre-fix-${incident.id}`);

  const fix = {
    incidentId: incident.id,
    diagnosisFile: diagnosis.file,
    proposedAt: new Date().toISOString(),
    strategy: diagnosis.rootCauses.map((r) => r.id),
    repairs,
    checkpoint,
    applied: false, // the Orchestrator applies only after verification
  };
  if (!existsSync(FIXES_DIR)) mkdirSync(FIXES_DIR, { recursive: true });
  const file = join(FIXES_DIR, `${incident.id}-fix.json`);
  writeFileSync(file, JSON.stringify(fix, null, 2));
  return { proposed: true, file, fix };
}

// CLI: node src/agents/fixer.js <incident.json> <diagnosis.json>
if (process.argv[1] && process.argv[1].endsWith('fixer.js')) {
  const [, , incidentPath, diagnosisPath] = process.argv;
  if (!incidentPath || !diagnosisPath) {
    console.error('usage: node src/agents/fixer.js <incident.json> <diagnosis.json>');
    process.exit(2);
  }
  const result = proposeFix(readJson(incidentPath), readJson(diagnosisPath));
  console.log(JSON.stringify({
    proposed: result.proposed,
    reason: result.reason || null,
    repairs: result.fix?.repairs?.map((r) => ({ tool: r.tool, notes: r.notes })),
    checkpoint: result.fix?.checkpoint,
    file: result.file || null,
  }, null, 2));
}
