// Smoke tests over the offline-testable core: the anti-fabrication contract
// of the Fixer, the target's validation rules, and the diff counter.
// Run: npm test  (node --test test/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { TOOLS, ToolError } from '../src/target/index.js';
import { STRATEGIES } from '../src/agents/fixer.js';
import { diffVsSnapshot } from '../src/agents/sandbox.js';

// --- target validation -----------------------------------------------------

test('compute_schedule accepts a real calendar date and computes the end', () => {
  const r = TOOLS.compute_schedule({ startDate: '2026-10-11', days: 3 });
  assert.equal(r.endDate, '2026-10-14');
});

test('compute_schedule REJECTS rolled-over calendar dates (2026-02-31)', () => {
  // JS Date silently rolls Feb 31 to March 3; the tool must not accept it
  assert.throws(() => TOOLS.compute_schedule({ startDate: '2026-02-31', days: 3 }), ToolError);
});

test('read_record rejects traversal names (the save_record guard, on read)', () => {
  assert.throws(() => TOOLS.read_record({ name: '../../../home/ubuntu/.config/neatlogs/credentials' }), ToolError);
  assert.throws(() => TOOLS.read_record({ name: 'bad/name' }), ToolError);
});

test('save_record rejects names outside the allowed charset', () => {
  assert.throws(() => TOOLS.save_record({ name: '../escape', payload: { a: 1 } }), ToolError);
});

// --- the no-invention contract --------------------------------------------

test('fixer NEVER invents a date: ambiguous startDate removes the step', () => {
  const r = STRATEGIES['invalid-argument-value'].repairStep(
    { tool: 'compute_schedule', args: { startDate: '11/10/2026', days: 3 } },
    'compute_schedule: startDate must be YYYY-MM-DD',
  );
  assert.equal(r.remove, true, 'an un-derivable date must remove the step');
  assert.notEqual(r.args.startDate, '2026-10-11', 'no hardcoded date may be substituted');
});

test('fixer NEVER invents a duration: non-numeric days removes the step', () => {
  const r = STRATEGIES['invalid-argument-value'].repairStep(
    { tool: 'compute_schedule', args: { startDate: '2026-10-11', days: 'fourteen' } },
    'compute_schedule: days must be an integer 1-365',
  );
  assert.equal(r.remove, true, 'an un-derivable duration must remove the step');
});

test('fixer clamps derivable out-of-range values (that is not invention)', () => {
  const r = STRATEGIES['invalid-argument-value'].repairStep(
    { tool: 'compute_schedule', args: { startDate: '2026-13-45', days: 999 } },
    'compute_schedule: startDate must be YYYY-MM-DD',
  );
  assert.equal(r.remove, false);
  assert.equal(r.args.startDate, '2026-12-31'); // clamped from the input itself
  assert.equal(r.args.days, 365);
});

test('fixer NEVER writes a placeholder payload: missing payload removes the step', () => {
  const r = STRATEGIES['invalid-argument-value'].repairStep(
    { tool: 'save_record', args: { name: 'report' } },
    'save_record: payload must be an object',
  );
  assert.equal(r.remove, true);
  assert.equal(r.args.payload, undefined, 'no {} placeholder may be invented');
});

test('fixer NEVER invents missing params: the step is removed', () => {
  const r = STRATEGIES['missing-required-argument'].repairStep(
    { tool: 'save_record', args: {} },
    'requires string params name',
  );
  assert.equal(r.remove, true);
});

test('external failures retry UNCHANGED (no task rewrite around an outage)', () => {
  const step = { tool: 'web_search', args: { query: 'founders' } };
  const r = STRATEGIES['external-service-failure'].repairStep(step, 'crustdata network error: timeout');
  assert.equal(r.remove, false);
  assert.deepEqual(r.args, step.args, 'the retry must call exactly the same input');
});

// --- diff counter ----------------------------------------------------------

test('diffVsSnapshot counts an insertion at the top as one change, not N', () => {
  const f = join(process.cwd(), 'runtime', 'diff-test.tmp.json');
  const before = 'a\nb\nc\nd\ne';
  writeFileSync(f, 'NEW\na\nb\nc\nd\ne');
  const changes = diffVsSnapshot(f, before);
  rmSync(f, { force: true });
  assert.equal(changes, 1, 'one inserted line = exactly one change, however far it shifts the rest');
});
