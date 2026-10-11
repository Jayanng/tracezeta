// TraceZeta Investigator.
//
// Takes an open incident, forms COMPETING hypotheses for the root cause, and
// rejects any hypothesis the evidence does not support. Evidence sources, in
// priority order:
//   1. neatlogs span projection (when the platform finalizes the trace)
//   2. the run record (span-level, linked by traceId, written at run time)
//   3. trace metadata from the public API (always reads back)
//
// Every finding cites its evidence: span name, input, error, duration, source.
// The output is a diagnosis: failed spans + supported root-cause hypotheses.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTraceSpans, getTraceRawSpans, RUNS_DIR } from '../neatlogs.js';
import { searchTraceMemory, searchFixMemory, memoryQueries } from './memory.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DIAGNOSES_DIR = join(ROOT, 'diagnoses');

function findRunRecord(traceId) {
  // search live runs/ AND the archive (historical traces keep valid evidence)
  for (const dir of [RUNS_DIR, join(ROOT, 'archive', 'pre-b2b-reset')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const run = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        if (run?.trace?.traceId === traceId) return { file: join(dir, f), run };
      } catch { /* skip corrupt */ }
    }
  }
  return null;
}

function findRunRecordValue(traceId) {
  return findRunRecord(traceId)?.run || null;
}

function safeParse(preview) {
  if (typeof preview !== 'string') return preview;
  try { return JSON.parse(preview); } catch { return preview; }
}

/** Cite evidence precisely: source + what it shows. */
function cite(span, source) {
  return {
    span: span.name,
    tool: span.tool_name || span.name,
    input: span.input,
    error: span.error || span.errorMessage || null,
    status: span.status,
    durationMs: span.duration_ms ?? span.durationMs ?? null,
    source, // 'neatlogs-span-projection' | 'run-record' | 'trace-metadata'
  };
}

/** The known failure taxonomy. Each class has a matcher over span evidence. */
const HYPOTHESIS_CLASSES = [
  {
    id: 'invalid-argument-value',
    label: 'A tool argument had an invalid value (malformed or out of domain)',
    // Supported when the error names the violated constraint of an input value
    supports: (c) => {
      const e = (c.error || '').toLowerCase();
      // exclusive matchers: 'unknown tool' -> wrong-tool-selected, 'requires'
      // -> missing-required-argument, 'no record named' -> entity-not-found.
      // Overlaps here produced duplicate, contradictory root causes.
      const namesAValue = /must be|invalid|no rate|not a/.test(e);
      return namesAValue;
    },
    explain: (c) => `span '${c.span}' failed with a validation error on its input: ${c.error}`,
  },
  {
    id: 'missing-required-argument',
    label: 'A required parameter was missing from the tool call',
    supports: (c) => {
      const e = (c.error || '').toLowerCase();
      return /requires|missing/.test(e) && !(c.input && Object.keys(c.input).length > 0 && /must be/.test(e));
    },
    explain: (c) => `span '${c.span}' rejected the call for missing parameters: ${c.error}`,
  },
  {
    id: 'wrong-tool-selected',
    label: 'The wrong tool was selected for the step (unknown tool name)',
    supports: (c) => /unknown tool/.test((c.error || '').toLowerCase()),
    explain: (c) => `span '${c.span}' called a tool that does not exist: ${c.error}`,
  },
  {
    id: 'external-service-failure',
    label: 'An external dependency failed (network/API error)',
    supports: (c) => /http|timeout|network|fetch|api returned|connection/i.test(c.error || ''),
    explain: (c) => `span '${c.span}' failed against an external service: ${c.error}`,
  },
  {
    id: 'entity-not-found',
    label: 'The step referenced an entity that does not exist (no match in the data source)',
    supports: (c) => /no match for|no company|not found|no results? for|no record named/i.test(c.error || ''),
    explain: (c) => `span '${c.span}' asked for an entity the data source has no record of: ${c.error}`,
  },
];

/**
 * Investigate one incident.
 * Returns a diagnosis with cited evidence and REJECTED hypotheses too —
 * the rejection record is itself part of the audit trail.
 */
export async function investigate(incident) {
  const traceId = incident.trace.traceId;
  const citations = [];

  // Evidence source 1: span projection (may be unavailable) — structure only.
  // The projection strips error text; raw-spans previews carry it. Merge both.
  const spansResult = await getTraceSpans(traceId);
  let projectionUsed = false;
  if (spansResult.ok && Array.isArray(spansResult.spans) && spansResult.spans.length) {
    projectionUsed = true;
    // Fetch raw previews for the error text / input output the projection omits.
    // NOTE: projected spans use bare names, raw spans use 'tool:'-prefixed names —
    // match on both keys.
    const rawResult = await getTraceRawSpans(traceId);
    const rawBySpan = new Map();
    if (rawResult.ok) {
      for (const rs of rawResult.spans) {
        const key = rs.spanName || '';
        rawBySpan.set(key, rs);
        if (key.startsWith('tool:')) rawBySpan.set(key.slice(5), rs);
      }
    }
    for (const s of spansResult.spans) {
      if (String(s.status).toUpperCase() === 'ERROR') {
        const raw = rawBySpan.get(s.spanName) || {};
        const rawErr = raw?.error?.messagePreview ? String(raw.error.messagePreview) : '';
        const rawInput = raw?.input?.preview ? safeParse(raw.input.preview) : undefined;
        const runRecord = findRunRecordValue(traceId);
        const runSpanError = runRecord ? (runRecord.spans || []).find((rs) => rs.name === s.spanName)?.error : undefined;
        citations.push(cite({
          ...s,
          name: s.spanName,
          tool_name: null,
          error: rawErr || runSpanError || s.error || s.errorMessage || '(span marked ERROR; no error text available)',
          input: rawInput ?? s.input,
        }, rawErr ? 'neatlogs-raw-spans'
          : runSpanError ? 'run-record'
          : (s.error || s.errorMessage) ? 'neatlogs-span-projection'
          : 'none'));
      }
    }
  }

  // Evidence source 2: the run record (linked by traceId)
  const runEntry = findRunRecord(traceId);
  if (runEntry && !projectionUsed) {
    for (const s of runEntry.run.spans || []) {
      if (s.status === 'ERROR') {
        citations.push(cite(s, 'run-record'));
      }
    }
  }

  // Evidence source 3: trace metadata (always available)
  const meta = {
    traceId,
    traceName: incident.trace.traceName,
    status: incident.trace.status,
    finalizationStatus: incident.trace.finalizationStatus,
    source: 'trace-metadata',
  };

  // If no span-level evidence at all, the honest diagnosis is 'insufficient
  // evidence' — never a guess.
  if (citations.length === 0) {
    return {
      incidentId: incident.id,
      at: new Date().toISOString(),
      verdict: 'INSUFFICIENT_EVIDENCE',
      note: 'No span-level evidence available from either span projection or the run record.',
      traceMetadata: meta,
    };
  }

  // Competing hypotheses: each class is tested against EVERY citation; a
  // hypothesis survives only if at least one citation supports it, and every
  // citation it fails to explain counts against it.
  const hypotheses = HYPOTHESIS_CLASSES.map((h) => {
    const supportedBy = citations.filter((c) => h.supports(c));
    return {
      id: h.id,
      label: h.label,
      supported: supportedBy.length > 0,
      citations: supportedBy.map((c) => h.explain(c)),
      evidenceSpans: supportedBy.map((c) => c.span),
    };
  });

  const surviving = hypotheses.filter((h) => h.supported);
  const rejected = hypotheses.filter((h) => !h.supported);

  // MEMORY: consult both long-term memories before finalizing.
  //   neatlogs trace search: have we seen this failure signature before?
  //   Entire semantic search: what fixed it last time?
  // A root cause supported by current spans AND prior fixes is 'corroborated';
  // the loop demonstrably learns instead of re-deriving from scratch.
  const queries = memoryQueries(incident, citations);
  const traceMemory = await searchTraceMemory(queries, traceId);
  // Fix-memory queries: root-cause-aware terms find the actual fix commits
  // ("crustdata entity not found fix" finds the B2B repair commit; a raw error
  // string finds nothing). Fall back to the first keyword.
  const rcIds = surviving.map((h) => h.id);
  const fixQueryMap = {
    'invalid-argument-value': 'fix invalid argument repair strategy',
    'wrong-tool-selected': 'wrong tool repair strategy',
    'entity-not-found': 'crustdata entity not found fix',
    'missing-required-argument': 'missing required parameters fix',
    'external-service-failure': 'external api failure fix',
  };
  // search fix memory PER root cause so each gets its own corroborating evidence
  const fixMemories = {};
  for (const id of rcIds) {
    fixMemories[id] = await searchFixMemory(fixQueryMap[id] || queries[0] || 'fix');
  }
  for (const rc of surviving) {
    const myFixMemory = fixMemories[rc.id] || { prior: [] };
    const titles = (myFixMemory.prior || []).map((p) => String(p.title || '').toLowerCase());
    rc.corroborated = titles.some((t) => /fix|repair|verif|bug|strategy|crustdata|b2b|entity|enrich/.test(t));
    // the corroborating prior must be a real fix artifact (code/commit), not docs
    if (rc.corroborated) {
      rc.priorEvidence = (myFixMemory.prior || [])
        .filter((p) => {
          const t = String(p.title || '').toLowerCase();
          const isDoc = /^readme|docs|video script|submission/.test(t);
          return !isDoc && t.length > 10;
        })
        .slice(0, 2)
        .map((p) => ({ type: p.type, title: p.title, id: p.id, source: 'entire-search' }));
      if (!rc.priorEvidence.length) rc.corroborated = false;
    }
  }

  const diagnosis = {
    incidentId: incident.id,
    at: new Date().toISOString(),
    verdict: surviving.length > 0 ? 'ROOT_CAUSE_IDENTIFIED' : 'INCONCLUSIVE',
    rootCauses: surviving.map((h) => ({ id: h.id, label: h.label, evidence: h.citations, spans: h.evidenceSpans, corroborated: h.corroborated === true, priorEvidence: h.priorEvidence || [] })),
    rejectedHypotheses: rejected.map((h) => ({ id: h.id, label: h.label, rejectionReason: 'no span evidence supports this hypothesis' })),
    memory: {
      queries,
      traceMemory: traceMemory.ok
        ? { source: 'neatlogs-keyword-search', priorTraces: traceMemory.prior, count: traceMemory.prior.length }
        : { source: 'neatlogs-keyword-search', error: traceMemory.error },
      fixMemory: {
        source: 'entire-semantic-search',
        perRootCause: Object.fromEntries(Object.entries(fixMemories).map(([id, m]) => [
          id,
          m.ok ? { priorFixes: m.prior, count: m.prior.length } : { error: m.error },
        ])),
      },
    },
    citations,
    evidenceSources: {
      spanProjectionUsed: projectionUsed,
      runRecordUsed: !!runEntry && !projectionUsed,
      runFile: runEntry?.file || null,
      traceMetadata: meta,
    },
  };

  if (!existsSync(DIAGNOSES_DIR)) mkdirSync(DIAGNOSES_DIR, { recursive: true });
  const file = join(DIAGNOSES_DIR, `${incident.id}-diagnosis.json`);
  writeFileSync(file, JSON.stringify(diagnosis, null, 2));
  diagnosis.file = file;
  return diagnosis;
}

// CLI: node src/agents/investigator.js <incident-file>
if (process.argv[1] && process.argv[1].endsWith('investigator.js')) {
  const incidentFile = process.argv[2];
  if (!incidentFile) {
    console.error('usage: node src/agents/investigator.js <incident.json>');
    process.exit(2);
  }
  const incident = JSON.parse(readFileSync(incidentFile, 'utf8'));
  const diagnosis = await investigate(incident);
  console.log(JSON.stringify({
    verdict: diagnosis.verdict,
    rootCauses: diagnosis.rootCauses?.map((r) => r.label),
    rejected: diagnosis.rejectedHypotheses?.map((r) => r.id),
    citations: diagnosis.citations?.length,
    evidenceSources: diagnosis.evidenceSources?.spanProjectionUsed ? 'span-projection' : (diagnosis.evidenceSources?.runRecordUsed ? 'run-record' : 'trace-metadata'),
  }, null, 2));
}
