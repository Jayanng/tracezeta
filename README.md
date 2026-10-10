# TraceZeta

A team of agents that watches a running system through neatlogs, finds the cause of
failings in the traces, takes a verified action to fix them, and confirms recovery by
comparing runs. Built for neatHack 2026 with neatlogs, Entire, and cfo.ai.

Agents:
- Breaker: adversarially engineers real failures in the target system
- Sentinel: watches neatlogs traces for anomalies, opens incidents
- Investigator: diagnoses root cause from span evidence, hypothesis-gated
- Fixer: proposes minimal scoped fixes, checkpointed via Entire
- Verifier: proves recovery with before/after traces and adversarial re-testing

Everything is real. No mocked telemetry, no canned failures, no fabricated evidence.
