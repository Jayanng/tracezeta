// TraceZeta source repair: stage 1 — the filesystem-enforced sandbox.
//
// RULE (never crossed): the Verifier, the diagnosis rules, and the sandbox
// itself are NEVER writable by a repair session. The thing that judges the
// fixer cannot be modified by the fixer — enforced at the OS level with
// ACLs, not by prompt.
//
// Proven by live boundary tests:
//   granted file:    WRITE OK
//   verifier.js:     WRITE DENIED, READ DENIED (cannot even study the judge)
//   any other file:  WRITE DENIED
//
// Implementation notes (the traps we hit and fixed):
//   - /home/ubuntu is 750: the sandbox user needs +x to traverse
//   - the repo dir itself is 700: grant rX on IT, then -R for the tree
//   - the ACL *mask* must be raised to rw on the target file or the rw
//     entry is masked off
//   - cleanup strips ALL extended ACLs (-b) so the repo returns to plain perms

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const HOME = '/home/ubuntu';
const SANDBOX_USER = 'tracezeta-fix';

// The judging apparatus: never readable, never writable by a repair session.
// Also protected: the anti-reward-hacking gate and its classifiers (the repair
// agent must not be able to read the checks its patch will face), the repair
// flow's own orchestration, and the secrets (.env) and history (.git).
export const PROTECTED_SET = [
  join(ROOT, 'src/agents/verifier.js'),
  join(ROOT, 'src/agents/investigator.js'),
  join(ROOT, 'src/agents/memory.js'),
  join(ROOT, 'src/agents/sentinel.js'),
  join(ROOT, 'src/agents/orchestrator.js'),
  join(ROOT, 'src/agents/fixer.js'),
  join(ROOT, 'src/agents/gate.js'),
  join(ROOT, 'src/agents/classifier.js'),
  join(ROOT, 'src/agents/source-flow.js'),
  join(ROOT, 'src/agents/source-repair.js'),
  join(ROOT, 'src/agents/sandbox.js'),
  join(ROOT, '.env'),
  join(ROOT, '.git'),
];

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 60000 });
}

export function sandboxUserExists() {
  try { sh('id', [SANDBOX_USER]); return true; } catch { return false; }
}

export function ensureSandboxUser() {
  if (sandboxUserExists()) return true;
  try {
    sh('sudo', ['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', SANDBOX_USER]);
    return true;
  } catch (e) {
    throw new Error(`sandbox user creation failed: ${String(e.message || e).slice(0, 150)}`);
  }
}

/**
 * Grant the sandbox user: read access to the repo, WRITE access to exactly
 * one file, and nothing at all on the protected set.
 * Returns a revoke() that strips all extended ACLs.
 */
export function grantSingleFileWrite(filePath) {
  if (!existsSync(filePath)) throw new Error(`sandbox: target file not found: ${filePath}`);
  if (PROTECTED_SET.includes(filePath)) throw new Error('sandbox: REFUSED — target is in the protected set');
  ensureSandboxUser();
  // traverse the 750 home dir + the 700 repo dir + the agy binary's path
  sh('sudo', ['setfacl', '-m', `u:${SANDBOX_USER}:x`, HOME]);
  sh('sudo', ['setfacl', '-m', `u:${SANDBOX_USER}:x`, join(HOME, '.local')]);
  sh('sudo', ['setfacl', '-m', `u:${SANDBOX_USER}:x`, join(HOME, '.local', 'bin')]);
  sh('sudo', ['setfacl', '-m', `u:${SANDBOX_USER}:rX`, ROOT]);
  // read-only over the tree
  sh('sudo', ['setfacl', '-R', '-m', `u:${SANDBOX_USER}:rX`, ROOT]);
  // write ONLY the target (file ACL + mask)
  sh('sudo', ['setfacl', '-m', `u:${SANDBOX_USER}:rw,m::rw`, filePath]);
  // the judging apparatus: no permissions at all
  for (const p of PROTECTED_SET) {
    if (existsSync(p)) sh('sudo', ['setfacl', '-m', `u:${SANDBOX_USER}:---`, p]);
  }
  return () => {
    sh('sudo', ['setfacl', '-R', '-b', ROOT]);
    sh('sudo', ['setfacl', '-x', `u:${SANDBOX_USER}`, HOME, join(HOME, '.local'), join(HOME, '.local', 'bin')]);
  };
}

/** Verify the sandbox actually enforces the boundary (used before every session). */
export function verifyBoundary(targetFile) {
  const results = { grantedWritable: null, protectedBlocked: [] };
  const stamp = Date.now();
  const marker = `// sandbox-boundary-probe-${stamp}`;
  try {
    execFileSync('sudo', ['-u', SANDBOX_USER, '--', 'tee', '-a', targetFile], {
      input: marker + '\n', encoding: 'utf8', timeout: 10000,
    });
    results.grantedWritable = true;
  } catch {
    results.grantedWritable = false;
  }
  // remove the marker line (runs as the file owner via sudo)
  try {
    execFileSync('sudo', ['sed', '-i', `/sandbox-boundary-probe-${stamp}/d`, targetFile], { encoding: 'utf8', timeout: 10000 });
  } catch { /* marker stays only if write failed anyway */ }
  // write probes on the protected set (must ALL be denied)
  for (const p of PROTECTED_SET) {
    if (!existsSync(p)) continue;
    let violated = false;
    try {
      execFileSync('sudo', ['-u', SANDBOX_USER, '--', 'bash', '-c', `echo probe > ${JSON.stringify(p)}`], {
        encoding: 'utf8', timeout: 10000,
      });
      violated = true; // write succeeded = boundary broken
    } catch { /* denied = correct */ }
    if (violated) results.protectedBlocked.push({ file: p, violation: true });
  }
  // READ probes too: the repair agent must not read the gate, the secrets,
  // or the history (a write-only probe misses read leaks)
  results.protectedReadable = [];
  for (const p of PROTECTED_SET) {
    if (!existsSync(p)) continue;
    try {
      execFileSync('sudo', ['-u', SANDBOX_USER, '--', 'head', '-c', '16', p], {
        encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      results.protectedReadable.push({ file: p, violation: true }); // read succeeded = leak
    } catch { /* denied = correct */ }
  }
  const sound = results.grantedWritable === true
    && results.protectedBlocked.length === 0
    && results.protectedReadable.length === 0;
  return { sound, ...results };
}

/** Run a command as the sandbox user (cwd = repo, read-mostly). */
export function runAsSandbox(cmd, args, timeoutMs = 180000) {
  try {
    const out = execFileSync('sudo', ['-u', SANDBOX_USER, '--', cmd, ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300), out: String(e.stdout || '') };
  }
}

/** Snapshot a file for before/after comparison. */
export function snapshot(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}

/** Line-level change count between snapshot and current content.
 *  Multiset difference (position-independent): an insertion at the top of the
 *  file counts as ONE change, not one per shifted line. */
export function diffVsSnapshot(filePath, before) {
  const after = snapshot(filePath);
  if (before === null && after === null) return 0;
  if (before === null || after === null) return -1; // created/deleted (refuse)
  const count = (lines) => {
    const m = new Map();
    for (const l of lines) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const bm = count(before.split('\n'));
  const am = count(after.split('\n'));
  let removed = 0;
  for (const [l, n] of bm) removed += Math.max(0, n - (am.get(l) || 0));
  let added = 0;
  for (const [l, n] of am) added += Math.max(0, n - (bm.get(l) || 0));
  return added + removed;
}
