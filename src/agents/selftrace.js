// TraceZeta self-tracing.
//
// The agent team traces itself: every loop stage (watch, investigate, propose,
// verify, resolve) posts its own trace to the same neatlogs project. In the
// dashboard you see two interleaved threads: the TARGET's runs and the TEAM's
// operations over them — the tool that watches, itself watched.

import { postTrace } from '../neatlogs.js';

const PROJECT = 'tracezeta';

/**
 * Emit one self-trace for a loop stage. Never throws: self-tracing must not
 * break the loop it measures.
 */
export async function traceStage(stage, detail) {
  const children = (detail.children || []).map((c) => ({
    name: c.name,
    kind: c.kind || 'TOOL',
    tool_name: c.tool_name || c.name,
    input: c.input,
    output: c.output,
    status: c.status || 'OK',
    ...(c.error ? { error: c.error, status: 'ERROR' } : {}),
    ...(c.duration_ms !== undefined ? { duration_ms: c.duration_ms } : {}),
  }));

  const trace = {
    name: `team:${stage}`,
    project: PROJECT,
    children,
  };
  const t = await postTrace(trace);
  return t.ok ? t.traceId : null;
}

/** Sentinel stage: one child per incident opened. */
export function sentinelStage(result) {
  return {
    children: (result.opened || []).map((i) => ({
      name: `incident:${i.id}`,
      tool_name: 'open_incident',
      input: { traceId: i.traceId, failedSteps: i.failedSteps },
      output: { incidentFile: i.file },
    })),
  };
}

/** Investigator stage: verdict + root causes + rejections as children. */
export function investigatorStage(incidentId, diagnosis) {
  const kids = [];
  for (const rc of diagnosis.rootCauses || []) {
    kids.push({
      name: `hypothesis-accepted:${rc.id}`,
      tool_name: 'evaluate_hypothesis',
      input: { hypothesis: rc.label },
      output: { spans: rc.spans, evidence: rc.evidence },
    });
  }
  for (const rh of diagnosis.rejectedHypotheses || []) {
    kids.push({
      name: `hypothesis-rejected:${rh.id}`,
      tool_name: 'evaluate_hypothesis',
      input: { hypothesis: rh.label },
      output: { rejectionReason: rh.rejectionReason },
    });
  }
  if (!kids.length) {
    kids.push({
      name: `diagnosis:${diagnosis.verdict}`,
      tool_name: 'diagnose',
      input: { incidentId },
      output: { verdict: diagnosis.verdict },
    });
  }
  return { children: kids };
}

/** Fixer stage: one child per proposed repair. */
export function fixerStage(fixResult) {
  const fix = fixResult.fix;
  if (!fix) {
    return { children: [{ name: 'fix-refused', tool_name: 'propose_fix', input: {}, output: { reason: fixResult.reason } }] };
  }
  return {
    children: fix.repairs.map((r) => ({
      name: `repair:${r.tool}`,
      tool_name: 'propose_repair',
      input: { tool: r.tool, original: r.original },
      output: { repaired: r.repaired, remove: r.remove === true, notes: r.notes },
    })),
  };
}

/** Verifier stage: the before/after comparison as children. */
export function verifierStage(verification) {
  return {
    children: [
      {
        name: 'before',
        tool_name: 'read_evidence',
        input: { traceId: verification.before.traceId },
        output: { failingSteps: verification.before.failingSteps, passingSteps: verification.before.passingSteps },
      },
      {
        name: 'after',
        tool_name: 're_run_target',
        input: { traceId: verification.after.traceId },
        output: { failingSteps: verification.after.failingSteps, passingSteps: verification.after.passingSteps },
        status: verification.after.failingSteps.length ? 'ERROR' : 'OK',
      },
      {
        name: `verdict:${verification.verdict}`,
        tool_name: 'compare',
        input: { before: verification.before.failingSteps, after: verification.after.failingSteps },
        output: { regressed: verification.comparison.regressedHealthySteps, accepted: verification.accepted },
      },
    ],
  };
}
