# TraceZeta

**A self-healing reliability layer for AI systems: a team of agents that monitors other agents in production, detects failures, diagnoses them from trace evidence, repairs them, and verifies every fix before a human reviews it.**

And it holds itself to the same standard. The loop that fixes failing agents has found and repaired bugs in **its own source code** — sandboxed, gate-verified, and approved at a human review gate. It cannot fabricate results, and it cannot silently break itself to appear correct. This is the project's core constraint.

## For judges: the 5-minute path

1. **Watch the demo video** — attached to our submission quote-tweet on X (team JAYANNG). It shows the gate rejecting a real patch for reward hacking, then both neatlogs incidents being identified and resolved.
2. **Run the tests**: `npm test` — 11 smoke tests, no API keys needed.
3. **Run the whole loop live**: `npm run demo` — Breaker engineers three failure classes into real runs, then the autonomous team (sentinel → investigator → fixer → verifier → gate → orchestrator) closes every incident. Exit 0 = all resolved.
4. **Verify the evidence yourself**:
   - neatlogs project: `95489ec6-1955-45c6-b8c4-60c60b207e42` (traces for every run and every team operation)
   - Entire trail: https://entire.io/gh/Jayanng/tracezeta/trails/1 (the full self-repair cycle)
   - cfo.ai plan: https://app.cfo.ai/s/vjF416MqG4tyZXkN (view-only, no account needed)

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
Fixer         proposes the smallest possible repair — a task-spec edit;
              when the failure is a defect in our own source code, a separate
              self-repair cycle (the Medic) takes over: sandbox, gate, review
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

## Running it

Prerequisites: Node.js 20+ (tested on Node 22) and an internet connection.
The target runs against **live** services (exchange rates, Crustdata B2B APIs) —
failures are real failures, so a live network is part of the demo.

```bash
git clone https://github.com/Jayanng/tracezeta.git
cd tracezeta
npm ci                      # one dependency: the neatlogs SDK
cp .env.example .env        # then fill in the three keys (see comments in the file)

# 1. Smoke tests — no keys, no network needed
npm test                    # 11 tests

# 2. Run a task through the target (traced + recorded)
node src/target/index.js tasks/breaker-classes.json   # or any task file in tasks/

# 3. Run the full autonomous loop over whatever incidents exist
node src/agents/orchestrator.js
# Exit 0: all incidents resolved. Exit 1: incidents remain open (honest).

# 4. Or run everything in one shot (Breaker -> loop -> verdict)
npm run demo
```

What each run writes: `runs/` (traced run records), `incidents/`, `diagnoses/`,
`fixes/`, `verifications/`, `loop-runs/` (the whole cycle as one audit trail).
Everything is plain JSON, every claim inside cites the span or file it came from.

## The self-repair cycle (source-level repair)

When a failing step's root cause is a defect in **our own code**, not the task,
the loop refuses to conceal it and escalates. That escalation hands off to
the Medic, the dedicated self-repair cycle run separately, with its own gate
and its own review:

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

To inspect the full record of that cycle without running anything:

```
fixes/source-repairs/inc-8cdafc668a0e-source-proposal.json   # diff + all five gate verdicts
fixes/inc-8cdafc668a0e-repair-plan.md                        # the plan
git show f2dbd25                                             # the applied fix
```

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

## The business

Built and stress-tested with cfo.ai's AI CFO on measured operating data —
**https://app.cfo.ai/s/vjF416MqG4tyZXkN** (view-only, no account needed):

- 86 agent runs, 335 live tool spans, 122 real failures, 143 incidents,
  0.131 Crustdata credits per API call — measured at plan time from the linked
  neatlogs project's trace history and this repo's artifacts (the repo keeps
  the latest run records and incident files; neatlogs holds the full history)
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
   Its **critical incidents** feature identified two real incidents in our own
   builds (8 traces each, pattern: tool contract misuse), wrote the investigation
   at 65% confidence with a recommended fix, and both were resolved on the board —
   one of them by **refusing** the suggested fix (it asked us to soften errors into
   not-found responses; the typed errors stay). The video shows the whole flow.
2. **Entire** — repo `Jayanng/tracezeta` connected; checkpoints throughout the
   build (one per fix cycle, git-refs backend, count grows with every cycle).
   First checkpoint:
   `01M4MQF7PK22KAERTY8FMJGNSQ` (session `9e3acb52-a6f2-4740-aeb1-0671ba7181c8`,
   commit `1fcefb4`, Antigravity session, 19.1k tokens, AI summary generated).
   Git ref on GitHub:
   `https://github.com/Jayanng/tracezeta/tree/refs/entire/checkpoints/SQ/01M4MQF7PK22KAERTY8FMJGNSQ`.
   Repo on Entire: `/et/gh:mirrors:01M4JNR3G2QJSYJ8EY3TAXAG4Z/tracezeta`
   (cluster `aws-eu-central-1.entire.io`).
   Inspect locally: `entire checkpoint explain 01M4MQF7PK22KAERTY8FMJGNSQ`.
   The fix-memory search (semantic, per root cause) runs over these checkpoints.
   Trail #1 documents the complete self-repair cycle:
   https://entire.io/gh/Jayanng/tracezeta/trails/1
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

## Honest notes

- **Solo builder.** One human, agent team on the loop. The Entire trail's
  "1 required approval" review is left honestly unsatisfied and documented —
  there is no second person, and we did not fabricate one. Every "human
  approval" in this repo is the builder's own review click, and it is labeled.
- **The loop never applies source patches itself.** Verified patches wait as
  `AWAITING_HUMAN_REVIEW`. This is deliberate: the human gate is the product.
- **Evaluator gauges are advisory.** The adversarial evaluation runners are
  nondeterministic; the written rationale in each diagnosis is the source of
  truth, and the gate verdicts are deterministic tests, not LLM judgments.
- **Nothing here is mocked.** Live APIs, real ingest, real re-runs. Where a
  number could not be measured, the artifact says so instead of estimating.

Built for neatHack 2026, team JAYANNG.
