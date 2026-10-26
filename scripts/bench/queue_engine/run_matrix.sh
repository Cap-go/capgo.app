#!/bin/bash
# Full matrix used for the report (~85 min). Results land in ./runs, summary via summarize.py.
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
for load in 1 10 50 100; do
  for sys in pgmq pgque; do "$H/bench.sh" $sys $load 300; done
  TICK_MS=1000 "$H/bench.sh" pgque $load 300
done
for sys in pgmq pgque; do "$H/bench.sh" $sys 50 300 longtx; done
TICK_MS=1000 "$H/bench.sh" pgque 50 300 longtx
python3 "$H/summarize.py"
