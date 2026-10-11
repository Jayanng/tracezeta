// TraceZeta target tools: Crustdata B2B data (6 live domains).
//
// Every tool is a genuine external call to api.crustdata.com with the real
// API key from .env. Each can genuinely fail: auth, rate limit, credit
// exhaustion, invalid filter, unknown entity, empty result. Those failures
// are the Breaker's raw material and the Investigator's evidence.
//
// Contracts below were probed live (not guessed):
//   POST /company/search    {search:{query,mode},fields,limit} -> {companies,next_cursor,total_count}
//   POST /company/enrich    {domains:[...],fields}             -> [{matched_on,match_type,matches:[{confidence_score,company_data}]}]
//   POST /person/search     {search:{query},limit,fields}      -> {profiles,next_cursor,total_count}
//   POST /job/search        {filters:{field,type,value},limit} -> {job_listings,next_cursor,total_count}
//   POST /web/search/live   {query}                            -> {results:[{source,title,url,snippet}]}
//   POST /social_post/search{filters:{field,type,value},limit} -> {posts,next_cursor,total_count}
//   GET  /account/credits   (free)                             -> {account:{credits,wallets}}

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from './target-errors.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://api.crustdata.com';

function crustKey() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) throw new ToolError('crustdata: .env not found');
  const m = readFileSync(envPath, 'utf8').match(/^CRUSTDATA_API_KEY=(.+)$/m);
  if (!m) throw new ToolError('crustdata: CRUSTDATA_API_KEY missing');
  return m[1].trim();
}

async function crustCall(path, body, method = 'POST') {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${crustKey()}`,
        'x-api-version': '2025-11-01',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new ToolError(`crustdata network error: ${e.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 429) throw new ToolError('crustdata rate limit exceeded (HTTP 429)');
  if (res.status === 402) throw new ToolError('crustdata insufficient credits (HTTP 402)');
  if (!res.ok) {
    const msg = json?.error?.message || JSON.stringify(json).slice(0, 150);
    throw new ToolError(`crustdata HTTP ${res.status}: ${msg}`);
  }
  return json;
}

// --- TOOLS ------------------------------------------------------------------

/** Search companies by natural-language query. */
export async function companySearch({ query, limit = 5 } = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ToolError('company_search: query must be a non-empty string');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new ToolError('company_search: limit must be an integer 1-25');
  }
  const d = await crustCall('/company/search', {
    search: { query, mode: 'hybrid' },
    fields: ['basic_info', 'headcount'],
    limit,
  });
  const companies = (d.companies || []).map((c) => {
    const bi = c.basic_info || {};
    return {
      name: bi.name,
      domain: bi.primary_domain,
      industry: bi.industry,
      headcount: c.headcount?.total ?? c.headcount?.current ?? null,
    };
  });
  if (!companies.length) throw new ToolError(`company_search: no companies matched '${query}'`);
  return { query, total: d.total_count, companies };
}

/** Enrich one company by its web domain. */
export async function companyEnrich({ domain } = {}) {
  if (typeof domain !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new ToolError(`company_enrich: '${domain}' is not a valid domain`);
  }
  const d = await crustCall('/company/enrich', {
    domains: domain,
    fields: ['basic_info', 'headcount', 'funding'],
  });
  const entry = Array.isArray(d) ? d[0] : null;
  const match = entry?.matches?.[0];
  if (!match) throw new ToolError(`company_enrich: no match for domain '${domain}'`);
  const cd = match.company_data || {};
  const bi = cd.basic_info || {};
  return {
    domain,
    name: bi.name,
    id: cd.crustdata_company_id,
    confidence: match.confidence_score,
    headcount: cd.headcount?.total ?? null,
    fundingRounds: cd.funding?.num_funding_rounds ?? null,
    totalFundingUsd: cd.funding?.funds_total_usd ?? null,
  };
}

/** Search people by role query. */
export async function personSearch({ query, limit = 5 } = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ToolError('person_search: query must be a non-empty string');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new ToolError('person_search: limit must be an integer 1-25');
  }
  const d = await crustCall('/person/search', {
    search: { query },
    limit,
    fields: ['basic_profile'],
  });
  const people = (d.profiles || []).map((p) => {
    const bp = p.basic_profile || {};
    return {
      name: bp.full_name ?? bp.name ?? null,
      title: bp.title ?? null,
      company: bp.company_name ?? null,
    };
  });
  if (!people.length) throw new ToolError(`person_search: no people matched '${query}'`);
  return { query, total: d.total_count, people };
}

/** Search job listings by title. */
export async function jobSearch({ title, limit = 5 } = {}) {
  if (typeof title !== 'string' || !title.trim()) {
    throw new ToolError('job_search: title must be a non-empty string');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new ToolError('job_search: limit must be an integer 1-25');
  }
  const d = await crustCall('/job/search', {
    filters: { field: 'job_details.title', type: '(.)', value: title },
    limit,
  });
  const jobs = (d.job_listings || []).map((j) => {
    const jd = j.job_details || {};
    const comp = (j.company || {}).basic_info || {};
    return { title: jd.title, company: comp.name ?? null, workplace: jd.workplace_type ?? null };
  });
  if (!jobs.length) throw new ToolError(`job_search: no job listings matched '${title}'`);
  return { title, total: d.total_count, jobs };
}

/** Live web search (multi-source). */
export async function webSearch({ query } = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new ToolError('web_search: query must be a non-empty string');
  }
  const d = await crustCall('/web/search/live', { query });
  const results = (d.results || []).slice(0, 5).map((r) => ({
    source: r.source, title: r.title, url: r.url, snippet: (r.snippet || '').slice(0, 200),
  }));
  if (!results.length) throw new ToolError(`web_search: no results for '${query}'`);
  return { query, results };
}

/** Search indexed social posts by text. */
export async function socialPostSearch({ text, limit = 5 } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ToolError('social_post_search: text must be a non-empty string');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new ToolError('social_post_search: limit must be an integer 1-25');
  }
  const d = await crustCall('/social_post/search', {
    filters: { field: 'text', type: '(.)', value: text },
    limit,
  });
  const posts = (d.posts || []).map((p) => {
    const a = p.actor || {};
    return {
      actor: a.headline || a.company_name || 'unknown',
      text: (p.text || '').slice(0, 200),
      likes: p.likes ?? p.reactions ?? null,
      date: p.date_posted ?? null,
    };
  });
  if (!posts.length) throw new ToolError(`social_post_search: no posts matched '${text}'`);
  return { text, total: d.total_count, posts };
}

/** Check remaining credit balance (free endpoint). */
export async function creditsCheck() {
  const d = await crustCall('/account/credits', null, 'GET');
  const a = d.account || {};
  return {
    credits: a.credits,
    recurring: a.recurring_credits,
    wallets: (a.wallets || []).map((w) => ({ type: w.type, credits: w.credits })),
  };
}

export const CRUST_TOOLS = {
  company_search: companySearch,
  company_enrich: companyEnrich,
  person_search: personSearch,
  job_search: jobSearch,
  web_search: webSearch,
  social_post_search: socialPostSearch,
  credits_check: creditsCheck,
};

export const CRUST_SCHEMAS = {
  company_search: { description: 'Search companies by natural-language query', params: { query: 'string', limit: 'integer 1-25 (default 5)' }, required: ['query'] },
  company_enrich: { description: 'Enrich a company by web domain', params: { domain: 'string, e.g. neatlogs.com' }, required: ['domain'] },
  person_search: { description: 'Search people by role query', params: { query: 'string', limit: 'integer 1-25 (default 5)' }, required: ['query'] },
  job_search: { description: 'Search job listings by title', params: { title: 'string', limit: 'integer 1-25 (default 5)' }, required: ['title'] },
  web_search: { description: 'Live multi-source web search', params: { query: 'string' }, required: ['query'] },
  social_post_search: { description: 'Search indexed social posts by text', params: { text: 'string', limit: 'integer 1-25 (default 5)' }, required: ['text'] },
  credits_check: { description: 'Check remaining Crustdata credit balance (free)', params: {}, required: [] },
};
