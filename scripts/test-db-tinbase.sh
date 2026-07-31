#!/usr/bin/env bash

# Runs the Tinbase-compatible DB test subset (tests/tinbase-db-tests.txt) against a
# throwaway Tinbase instance (single-binary Supabase emulator, ~5s to apply all
# migrations + seed). These tests only use supabase-js/PostgREST, so they don't need
# the full Docker Supabase stack. Tests that touch edge functions, Cloudflare
# workers, or raw Postgres TCP must stay in the Docker suites (Tinbase exposes no
# TCP Postgres port).

set -euo pipefail

PORT="${TINBASE_PORT:-55321}"
LOG="${TINBASE_LOG:-${TMPDIR:-/tmp}/tinbase-test-db.log}"

# Tinbase keeps state under <dir>/.tinbase even with --data-dir elsewhere; stale
# state from a previous instance makes the seed re-apply and fail on duplicates,
# so always start from a clean slate. .tinbase is gitignored and throwaway.
rm -rf .tinbase

bunx tinbase start --dir . -p "$PORT" > "$LOG" 2>&1 &
TINBASE_PID=$!
cleanup() {
  kill "$TINBASE_PID" 2>/dev/null || true
  rm -rf .tinbase 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 120); do
  grep -q "tinbase running" "$LOG" 2>/dev/null && break
  if ! kill -0 "$TINBASE_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! grep -q "tinbase running" "$LOG" 2>/dev/null; then
  echo "Tinbase failed to start:" >&2
  tail -n 100 "$LOG" >&2 || true
  exit 1
fi

ANON_KEY="$(awk '/anon key:/ {print $NF; exit}' "$LOG")"
SERVICE_KEY="$(awk '/service_role key:/ {print $NF; exit}' "$LOG")"

if [ -z "$ANON_KEY" ] || [ -z "$SERVICE_KEY" ]; then
  echo "Failed to parse Tinbase keys from $LOG" >&2
  exit 1
fi

# SUPABASE_DB_URL is a placeholder: setting all four vars stops test-utils from
# booting the Docker Supabase stack, and none of these tests use raw Postgres.
if ! SUPABASE_URL="http://127.0.0.1:${PORT}" \
  SUPABASE_ANON_KEY="$ANON_KEY" \
  SUPABASE_SERVICE_KEY="$SERVICE_KEY" \
  SUPABASE_DB_URL="postgresql://tinbase-no-tcp:5432/unused" \
  bunx vitest run $(tr '\n' ' ' < tests/tinbase-db-tests.txt); then
  echo "::group::Tinbase log tail"
  tail -n 200 "$LOG" || true
  echo "::endgroup::"
  exit 1
fi
