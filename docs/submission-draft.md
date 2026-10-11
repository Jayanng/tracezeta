# neatHack 2026 submission post (draft)

## Team
JAYANNG

## Project
TraceZeta — the agent team that finds why other agents failed, fixes them, and proves the fix.

## Links (one per evidence item)
- Public repo: https://github.com/Jayanng/tracezeta (flip to public before posting)
- Demo video: [3-min video — record after cfo.ai plan; script in docs/video-script.md]
- neatlogs project: tracezeta (UUID 95489ec6-1955-45c6-b8c4-60c60b207e42) — live traces,
  incidents, and the self-tracing team thread visible in the dashboard
- Entire first checkpoint: 01M4MQF7PK22KAERTY8FMJGNSQ
  (https://github.com/Jayanng/tracezeta/tree/refs/entire/checkpoints/SQ/01M4MQF7PK22KAERTY8FMJGNSQ
  once public; every fix carries its own checkpoint)
- cfo.ai business plan: https://app.cfo.ai/s/vjF416MqG4tyZXkN (view-only, no account needed)
  — grounded in measured build telemetry (credits per call, cost per fix-cycle,
  stress-tested runway)
- Crustdata: 7 of the target's 11 tools run live B2B data (sponsor credits)

## One-paragraph pitch
TraceZeta watches a real tool-calling agent through neatlogs. When the agent fails, a
team of specialist agents closes the loop: the Sentinel opens incidents from the
traces, the Investigator forms competing hypotheses and rejects any the span evidence
does not support, the Fixer proposes minimal repairs with an Entire checkpoint before
each, the Verifier re-runs the target and proves recovery with a before/after span
diff, and the Orchestrator accepts, iterates, or escalates — honest exit codes. The
team traces itself into the same neatlogs project, so the dashboard shows both the
target's runs and the team's operations over them. Every artifact in the audit chain
(incidents → diagnoses → fixes → verifications → loop-runs) cites its evidence.

## Rubric coverage notes (for us, not the post)
- Tool use (25%): 11 real tools, 6 failure classes fixed live
- Recovery + verification: the whole product
- Demo clarity: video script walks the loop end to end
- Building in public (20%): REMINDER — we still need the X posts tagged #neatHack.
  Post per phase boundary. Not done yet. This is a real gap.

## Order of operations at submission (tomorrow 7 PM IST)
1. Flip repo public
2. Record video (or finalize if recorded earlier)
3. cfo.ai plan link
4. Quote the official neatlogs post with team, name, project, public repo, demo
