# TraceZeta

**The agent team that finds why other agents failed, fixes them, and proves the fix.**

TraceZeta watches a live tool-calling agent through neatlogs, and when the agent fails, a
team of specialist agents does what a human engineer does: opens an incident, diagnoses
root cause from the trace evidence, proposes a minimal fix, re-runs the system, and
compares before/after to prove the fix worked. Then it writes the whole story back to
the traces.

## Why this is different

Most agent frameworks generate failures and show them on a dashboard. TraceZeta closes
the loop: detection, diagnosis, repair, verification, all driven by trace evidence, with
hypotheses that are **rejected** when the evidence does not support them. Nothing is
asserted without citation.

The loop, live and real:

```
Breaker  engineers real failures into a traced target agent (wrong tool,
         malformed arguments, missing parameters)
Sentinel watches neatlogs + run records, opens incidents
Investigator  forms competing hypotheses, rejects any the spans do not support,
              cites the exact spans that survive
Fixer    proposes minimal scoped repairs, an Entire checkpoint before each
Verifier re-runs the target, diffs before/after spans, red-teams the fix
         (healthy steps must not regress)
Orchestrator  accepts, iterates, or escalates; the exit code is honest
```

## Verified behavior, not claims

Every run of the loop produces durable evidence artifacts:

- `runs/` — full span-level run records, each linked to its neatlogs trace by traceId
- `incidents/` — what failed, where, when
- `diagnoses/` — root causes with cited spans, plus rejected hypotheses and why
- `fixes/` — the exact repairs proposed, minimal by construction
- `verifications/` — before/after span comparison, regression check, verdict
- `loop-runs/` — the whole cycle as one audit trail

During the build, the loop caught two of its own bugs the same way it catches the
target's: the Verifier rejected an incomplete fix (a date that passed format validation
but was semantically invalid), and a repair was silently skipped after an array splice
shifted indexes. Both fixed, both documented in commit history.

## The target

A real tool-calling agent with four genuine tools: live exchange rates from a public
API, validated JSON persistence, real date arithmetic, record read-back. Nothing mocked:
failures in this system are real failures, captured as real neatlogs traces.

## Running

```bash
# 1. Run a task through the target (traced + recorded)
node src/target/index.js tasks/breaker-classes.json   # or any task file

# 2. Run the full autonomous loop
node src/agents/orchestrator.js

# Exit 0: all incidents resolved. Exit 1: incidents remain open.
```

Requires `NEATLOGS_WRITE_KEY` and `NEATLOGS_PROJECT_ID` in `.env` (never committed).

## Tooling

- **neatlogs** — traces, incidents, detections, the read/write surface the whole team
  runs on
- **Entire** — a checkpoint before every fix; every verification names its checkpoint
- **cfo.ai** — the business plan runs on its numbers

Built for neatHack 2026, team JAYANNG.
