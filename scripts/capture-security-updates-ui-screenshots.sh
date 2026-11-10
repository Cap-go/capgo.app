#!/usr/bin/env bash
set -euo pipefail

export PATH="${HOME}/.bun/bin:${PATH}"
cd "$(dirname "$0")/.."

PORT="${TINBASE_PORT:-55321}"
RUN_DIR="$(mktemp -d)"
LOG="${RUN_DIR}/tinbase.log"
VITE_LOG="${RUN_DIR}/vite.log"
TINBASE_DIR="${RUN_DIR}/tinbase"
BACKEND_LOG="${RUN_DIR}/backend.log"
BASE_REF="${SCREENSHOT_BASE_REF:-origin/main}"
OUTPUT_DIR="docs/screenshots/security-updates-ui"
GUARD_PATHS=(
  "src/pages/settings/account/Notifications.vue"
  "src/constants/observeTabs.ts"
  "src/pages/app/[app].observe.security.vue"
)

mkdir -p "$OUTPUT_DIR"

assert_clean_worktree_paths() {
  local path
  for path in "${GUARD_PATHS[@]}"; do
    if ! git diff --quiet -- "$path" || ! git diff --cached --quiet -- "$path"; then
      echo "Refusing to run: uncommitted changes in $path (commit or stash first)." >&2
      exit 1
    fi
  done
}

stop_vite() {
  if [[ -n "${VITE_PID:-}" ]] && kill -0 "$VITE_PID" 2>/dev/null; then
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
  fi
  VITE_PID=""
}

assert_clean_worktree_paths

cleanup() {
  kill "${TINBASE_PID:-}" 2>/dev/null || true
  kill "${VITE_PID:-}" 2>/dev/null || true
  kill "${BACKEND_PID:-}" 2>/dev/null || true
  git checkout HEAD -- src/pages/settings/account/Notifications.vue src/constants/observeTabs.ts 2>/dev/null || true
  test -f "$RUN_DIR/head-security-page.vue" && mv "$RUN_DIR/head-security-page.vue" "src/pages/app/[app].observe.security.vue" 2>/dev/null || true
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

bunx tinbase start --dir "$TINBASE_DIR" -p "$PORT" > "$LOG" 2>&1 &
TINBASE_PID=$!

for _ in $(seq 1 180); do
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

if ! curl -sf -X PUT "${SUPABASE_URL}/auth/v1/admin/users/${TEST_USER_ID}" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"password":"testtest","email_confirm":true}' >/dev/null; then
  echo "Warning: could not reset demo user password via Tinbase admin API; using seeded credentials." >&2
fi

start_vite() {
  ENV=local SUPA_URL="$SUPABASE_URL" SUPA_ANON="$ANON_KEY" API_DOMAIN="$API_DOMAIN" CAPTCHA_KEY='' \
    bun run serve:local > "$VITE_LOG" 2>&1 &
  VITE_PID=$!
  for _ in $(seq 1 120); do
    if curl -sf "http://localhost:5173/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Vite failed to start:" >&2
  tail -n 80 "$VITE_LOG" >&2 || true
  exit 1
}

run_playwright_phase() {
  local phase="$1"
  CAPGO_PR_SCREENSHOTS=1 CAPGO_SCREENSHOT_PHASE="$phase" SKIP_BACKEND_START=1 SKIP_FRONTEND_START=1 SKIP_STRIPE_EMULATOR_START=1 \
    SUPABASE_URL="$SUPABASE_URL" SUPABASE_ANON_KEY="$ANON_KEY" \
    bunx playwright test playwright/e2e/security-updates-ui-screenshots.spec.ts
}

# --- Before (stack base UI) ---
if [ -f "src/pages/app/[app].observe.security.vue" ]; then
  mv "src/pages/app/[app].observe.security.vue" "$RUN_DIR/head-security-page.vue"
fi
git checkout "$BASE_REF" -- src/pages/settings/account/Notifications.vue src/constants/observeTabs.ts

start_vite
sleep 3
run_playwright_phase before
stop_vite
sleep 2

# --- After (PR head UI) ---
git checkout HEAD -- src/pages/settings/account/Notifications.vue src/constants/observeTabs.ts
if [ -f "$RUN_DIR/head-security-page.vue" ]; then
  mv "$RUN_DIR/head-security-page.vue" "src/pages/app/[app].observe.security.vue"
fi

start_vite
sleep 3
run_playwright_phase after

ls -la "$OUTPUT_DIR"
