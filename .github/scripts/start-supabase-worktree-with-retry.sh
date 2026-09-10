#!/usr/bin/env bash

set -euo pipefail

max_attempts="${SUPABASE_START_MAX_ATTEMPTS:-3}"
exclude_services="${SUPABASE_START_EXCLUDE:-imgproxy,studio,mailpit,realtime,postgres-meta,supavisor,logflare,vector}"

for attempt in $(seq 1 "${max_attempts}"); do
  bun scripts/supabase-worktree.ts stop --no-backup || true
  if bun scripts/supabase-worktree.ts start -x "${exclude_services}"; then
    exit 0
  else
    exit_code=$?
    echo "Supabase start failed with exit ${exit_code} (attempt ${attempt}/${max_attempts})" >&2
    if [ "${attempt}" -eq "${max_attempts}" ]; then
      exit "${exit_code}"
    fi
    sleep_seconds=$((attempt * 5))
    echo "Retrying Supabase start in ${sleep_seconds}s..." >&2
    sleep "${sleep_seconds}"
  fi
done
