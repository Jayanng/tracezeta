// TraceZeta source repair: stage 3 — the hardened code-defect classifier.
//
// A failing step is classified as a CODE defect only when it survives THREE
// tests (heuristic alone was too weak — it flagged valid-input failures):
//   1. SHAPE: the failing args satisfy the tool's documented parameter
//      schema (right keys, right types) — the caller did its part.
//   2. ISOLATION: the same tool did NOT succeed elsewhere in the same run
//      with different args (a tool that succeeds sometimes has working code).
//   3. REPRODUCTION: a minimal live re-probe of the SAME step against the
//      CURRENT code reproduces the SAME error signature. A flaky or
//      environment-dependent failure is not a code defect we can gate.
//
// Anything that fails any test is routed back to the task-spec strategies.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const SCHEMA_FILE = join(ROOT, 'src', 'crustdata.js'); // CRUST_SCHEMAS import target

function toolSchemas() {
  // CRUST_SCHEMAS from crustdata.js + TOOL_SCHEMAS from target
  const schemas = {};
  const probe = join(ROOT, 'runtime', 'schema-probe.mjs');
  if (!existsSync(join(ROOT, 'runtime'))) { mkdirSync(join(ROOT, 'runtime'), { recursive: true }); }
  // ESM-safe: write a tiny probe that dumps the schemas as JSON
  writeFileSync(probe, `
import { CRUST_SCHEMAS } from '${SCHEMA_FILE.replace(/\\/g, '/')}';
import { TOOL_SCHEMAS } from '${join(ROOT, 'src/target/index.js').replace(/\\/g, '/')}';
console.log(JSON.stringify({ ...CRUST_SCHEMAS, ...TOOL_SCHEMAS }));
`);
  try {
    const out = execFileSync('node', [probe], { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(out.trim().split('\n').pop());
  } catch {
    return {};
  }
}

/**
 * Classify failing steps from a run record.
 * Returns [{ tool, step, error, confidence, reasons }] for CODE defects only.
 */
export function classifyCodeDefects(runRecord) {
  if (!runRecord) return [];
  const schemas = toolSchemas();
  const spans = runRecord.spans || [];
  const failing = spans.filter((s) => s.status === 'ERROR');
  const passingTools = new Set(spans.filter((s) => s.status === 'OK').map((s) => s.name.replace(/^tool:/, '')));
  const out = [];
  for (const s of failing) {
    const tool = s.name.replace(/^tool:/, '');
    const step = (runRecord.task?.steps || []).find((st) => st.tool === tool && JSON.stringify(st.args) === JSON.stringify(s.input));
    if (!step) continue;
    const schema = schemas[tool];
    const reasons = [];

    // TEST 1: shape — required params present, types plausible
    let shapeOk = true;
    if (schema) {
      for (const req of schema.required || []) {
        if (step.args?.[req] === undefined || step.args?.[req] === null) { shapeOk = false; reasons.push(`missing required param '${req}'`); }
      }
      for (const [k, v] of Object.entries(step.args || {})) {
        const desc = schema.params?.[k] || '';
        if (/^string|domain|YYYY/i.test(desc) && typeof v !== 'string') { shapeOk = false; reasons.push(`param '${k}' should be string-like`); }
        if (/^integer/i.test(desc) && !Number.isInteger(v)) { shapeOk = false; reasons.push(`param '${k}' should be integer`); }
      }
    } else {
      shapeOk = false;
      reasons.push('no schema registered for tool');
    }
    if (!shapeOk) continue; // caller's fault, not code

    // TEST 2: isolation — tool never succeeded in this run
    if (passingTools.has(tool)) continue; // works elsewhere -> input issue

    // TEST 3: reproduction is checked LATER (async, live probe) — see below
    out.push({ tool, step, error: s.error, confidence: 0.75, reasons: [...reasons, 'args schema-valid; tool never succeeded in run'], reproduce: true });
  }
  return out;
}

/** Async reproduction probe: re-run the step; classify only if the error repeats. */
export async function withReproduction(candidates, runStep) {
  const confirmed = [];
  for (const c of candidates) {
    const again = await runStep(c.step);
    const sameSignature = again.status === 'ERROR' && String(again.error || '').slice(0, 40) === String(c.error || '').slice(0, 40);
    if (sameSignature) {
      confirmed.push({ ...c, reproduced: true, probeError: again.error });
    }
    // different error or success on re-probe => flaky/env, not a stable code defect
  }
  return confirmed;
}
