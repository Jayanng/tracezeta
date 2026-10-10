# TraceZeta 3-minute demo video script

[0:00-0:20] HOOK
"The fastest path from failure to fix. TraceZeta is a team of agents that watches a
running AI agent through its traces, finds why it failed, fixes it, and proves the fix
with a before/after comparison. Everything you're about to see is real telemetry."

[0:20-0:50] THE TARGET + BREAKER
Screen: the target's four real tools; the Breaker suite injecting three failure
classes (wrong tool, malformed arguments, missing parameters). Show a trace landing
in the neatlogs dashboard (trace ID visible).

[0:50-1:30] SENTINEL + INVESTIGATOR
Screen: the Sentinel opening an incident; the Investigator's diagnosis with
citations. Call out: "three hypotheses were rejected because the spans did not
support them. No guessing."

[1:30-2:10] FIXER + VERIFIER
Screen: the minimal fix proposal; the Entire checkpoint before it; the re-run.
Before/after span diff: 3 failing -> 0 failing, no healthy step regressed.
"FIX_VERIFIED - and the loop caught its own bugs the same way."

[2:10-2:40] ORCHESTRATOR + THE LOOP'S OWN AUDIT TRAIL
Screen: one command resolving five incidents; the loop-runs/ JSON chain.
Every verdict cites its evidence file.

[2:40-3:00] CLOSE
"neatlogs gives the traces. Entire gives the rollback safety. cfo.ai gives the
business case. TraceZeta is the team that turns failures into fixed, verified
agents. All real, all cited, all reproducible."
