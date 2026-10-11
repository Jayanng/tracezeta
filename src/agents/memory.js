// TraceZeta memory layer: the Investigator's long-term memory.
//
// TWO memory systems, both queried BEFORE forming hypotheses:
//   1. neatlogs keyword trace search — "have we SEEN this failure before?"
//      Searches the project's full trace history (target runs AND the team's
//      own investigation traces) by error keywords. Past incidents and their
//      matched spans come back with scores.
//   2. Entire semantic search — "what fixed it last time?"
//      Searches commits/checkpoints/sessions by meaning: a past fix commit
//      for the same failure class surfaces with its message and checkpoint.
//
// The diagnosis cites both as prior_evidence. A hypothesis supported by
// memory AND current spans is marked 'corroborated'; the Fixer receives the
// past fix strategy as a prior. This is what makes the loop learn.

import { execFile } from 'node:child_process';

const NL_ENV_BASE = ['--host', 'https://app.neatlogs.com', '--profile', 'setup-https---app-neatlogs-com', '--credential-source', 'profile', '--project', '95489ec6-1955-45c6-b8c4-60c60b207e42'];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (cmd === 'neatlogs') { delete env.NEATLOGS_API_KEY; delete env.NEATLOGS_TOKEN; }
    if (cmd === 'entire') { env.ENTIRE_TOKEN_STORE = 'file'; env.PATH = process.env.PATH; }
    execFile(cmd, args, { timeout: 30000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env, ...opts }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, error: String(err.message || err).slice(0, 200), stdout: String(stdout || '') });
      } else {
        resolve({ ok: true, stdout });
      }
    });
  });
}

/**
 * neatlogs trace memory: search past traces by keywords from the current
 * failure. Returns prior traces that matched, excluding the current one.
 */
export async function searchTraceMemory(keywords, excludeTraceId) {
  const qs = (keywords || []).filter((k) => k && k.length >= 2).slice(0, 4);
  if (!qs.length) return { ok: false, prior: [], error: 'no keywords' };
  // Search EACH keyword separately (a joined query is too specific and matches
  // nothing); merge results, dedupe by traceId, exclude the current trace.
  const seen = new Map();
  for (const q of qs) {
    const r = await searchTraceMemorySpawn(q.slice(0, 500), null);
    if (!r.ok) continue;
    for (const prior of r.prior) {
      if (prior.traceId === excludeTraceId) continue;
      if (!seen.has(prior.traceId)) seen.set(prior.traceId, prior);
    }
  }
  return { ok: true, prior: [...seen.values()].slice(0, 8) };
}

import { spawn } from 'node:child_process';

function searchTraceMemorySpawn(q, excludeTraceId) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NEATLOGS_API_KEY; delete env.NEATLOGS_TOKEN;
    const p = spawn('neatlogs', [...NL_ENV_BASE, 'api', 'post_api_v1_public_search_traces', '--body-stdin'], { env, timeout: 30000 });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => {
      try {
        const d = JSON.parse(out.replace(/^WARNING:[^\n]*\n/gm, ''));
        const results = (d.data?.results || [])
          .map((r) => ({
            traceId: r.trace?.traceId,
            traceName: r.trace?.traceName,
            status: r.trace?.status,
            score: r.score,
            matchedSpans: (r.matchedSpans || []).map((s) => s.name),
          }))
          .filter((r) => r.traceId && r.traceId !== excludeTraceId)
          .slice(0, 5);
        resolve({ ok: true, prior: results });
      } catch (e) {
        resolve({ ok: false, prior: [], error: e.message });
      }
    });
    p.on('error', (e) => resolve({ ok: false, prior: [], error: String(e) }));
    p.stdin.write(JSON.stringify({ q, limit: 10 }));
    p.stdin.end();
  });
}

/**
 * Entire memory: semantic search over past fixes. Searches for commits and
 * checkpoints related to the failure class; returns what fixed it before.
 */
export async function searchFixMemory(query) {
  if (!query || query.length < 3) return { ok: false, prior: [], error: 'no query' };
  const r = await run('entire', ['search', query, '--compact'], { cwd: process.cwd() });
  if (!r.ok) return { ok: false, prior: [], error: r.error };
  try {
    // compact output is JSON lines / array; parse defensively
    const cleaned = r.stdout.replace(/^WARNING:[^\n]*\n/gm, '').trim();
    const d = JSON.parse(cleaned);
    const results = (d.results || [])
      .map((res) => ({
        type: res.type,
        id: res.id,
        title: res.title || null,
        match: res.match || null,
        date: res.date,
        repo: res.repo,
      }))
      .slice(0, 5);
    return { ok: true, prior: results };
  } catch (e) {
    return { ok: false, prior: [], error: e.message };
  }
}

/**
 * Build memory queries from an incident's failed spans.
 * Error text is the strongest signal; tool names second.
 */
export function memoryQueries(incident, citations) {
  const keywords = new Set();
  for (const c of citations || []) {
    const err = String(c.error || '');
    // pull the distinctive words out of error messages
    for (const m of err.matchAll(/(?:must be|no match for|unknown tool|no record named|invalid|requires|not a valid)\s+([a-z_ ':-]{3,30})/gi)) {
      keywords.add(m[0].trim());
    }
    if (c.span) keywords.add(c.span.replace(/^tool:/, ''));
  }
  return [...keywords].slice(0, 4);
}
