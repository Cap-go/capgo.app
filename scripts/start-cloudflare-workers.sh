#!/usr/bin/env bash

# Script to start Cloudflare Workers for testing
# This script starts all workers (API, Plugin, Files) in the background

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Starting Cloudflare Workers for testing..."

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

run_supabase_status_env() {
  # Prefer the repo wrapper so worktrees get isolated Supabase stacks.
  if command -v bun >/dev/null 2>&1; then
    if bun run supabase:status -- -o env 2>/dev/null; then
      return 0
    fi
  fi

  # A scoped job must never discover another job's default Supabase stack.
  if [[ -n "${SUPABASE_WORKTREE_INSTANCE:-}" || -n "${SUPABASE_WORKTREE_PORT_OFFSET:-}" ]]; then
    return 1
  fi

  # Legacy fallback for unscoped developer commands.
  if command -v supabase >/dev/null 2>&1; then
    supabase status -o env 2>/dev/null && return 0
  fi
  bunx supabase status -o env 2>/dev/null && return 0
  return 1
}

# Extract a single variable from `supabase status -o env`, preserving any '=' in values (JWT padding).
get_supabase_status_var() {
  local key_regex="$1"
  # Output looks like: KEY="value" or KEY=value
  printf '%s\n' "${SUPA_ENV}" \
    | grep -E "^(${key_regex})=" \
    | head -n 1 \
    | sed -E 's/^[^=]+=//' \
    | sed -E 's/^"//; s/"$//'
}

# Build a runtime env file with local Supabase keys so we don't commit secrets.
BASE_ENV_FILE="${ROOT_DIR}/cloudflare_workers/.env.local"
RUNTIME_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/capgo-cloudflare-env.XXXXXX")"
chmod 600 "${RUNTIME_ENV_FILE}"
if [ -f "${BASE_ENV_FILE}" ]; then
  cp "${BASE_ENV_FILE}" "${RUNTIME_ENV_FILE}"
else
  echo -e "${YELLOW}Warning: ${BASE_ENV_FILE} not found - starting with empty base env${NC}"
fi

SUPA_ENV="$(run_supabase_status_env || true)"
SUPABASE_URL_FROM_STATUS="$(get_supabase_status_var 'API_URL')"
SUPABASE_DB_URL_FROM_STATUS="$(get_supabase_status_var 'DB_URL')"
# Supabase CLI has historically emitted either SERVICE_ROLE_KEY/ANON_KEY or SECRET_KEY/PUBLISHABLE_KEY.
SUPABASE_SERVICE_ROLE_KEY_FROM_STATUS="$(get_supabase_status_var 'SERVICE_ROLE_KEY|SECRET_KEY')"
SUPABASE_ANON_KEY_FROM_STATUS="$(get_supabase_status_var 'ANON_KEY|PUBLISHABLE_KEY')"

# Allow overrides via environment, otherwise use supabase status output.
SUPABASE_URL="${SUPABASE_URL:-${SUPABASE_URL_FROM_STATUS}}"
SUPABASE_DB_URL="${SUPABASE_DB_URL:-${SUPABASE_DB_URL_FROM_STATUS}}"
MAIN_SUPABASE_DB_URL="${MAIN_SUPABASE_DB_URL:-${SUPABASE_DB_URL_FROM_STATUS}}"
LOCAL_READ_REPLICA_SUPABASE_DB_URL="${LOCAL_READ_REPLICA_SUPABASE_DB_URL:-${SUPABASE_DB_URL}}"
SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_ROLE_KEY_FROM_STATUS}}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-${SUPABASE_ANON_KEY_FROM_STATUS}}"

if [ -z "${SUPABASE_SERVICE_ROLE_KEY}" ] || [ -z "${SUPABASE_ANON_KEY}" ] || [ -z "${SUPABASE_URL}" ] || [ -z "${SUPABASE_DB_URL}" ] || [ -z "${MAIN_SUPABASE_DB_URL}" ]; then
  echo -e "${YELLOW}Missing Supabase keys for Cloudflare Workers.${NC}"
  echo "Ensure Supabase is running, or set SUPABASE_URL, SUPABASE_DB_URL, MAIN_SUPABASE_DB_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY in your environment."
  exit 1
fi

# Cloudflare local testing defaults. Each isolated test process gets its own port
# band, while a zero offset preserves the familiar local endpoints.
WORKER_PORT_OFFSET="${CLOUDFLARE_WORKER_PORT_OFFSET:-0}"
if ! [[ "${WORKER_PORT_OFFSET}" =~ ^[0-9]+$ ]]; then
  echo "CLOUDFLARE_WORKER_PORT_OFFSET must be a non-negative integer." >&2
  exit 1
fi
WORKER_PORT_OFFSET=$((10#${WORKER_PORT_OFFSET}))
if (( WORKER_PORT_OFFSET > 50000 )); then
  echo "CLOUDFLARE_WORKER_PORT_OFFSET is too large." >&2
  exit 1
fi

CLOUDFLARE_API_PORT=$((8787 + WORKER_PORT_OFFSET))
CLOUDFLARE_PLUGIN_PORT=$((8788 + WORKER_PORT_OFFSET))
CLOUDFLARE_FILES_PORT=$((8789 + WORKER_PORT_OFFSET))
CLOUDFLARE_FUNCTION_URL="${CLOUDFLARE_FUNCTION_URL:-http://127.0.0.1:${CLOUDFLARE_API_PORT}}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-testsecret}"
API_INSPECTOR_PORT="${API_INSPECTOR_PORT:-$((9230 + WORKER_PORT_OFFSET))}"
PLUGIN_INSPECTOR_PORT="${PLUGIN_INSPECTOR_PORT:-$((9231 + WORKER_PORT_OFFSET))}"
FILES_INSPECTOR_PORT="${FILES_INSPECTOR_PORT:-$((9232 + WORKER_PORT_OFFSET))}"

if [[ -n "${CLOUDFLARE_PERSIST_DIR:-}" ]]; then
  PERSIST_DIR="${CLOUDFLARE_PERSIST_DIR}"
  if [[ "${PERSIST_DIR}" != /* ]]; then
    PERSIST_DIR="${ROOT_DIR}/${PERSIST_DIR}"
  fi
elif (( WORKER_PORT_OFFSET == 0 )); then
  PERSIST_DIR="${ROOT_DIR}/.wrangler-shared"
else
  PERSIST_DIR="${ROOT_DIR}/.wrangler-shared-${WORKER_PORT_OFFSET}"
fi
mkdir -p "${PERSIST_DIR}"

# Route worker S3 calls through the selected isolated Supabase API endpoint.
S3_ENDPOINT_TO_USE="${S3_ENDPOINT:-${SUPABASE_URL%/}/storage/v1/s3}"

API_PID=''
PLUGIN_PID=''
FILES_PID=''
cleanup() {
  local pid
  echo -e "\n${YELLOW}Stopping workers...${NC}"
  for pid in "${API_PID}" "${PLUGIN_PID}" "${FILES_PID}"; do
    if [[ -z "${pid}" ]]; then
      continue
    fi
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
    wait "${pid}" 2>/dev/null || true
  done
  rm -f "${RUNTIME_ENV_FILE}" 2>/dev/null || true
  echo -e "${GREEN}All workers stopped${NC}"
}
trap cleanup EXIT INT TERM

cat >> "${RUNTIME_ENV_FILE}" <<ENV_EOF
MAIN_SUPABASE_DB_URL=${MAIN_SUPABASE_DB_URL}
SUPABASE_DB_URL=${SUPABASE_DB_URL}
LOCAL_READ_REPLICA_SUPABASE_DB_URL=${LOCAL_READ_REPLICA_SUPABASE_DB_URL}
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
CLOUDFLARE_FUNCTION_URL=${CLOUDFLARE_FUNCTION_URL}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
S3_ENDPOINT=${S3_ENDPOINT_TO_USE}
# Worker requests must keep the isolated Storage API host instead of their own host.
S3_REWRITE_LOCAL_ENDPOINT=false
RATE_LIMIT_API_KEY=999999
RATE_LIMIT_FAILED_AUTH=999999
RATE_LIMIT_CHANNEL_SELF_IP=999999
ENV_EOF

# Start API worker on its isolated port.
echo -e "${GREEN}Starting API worker on port ${CLOUDFLARE_API_PORT}...${NC}"
(cd "${ROOT_DIR}/cloudflare_workers/api" && exec bunx wrangler dev --local -c wrangler.jsonc --port "${CLOUDFLARE_API_PORT}" --inspector-port "${API_INSPECTOR_PORT}" --env-file="${RUNTIME_ENV_FILE}" --env=local --persist-to "${PERSIST_DIR}") &
API_PID=$!

# Wait a bit for the first worker to start.
sleep 3

# Start Plugin worker on its isolated port.
echo -e "${GREEN}Starting Plugin worker on port ${CLOUDFLARE_PLUGIN_PORT}...${NC}"
(cd "${ROOT_DIR}/cloudflare_workers/plugin" && exec bunx wrangler dev --local -c wrangler.jsonc --port "${CLOUDFLARE_PLUGIN_PORT}" --inspector-port "${PLUGIN_INSPECTOR_PORT}" --env-file="${RUNTIME_ENV_FILE}" --env=local --persist-to "${PERSIST_DIR}") &
PLUGIN_PID=$!

# Wait a bit for the second worker to start.
sleep 3

# Start Files worker on its isolated port.
echo -e "${GREEN}Starting Files worker on port ${CLOUDFLARE_FILES_PORT}...${NC}"
(cd "${ROOT_DIR}/cloudflare_workers/files" && exec bunx wrangler dev --local -c wrangler.jsonc --port "${CLOUDFLARE_FILES_PORT}" --inspector-port "${FILES_INSPECTOR_PORT}" --env-file="${RUNTIME_ENV_FILE}" --env=local --persist-to "${PERSIST_DIR}") &
FILES_PID=$!

echo -e "${GREEN}All workers started!${NC}"
echo "API Worker PID: ${API_PID} (http://127.0.0.1:${CLOUDFLARE_API_PORT})"
echo "Plugin Worker PID: ${PLUGIN_PID} (http://127.0.0.1:${CLOUDFLARE_PLUGIN_PORT})"
echo "Files Worker PID: ${FILES_PID} (http://127.0.0.1:${CLOUDFLARE_FILES_PORT})"
echo ""
echo "Press Ctrl+C to stop all workers"

# Wait for all background processes.
wait
