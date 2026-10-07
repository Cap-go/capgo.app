#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.bun/bin:${PATH}"
cd "$(dirname "$0")/.."

PORT="${TINBASE_PORT:-55321}"
LOG="${TINBASE_LOG:-${TMPDIR:-/tmp}/tinbase-pr-3280.log}"

rm -rf .tinbase
bunx tinbase start --dir . -p "$PORT" > "$LOG" 2>&1 &
TINBASE_PID=$!
cleanup() {
  kill "$TINBASE_PID" 2>/dev/null || true
  kill "$VITE_PID" 2>/dev/null || true
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

SUPABASE_URL="http://127.0.0.1:${PORT}"
API_DOMAIN="127.0.0.1:${PORT}/functions/v1"
TEST_USER_ID="6aa76066-55ef-4238-ade6-0b32334a4097"

# Ensure seeded console login works against Tinbase auth (seed hash is not always accepted).
curl -sf -X PUT "${SUPABASE_URL}/auth/v1/admin/users/${TEST_USER_ID}" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"password":"testtest","email_confirm":true}' >/dev/null

ENV=local SUPA_URL="$SUPABASE_URL" SUPA_ANON="$ANON_KEY" API_DOMAIN="$API_DOMAIN" CAPTCHA_KEY='' \
  bun run serve:local > /tmp/vite-pr-3280.log 2>&1 &
VITE_PID=$!

for _ in $(seq 1 120); do
  if curl -sf "http://localhost:5173/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

CAPGO_PR_SCREENSHOTS=1 SKIP_BACKEND_START=1 SKIP_FRONTEND_START=1 SKIP_STRIPE_EMULATOR_START=1 \
  SUPABASE_URL="$SUPABASE_URL" SUPABASE_ANON_KEY="$ANON_KEY" \
  bunx playwright test playwright/e2e/pr-3280-security-screenshots.spec.ts

echo "Screenshots written to docs/screenshots/pr-3280/"
