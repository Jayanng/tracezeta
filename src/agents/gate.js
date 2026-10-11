// TraceZeta source repair: stage 2 — the anti-reward-hacking gate.
//
// THE GATE: a source patch is accepted ONLY if it satisfies ALL of:
//   1. REPRODUCTION: the original failure reproduces on the ORIGINAL code
//      (git stash the patch, re-run the failing step, must fail again).
//      If it does NOT reproduce, there was no code defect — refuse.
//   2. RECOVERY: the failing step now passes with the patch applied.
//   3. ERROR-PRESERVATION (the anti-reward-hacking rule): inputs that are
//      KNOWN-BAD must STILL FAIL after the patch. A patch that makes bad
//      inputs pass (try/catch swallowing, default returns, loosened
//      validation) is rejected outright — it silenced the judge, not fixed
//      the code.
//   4. NO-REGRESSION: healthy steps still pass with the patch applied.
//   5. BOUNDED DIFF: the patch touches only the target file and stays under
//      a line budget; a rewrite is not a fix.
//
// The gate runs OUTSIDE the sandbox, as the owner, against a live target.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts });
}

/**
 * Run ONE tool step against the CURRENT code (no patch state changes).
 * Returns { status: 'OK' | 'ERROR', error }.
 */
async function runStep(step) {
  // dynamic import busts the module cache only per process; we run a fresh
  // node process so patched code is actually loaded
  const probeFile = join(ROOT, 'runtime', 'gate-probe.mjs');
  if (!existsSync(join(ROOT, 'runtime'))) mkdirSync(join(ROOT, 'runtime'), { recursive: true });
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
    const out = sh('node', [probeFile], { timeout: 90000 });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (e) {
    return { status: 'ERROR', error: String(e.message || e).slice(0, 200) };
  }
}

/**
 * The full gate. Parameters:
 *   targetFile — the single file the patch may touch
 *   failingStep — { tool, args } that SHOULD have failed (the defect)
 *   knownBadSteps — [{ tool, args }] that MUST fail before AND after
 *   healthySteps — [{ tool, args }] that must pass before AND after
 * The current on-disk state is treated as PATCHED; the gate stashes to
 * test the ORIGINAL.
 */
export async function runGate({ targetFile, failingStep, knownBadSteps = [], healthySteps = [], maxChangedLines = 40 }) {
  const record = { checks: {}, accepted: false };

  // 0. BOUNDED DIFF: only the target file changed, under the line budget
  let diffStat = '';
  try {
    diffStat = sh('git', ['diff', '--numstat', targetFile]);
  } catch { /* no git diff available */ }
  if (diffStat.trim()) {
    const [add, del] = diffStat.trim().split('\t').map(Number);
    const changed = (add || 0) + (del || 0);
    record.checks.boundedDiff = { changed, max: maxChangedLines, pass: changed <= maxChangedLines };
    if (changed > maxChangedLines) {
      record.rejection = `patch too large: ${changed} lines changed (max ${maxChangedLines}) — a rewrite is not a fix`;
      return record;
    }
  }
  // normalize both to repo-relative paths for comparison
  const rel = (p) => p.replace(ROOT + '/', '').replace(/\\/g, '/');
  const otherChanges = sh('git', ['diff', '--name-only']).trim().split('\n').filter((f) => f && rel(f) !== rel(targetFile));
  record.checks.onlyTargetFile = { others: otherChanges, pass: otherChanges.length === 0 };
  if (otherChanges.length) {
    record.rejection = `patch touches other files: ${otherChanges.join(', ')}`;
    return record;
  }

  // 1. REPRODUCTION on ORIGINAL code (stash the patch, run, restore)
  sh('git', ['stash', 'push', '--', targetFile]);
  let repro;
  try {
    repro = await runStep(failingStep);
  } finally {
    // restore the patch no matter what
    try { sh('git', ['stash', 'pop']); } catch { /* stash may be empty if no diff */ }
  }
  record.checks.reproduction = { status: repro.status, pass: repro.status === 'ERROR' };
  if (repro.status !== 'ERROR') {
    record.rejection = 'failure does not reproduce on original code — no code defect to fix (refused)';
    return record;
  }

  // 2/3/4. With the PATCH (current disk state): failing fixed, bad still bad,
  //        healthy still healthy
  const fixed = await runStep(failingStep);
  record.checks.recovery = { status: fixed.status, pass: fixed.status === 'OK' };
  if (fixed.status !== 'OK') {
    record.rejection = `failing step still fails after patch: ${fixed.error || ''}`;
    return record;
  }

  const badResults = [];
  for (const s of knownBadSteps) {
    const before = (await withStashedPatch(() => runStep(s)));
    const after = await runStep(s);
    badResults.push({ step: s, before: before.status, after: after.status });
  }
  // each known-bad input must fail BEFORE and AFTER the patch
  const silenced = badResults.filter((r) => r.before === 'ERROR' && r.after === 'OK');
  const wasAlreadyPassing = badResults.filter((r) => r.before === 'OK');
  record.checks.errorPreservation = {
    results: badResults,
    silenced,
    wasAlreadyPassing,
    pass: silenced.length === 0 && wasAlreadyPassing.length === 0,
  };
  if (silenced.length) {
    record.rejection = `REWARD HACKING BLOCKED: patch makes known-bad inputs pass (${silenced.map((s) => s.step.tool).join(', ')}) — errors were silenced, not fixed`;
    return record;
  }
  if (wasAlreadyPassing.length) {
    record.rejection = `a "known-bad" input passed even BEFORE the patch — the test oracle itself is wrong (${wasAlreadyPassing.map((s) => s.step.tool).join(', ')})`;
    return record;
  }

  const healthyResults = [];
  for (const s of healthySteps) {
    const r = await runStep(s);
    healthyResults.push({ step: s, status: r.status });
  }
  record.checks.noRegression = { results: healthyResults, pass: healthyResults.every((r) => r.status === 'OK') };
  if (!record.checks.noRegression.pass) {
    record.rejection = 'healthy steps regressed after patch';
    return record;
  }

  record.accepted = true;
  record.verdict = 'SOURCE_FIX_VERIFIED';
  return record;
}

/** Run fn with the patch temporarily stashed (original code on disk). */
async function withStashedPatch(fn) {
  sh('git', ['stash', 'push']);
  try {
    return await fn();
  } finally {
    try { sh('git', ['stash', 'pop']); } catch { /* nothing stashed */ }
  }
}

/** Save the gate record + the proposed diff for human review. */
export function recordProposal(incidentId, gateRecord, targetFile) {
  const dir = join(ROOT, 'fixes', 'source-repairs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let diff = '';
  try { diff = sh('git', ['diff', targetFile]); } catch { /* no diff */ }
  const proposal = {
    incidentId,
    at: new Date().toISOString(),
    gate: gateRecord,
    targetFile,
    proposedDiff: diff,
    status: gateRecord.accepted ? 'AWAITING_HUMAN_REVIEW' : 'REJECTED_BY_GATE',
  };
  const file = join(dir, `${incidentId}-source-proposal.json`);
  writeFileSync(file, JSON.stringify(proposal, null, 2));
  return { file, proposal };
}
