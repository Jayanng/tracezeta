# TraceZeta

**The pit crew for AI systems: a team of agents that watches other agents run, finds out why they broke, fixes them, and proves the fix worked — before a human ever looks at it.**

And it holds itself to the same standard. The loop that fixes failing agents has found and repaired bugs in **its own source code** — sandboxed, gate-verified, and approved at a human review gate. It cannot lie to itself, and it cannot silently break itself to look good. That is the whole point.

## What it is

TraceZeta is a team of specialist agents built on four real platforms:

- **neatlogs** — every agent run is traced; incidents, detections, and the team's own operations all live there
- **Entire** — every fix gets a checkpoint; the team searches its own past fixes by meaning before diagnosing
- **Crustdata** — seven of the target's eleven tools run on live B2B data (companies, people, jobs, web, social posts)
- **cfo.ai** — the business plan, built and stress-tested from measured telemetry, not guesses

## The loop

```
Breaker       engineers real failures into a traced target agent
Sentinel      watches the traces, opens incidents
Investigator  forms competing hypotheses, REJECTS any the spans don't support,
              consults memory: "have we seen this before? what fixed it?"
Fixer         proposes the smallest possible repair — a task-spec edit,
              or a sandboxed patch to the source code itself
Verifier      re-runs the target, diffs before/after spans, red-teams the fix
Gate          a source patch must prove it did NOT silence errors to pass
Orchestrator  accepts, iterates, or escalates — honest exit codes
Human review  a verified source patch waits for a person to approve it
```

Every stage's output is a durable JSON artifact citing its evidence:

- `runs/` — span-level run records, each linked to its neatlogs trace by traceId
- `incidents/` — what failed, where, when
- `diagnoses/` — root causes with cited spans, rejected hypotheses with reasons,
  and a memory block showing the prior traces and prior fixes consulted
- `fixes/` — the exact repairs, minimal by construction; source-repair proposals
  with the full diff and gate verdict
- `verifications/` — before/after span comparison, regression check, verdict
- `loop-runs/` — the whole cycle as one audit trail

## The self-repair cycle (the part that matters)

When a failing step's root cause is a defect in **our own code**, not the task:

1. **Classify** — three tests: schema-valid args, the tool never succeeded, and the
   error reproduces on a live re-probe. Flaky failures are correctly refused.
2. **Sandbox** — a repair session runs as a dedicated OS user that can write
   **exactly one file**. The Verifier, the diagnosis rules, and the gate itself
   are unreadable and unwritable to it — enforced by ACLs, not prompts.
3. **Repair** — an agy (Antigravity) session patches the code inside the sandbox.
4. **The Gate** — the patch passes only if:
   - the failure reproduces on the original code (no defect = no repair)
   - the failing step recovers with the patch
   - **known-bad inputs STILL fail** — a patch that swallows errors is rejected
     as reward hacking. Proven by live test.
   - healthy steps don't regress
   - the diff is bounded (one file, ≤40 lines — a rewrite is not a fix)
5. **Human review** — a verified patch is saved as `AWAITING_HUMAN_REVIEW`
   with the full diff. The loop never applies a source patch itself. A person does.

The first completed cycle (commit `f2dbd25`): a real defect in `company_enrich`,
diagnosed from a live API error, patched by an agent in the sandbox, verified by
all five gate checks, approved by the human gate, fixed. The commit history tells
the whole story — including the reward-hacking patch the gate rejected on the way.

## Why this is different

Most agent frameworks generate failures and show them on a dashboard. TraceZeta
closes the loop all the way down: detection → diagnosis → repair → adversarial
verification → human review — for the target **and for itself**. Hypotheses
without evidence are rejected. Values that can't be derived are never invented.
The memory layer means the system gets faster at every failure it has already
survived: neatlogs remembers the failure signatures, Entire remembers how they
were fixed, and the next diagnosis arrives pre-corroborated.

During the build, the loop caught **eight of its own bugs** the same way it
catches the target's — each rejection exposed a real defect in the Fixer or
Investigator source, each documented in the commit history.

## The target

A real tool-calling agent with **eleven genuine tools** across live data sources:

- 4 core tools: live exchange rates (public API), validated JSON persistence,
  real date arithmetic, record read-back
- 7 B2B tools on live Crustdata endpoints: company search, company enrich
  (firmographics, headcount, funding), person search, job search (212k+ live
  listings), social post search, live web search, and a credits check — the
  agent watches its own data budget

Nothing mocked. Failures here are real failures against real external services:
validation errors, API errors, rate limits, entities that do not exist —
captured as real neatlogs traces.

## Running

```bash
# 1. Run a task through the target (traced + recorded)
node src/target/index.js tasks/breaker-classes.json   # or any task file

# 2. Run the full autonomous loop
node src/agents/orchestrator.js

# Exit 0: all incidents resolved. Exit 1: incidents remain open.
```

Requires `NEATLOGS_WRITE_KEY`, `NEATLOGS_PROJECT_ID`, and `CRUSTDATA_API_KEY` in
`.env` (never committed; the Crustdata key arrived through a one-time
masked-entry page).

## The business

Built and stress-tested with cfo.ai's AI CFO on measured operating data —
**https://app.cfo.ai/s/vjF416MqG4tyZXkN** (view-only, no account needed):

- 86 agent runs, 335 live tool spans, 122 real failures, 143 incidents,
  0.131 Crustdata credits per API call — measured, cited, verifiable in this repo
- COGS per fix-cycle: $0.08 base ($0.025–$0.20 range) from component costs,
  labeled "estimated actuals: measured credits, estimated dollars"
- Runway survives doubled churn and 2.5× cycle cost, with the thin-margin
  case flagged honestly
- Every provisional input labeled as such

## Evidence

### What the rules require, and where to verify each

**"Your project must use neatlogs, Entire and cfo.ai" — all three, with links:**

1. **neatlogs** — project `tracezeta` (UUID `95489ec6-1955-45c6-b8c4-60c60b207e42`).
   Live traces for every target run AND every team operation (the `team:` prefix):
   sentinel-watch, investigate, propose-fix, verify. Every run record in `runs/`
   carries its real ingest trace ID. The trace-level memory search runs against
   this project's history before every diagnosis.
2. **Entire** — repo `Jayanng/tracezeta` connected; 35 checkpoints (one per fix
   cycle, git-refs backend). First checkpoint:
   `01M4MQF7PK22KAERTY8FMJGNSQ` (session `9e3acb52-a6f2-4740-aeb1-0671ba7181c8`,
   commit `1fcefb4`, Antigravity session, 19.1k tokens, AI summary generated).
   Git ref on GitHub:
   `https://github.com/Jayanng/tracezeta/tree/refs/entire/checkpoints/SQ/01M4MQF7PK22KAERTY8FMJGNSQ`.
   Repo on Entire: `/et/gh:mirrors:01M4JNR3G2QJSYJ8EY3TAXAG4Z/tracezeta`
   (cluster `aws-eu-central-1.entire.io`).
   Inspect locally: `entire checkpoint explain 01M4MQF7PK22KAERTY8FMJGNSQ`.
   The fix-memory search (semantic, per root cause) runs over these checkpoints.
3. **cfo.ai** — the business plan, built and stress-tested with its AI CFO:
   **https://app.cfo.ai/s/vjF416MqG4tyZXkN** (view-only for judges, no account
   needed). Measured telemetry in, honest ranges out (see The business).

### Entire Trails

**Trail #1 — "Medic: self-repair cycle — company_enrich domains defect"**:
`https://entire.io/gh/Jayanng/tracezeta/trails/1`
Open on branch `medic/self-repair-company-enrich` → `main`, with two agent
findings: the full root-cause record (high severity, 97% confidence —
detection, classification, sandboxed repair, gate verification, human
approval) and the gate-verified patch attached as a suggested change.

### Crustdata (sponsor)

7 of the target's 11 tools run live B2B data on its API (sponsor credits;
not required by the rules — chosen for real failure diversity). Measured
burn: 0.131 credits per live API call.

### The self-repair record

`fixes/source-repairs/` holds the full first cycle: the gate verdict
(SOURCE_FIX_VERIFIED, all five checks), the proposed diff, and the human
approval (commit `f2dbd25` — including the reward-hacking patch the gate
rejected on the way).

### The loop audit trail

`incidents/` → `diagnoses/` → `fixes/` → `verifications/` → `loop-runs/`,
each stage a JSON artifact citing its evidence: which spans failed, which
hypotheses were rejected and why, which memory was consulted, what the
before/after diff proved.

Built for neatHack 2026, team JAYANNG.
