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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
  // search both live runs/ and the archive (historical incidents reference
  // archived run records; their evidence is still valid)
  for (const dir of [join(ROOT, 'runs'), join(ROOT, 'archive', 'pre-b2b-reset')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        if (readJson(join(dir, f))?.trace?.traceId === traceId) return join(dir, f);
      } catch { /* skip */ }
    }
  }
  return null;
}

// --- Entire checkpoint integration -----------------------------------------
// Entire checkpoints are captured by: (agent session makes a real change) +
// (git commit). We proved this path works with the first checkpoint
// (01M4MQF7PK22KAERTY8FMJGNSQ: agy session -> package.json change -> commit).
// The Fixer's pre-fix anchor: run a real agy session that stages the repair
// description into the repo (a real file, a real session), then commit it —
// the checkpoint is the rollback anchor before the fix is applied.
// If agy or git is unavailable, the fix records checkpoint: null with the
// reason — honest, never faked.
function entireCheckpoint(label, incidentId, planSummary = '') {
  try {
    // 1. Real agent session: agy writes the repair plan file into the repo
    // (a real file, a real session). The plan content is the ACTUAL repair
    // plan (root causes + strategies), not a marker line.
    const planFile = join(ROOT, 'fixes', `${incidentId}-repair-plan.md`);
    const content = [
      `# Repair plan for ${incidentId}: ${label}`,
      '',
      planSummary || '(no repair strategy recorded)',
      '',
    ].join('\n');
    const prompt = `Create the file ${planFile} with exactly this content and nothing else:\n${content}`;
    execFileSync('agy', ['-p', prompt], {
      cwd: ROOT, timeout: 120000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 2. Commit it: the checkpoint anchor is born (session + commit)
    execFileSync('git', ['add', planFile], { cwd: ROOT, encoding: 'utf8' });
    execFileSync('git', ['commit', '-m', `Entire pre-fix anchor: ${label} (${incidentId})`], { cwd: ROOT, encoding: 'utf8' });
    // 3. Read the checkpoint this just created
    const out = execFileSync('entire', ['checkpoint', 'list'], {
      cwd: ROOT, timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ENTIRE_TOKEN_STORE: 'file', PATH: process.env.PATH },
    });
    const m = out.match(/●\s+([0-9A-Z]{20,})/);
    return { ok: true, id: m ? m[1] : null, raw: out.slice(0, 300) };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 200) };
  }
}

// --- helpers ---------------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidDomain(v) {
  return typeof v === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v);
}

// --- Fix strategies, keyed by root cause -----------------------------------

const STRATEGIES = {
  'external-service-failure': {
    // A network timeout / 5xx / rate limit is neither a code defect nor a
    // task defect. The honest repair is RETRY: re-run the same call unchanged
    // and resolve only if the re-run passes. Never rewrite the task around an
    // outage, never invent a substitute result.
    describe: 'Retry the call unchanged; external failures resolve by re-run, not by rewriting the task',
    repairStep: (step) => ({
      args: { ...(step.args || {}) },
      fixes: ['external service failure (network/timeout/HTTP): task and code are correct; retried unchanged — resolves only if the re-run passes'],
      actionable: true,
      remove: false,
    }),
  },
  'entity-not-found': {
    describe: 'Remove steps referencing entities the data source has no record of',
    repairStep: (step) => {
      // The entity genuinely does not exist in the external data. Inventing a
      // name would be fabrication. The honest repair: remove the step.
      const fixes = [`step references an entity with no match in the data source; step removed (no entity invented)`];
      return { args: { ...(step.args || {}) }, fixes, actionable: true, remove: true };
    },
  },
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
          if (looksIso) {
            // clamp month to 1-12, day to the month's end (derivable)
            const [y, m, d] = raw.split('-').map(Number);
            const mm = Math.min(12, Math.max(1, m));
            const dim = new Date(Date.UTC(y, mm, 0)).getUTCDate();
            const dd = Math.min(dim, Math.max(1, d));
            const valid = `${String(y).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
            fixes.push(`startDate '${raw}' -> '${valid}' (clamp to valid YYYY-MM-DD)`);
            args.startDate = valid;
          } else {
            // a non-ISO date is ambiguous ('11/10/2026' is day-first or
            // month-first) — no date is derivable, so never invent one
            fixes.push(`startDate ${JSON.stringify(raw)}: not derivable; step removed (no date invented)`);
            removed = true;
          }
        }
        if (!Number.isInteger(args.days) || args.days < 1 || args.days > 365) {
          const parsed = Number.parseInt(args.days, 10);
          if (Number.isInteger(parsed) && parsed >= 1) {
            const valid = Math.min(365, parsed);
            fixes.push(`days '${args.days}' -> ${valid} (clamp to integer 1-365)`);
            args.days = valid;
          } else {
            fixes.push(`days ${JSON.stringify(args.days)}: not derivable; step removed (no duration invented)`);
            removed = true;
          }
        }
      }
      if (tool === 'save_record') {
        if (typeof args.name === 'string' && /[^a-z0-9_-]/i.test(args.name)) {
          const valid = args.name.replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'record';
          fixes.push(`name '${args.name}' -> '${valid}' (sanitize to allowed charset)`);
          args.name = valid;
        }
        if (!args.payload || typeof args.payload !== 'object') {
          // no payload content is derivable from evidence; a placeholder
          // record would be invented data. Remove the step instead.
          fixes.push('payload missing/not object: step removed (no placeholder invented)');
          removed = true;
        }
      }
      // --- B2B (Crustdata) tools: query / domain / limit / text repair rules ---
      // A missing/invalid search term cannot be derived from evidence; the
      // honest repair is REMOVAL (a step the agent cannot justify), never an
      // invented term or an empty retry.
      if (['company_search', 'person_search', 'web_search'].includes(tool) && !isNonEmptyString(args.query)) {
        fixes.push(`query ${JSON.stringify(args.query)}: no valid search term derivable; step removed (no term invented)`);
        removed = true;
      }
      if (tool === 'job_search' && !isNonEmptyString(args.title)) {
        fixes.push('title: no valid search term derivable; step removed (no term invented)');
        removed = true;
      }
      if (tool === 'social_post_search' && !isNonEmptyString(args.text)) {
        fixes.push('text: no valid search term derivable; step removed (no term invented)');
        removed = true;
      }
      if (tool === 'company_enrich' && !isValidDomain(args.domain)) {
        if (typeof args.domain === 'string' && args.domain.includes('.')) {
          // sanitize spaces/punctuation, keep the domain shape
          const valid = args.domain.toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/\.+/g, '.');
          if (isValidDomain(valid)) {
            fixes.push(`domain '${args.domain}' -> '${valid}' (sanitize to domain charset)`);
            args.domain = valid;
          } else {
            fixes.push(`domain '${args.domain}': not recoverable; step removed`);
            removed = true;
          }
        } else {
          fixes.push(`domain ${JSON.stringify(args.domain)}: no domain shape; step removed`);
          removed = true;
        }
      }
      // company_enrich 'no match for domain' (shape-valid domain, zero matches):
      // the domain resolves to no real company. Not repairable from evidence —
      // the step references an entity that does not exist. Remove it.
      if (tool === 'company_enrich' && isValidDomain(args.domain) && typeof spanError === 'string' && spanError.includes('no match for domain')) {
        fixes.push(`domain '${args.domain}': shape-valid but no company exists for it; step removed (no domain invented)`);
        removed = true;
      }
      // limit clamping applies to every B2B tool with a limit
      if (['company_search', 'person_search', 'job_search', 'social_post_search'].includes(tool)
          && args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 25)) {
        const parsed = Number.parseInt(args.limit, 10);
        if (Number.isInteger(parsed) && parsed >= 1) {
          const valid = Math.min(25, parsed);
          fixes.push(`limit '${args.limit}' -> ${valid} (clamp to integer 1-25)`);
          args.limit = valid;
        } else {
          fixes.push(`limit ${JSON.stringify(args.limit)}: not derivable; step removed (no limit invented)`);
          removed = true;
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
    describe: 'Remove the step whose required parameters cannot be derived',
    repairStep: (step, spanError) => {
      const args = { ...(step.args || {}) };
      const fixes = [];
      // Only ever add params we can derive from the evidence; never guess.
      // A missing required param cannot be derived from an error message, so
      // the honest repair is to remove the step (same class as an un-derivable
      // query) — never a placeholder value, never an advisory that re-runs a
      // task guaranteed to fail again.
      const m = typeof spanError === 'string'
        ? spanError.match(/requires(?: string)? params? ([a-z]+)/i) : null;
      const missing = m ? m[1] : 'unknown';
      fixes.push(`param '${missing}' missing — not derivable from evidence; step removed (no value invented)`);
      return { args, fixes, actionable: true, remove: true };
    },
  },
};

// exported for the test suite: the no-invention contract is asserted directly
export { STRATEGIES };

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
    // Span names arrive bare (projection) or 'tool:'-prefixed (run records);
    // normalize to the step's tool name. A tool can appear MULTIPLE times in
    // a task (e.g. two company_enrich steps) and each failing INSTANCE gets
    // its own repair — track counts, not just presence.
    const failingToolCounts = new Map();
    for (const s of rc.spans || []) {
      const t = s.replace(/^tool:/, '');
      failingToolCounts.set(t, (failingToolCounts.get(t) || 0) + 1);
    }
    for (const step of run.task?.steps || []) {
      if (!failingToolCounts.has(step.tool)) continue;
      // only repair as many instances of this tool as the diagnosis cited
      const cited = failingToolCounts.get(step.tool);
      const repairedSoFar = (failingToolCounts.get(`__done_${step.tool}`) || 0);
      if (repairedSoFar >= cited) continue;
      // find THIS step's own span error: match by tool AND (when multiple
      // instances exist) by argument identity so the right step gets the
      // right error text (e.g. 'not a domain!!' vs 'no match for domain')
      const stepJson = JSON.stringify(step.args);
      const ownSpan = (run.spans || []).find((s) => (s.name === `tool:${step.tool}` || s.name === step.tool)
        && (JSON.stringify(s.input) === stepJson || (s.input && step.args && Object.keys(step.args).length === 0 && Object.keys(s.input || {}).length === 0)));
      const anySpan = (run.spans || []).find((s) => s.name === `tool:${step.tool}` || s.name === step.tool);
      // only a FAILING instance may be repaired: either its own span errored
      // (identity match) or the tool ran exactly once and that span errored.
      // Without this gate a healthy instance can consume the repair budget or
      // receive the failing instance's repair.
      const instanceCount = (run.task?.steps || []).filter((s) => s.tool === step.tool).length;
      const isFailingInstance = !!(ownSpan?.error) || (instanceCount === 1 && !!anySpan?.error);
      if (!isFailingInstance) continue;
      const spanError = ownSpan?.error ?? anySpan?.error;
      const r = strategy.repairStep(step, spanError, TOOL_SCHEMAS);
      if (r.fixes.length) {
        // the repair budget counts REPAIRS MADE, not steps visited — a healthy
        // or unrepairable instance must never consume another instance's slot
        failingToolCounts.set(`__done_${step.tool}`, repairedSoFar + 1);
        const repair = { tool: step.tool, original: step.args, repaired: r.args, notes: r.fixes, actionable: r.actionable, remove: r.remove === true };
        if (r.tool && r.tool !== step.tool) repair.replaceToolWith = r.tool; // wrong-tool fix
        repairs.push(repair);
      }
    }
  }

  if (!repairs.length) return { proposed: false, reason: 'no repair strategy matched the failing steps' };

  // Entire checkpoint BEFORE the fix (rollback anchor)
  const planSummary = [
    `Root causes: ${diagnosis.rootCauses.map((r) => r.id).join(', ')}`,
    ...repairs.map((r) => `- ${r.tool}: ${r.remove ? 'step removed' : (r.notes || []).join('; ') || 'args repaired'}`),
  ].join('\n');
  const checkpoint = entireCheckpoint(`tracezeta-pre-fix-${incident.id}`, incident.id, planSummary);

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
