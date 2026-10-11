/**
 * Shared live step probe.
 *
 * Runs ONE tool step against the CURRENT code on disk in a fresh node process
 * (a fresh process is what actually picks up patched code; a dynamic import
 * would hit the module cache of a long-lived process). Used by both the gate
 * (anti-reward-hacking verification) and the source-repair flow.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export async function runStep(step, probeName = 'step-probe.mjs') {
  const probeFile = join(ROOT, 'runtime', probeName);
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
    const out = execFileSync('node', [probeFile], { encoding: 'utf8', timeout: 90000 });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (e) {
    return { status: 'ERROR', error: String(e.message || e).slice(0, 200) };
  }
}
