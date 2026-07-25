#!/usr/bin/env bash
set -euo pipefail
SHARDS="${SHARD_COUNT:-6}"
CONC="${RECLAIM_R2_CONCURRENCY:-500}"
mkdir -p .context
echo "Starting ${SHARDS} trash shards @ concurrency ${CONC} each"
pids=()
for i in $(seq 0 $((SHARDS - 1))); do
  SHARD_COUNT="$SHARDS" SHARD_INDEX="$i" RECLAIM_R2_CONCURRENCY="$CONC" \
    bun scripts/trash_r2_manifest_orphans.ts \
    >".context/r2_manifest_orphans_shard_${i}.log" 2>&1 &
  pids+=("$!")
  echo "  shard $i pid $!"
done
echo "${pids[@]}" > .context/r2_manifest_orphans_shards.pids

while true; do
  alive=0
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then alive=$((alive + 1)); fi
  done
  done_n=0
  for f in .context/r2_manifest_orphans_done.txt .context/r2_manifest_orphans_done_*.txt; do
    [[ -f "$f" ]] || continue
    n=$(wc -l < "$f" | tr -d ' ')
    done_n=$((done_n + n))
  done
  fail_n=0
  for f in .context/r2_manifest_orphans_failed.txt .context/r2_manifest_orphans_failed_*.txt; do
    [[ -f "$f" ]] || continue
    n=$(wc -l < "$f" | tr -d ' ')
    fail_n=$((fail_n + n))
  done
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  line="[$ts] shards_alive=${alive}/${SHARDS} done_lines=${done_n} fail_lines=${fail_n}"
  echo "$line" | tee -a .context/r2_manifest_orphans_progress.log
  if [[ "$alive" -eq 0 ]]; then
    echo "[$ts] all shards finished" | tee -a .context/r2_manifest_orphans_progress.log
    break
  fi
  sleep 5
done

status=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then status=1; fi
done
exit "$status"
