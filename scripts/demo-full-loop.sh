#!/usr/bin/env bash
# TraceZeta full demo: Breaker classes -> autonomous loop -> verification.
# Everything real: real traces to neatlogs, real re-runs, real verdicts.
set -u
cd "$(dirname "$0")/.."

echo "== TraceZeta full loop demo =="
echo "== Phase 1: Breaker — engineer the three failure classes into real runs =="
node -e "
const fs = require('fs');
const suite = JSON.parse(fs.readFileSync('tasks/breaker-classes.json', 'utf8'));
(async () => {
  for (const c of suite.classes) {
    const { runTask } = await import('./src/target/index.js');
    const r = await runTask(c.task);
    const failed = (r.results || []).filter(s => !s.ok).map(s => s.step);
    console.log('  [breaker] ' + c.id + ': trace ' + (r.traceId || 'NONE').slice(0, 10) + ', failed: ' + failed.join(', '));
  }
})();
"

echo
echo "== Phase 2: Orchestrator — the autonomous team closes every incident =="
node src/agents/orchestrator.js --rounds=3
EXIT=$?

echo
if [ $EXIT -eq 0 ]; then
  echo "== All incidents resolved. Evidence chain: =="
  echo "   incidents/ -> diagnoses/ -> fixes/ -> verifications/ -> loop-runs/"
else
  echo "== Some incidents remain open (honest exit 1). See loop-runs/ =="
fi
exit $EXIT
