#!/usr/bin/env bash
set -euo pipefail

# Apply supabase/migrations/ to the vanilla Postgres 17 container from docker-compose.yml.
# Requires: Docker, docker compose, and the Supabase CLI (bunx supabase).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/vanilla-postgres-env.sh
source "$ROOT_DIR/scripts/vanilla-postgres-env.sh"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
SERVICE="${VANILLA_POSTGRES_SERVICE:-postgres}"

if [[ -n "${DATABASE_URL:-}" && -z "${VANILLA_POSTGRES_DATABASE_URL:-}" ]]; then
  echo "Refusing to use inherited DATABASE_URL for vanilla Postgres migrations." >&2
  echo "Unset DATABASE_URL or set VANILLA_POSTGRES_DATABASE_URL to opt in." >&2
  exit 1
fi

if [[ -n "${VANILLA_POSTGRES_DATABASE_URL:-}" ]]; then
  DATABASE_URL="$VANILLA_POSTGRES_DATABASE_URL"
else
  DATABASE_URL="$(bun -e 'const encode = encodeURIComponent; console.log(`postgresql://${encode(process.env.VANILLA_POSTGRES_USER)}:${encode(process.env.VANILLA_POSTGRES_PASSWORD)}@127.0.0.1:5432/${encode(process.env.VANILLA_POSTGRES_DB)}?sslmode=disable`)')"
fi

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

ensure_postgres() {
  if ! compose ps --status running --services 2>/dev/null | grep -qx "$SERVICE"; then
    echo "Starting vanilla Postgres ($SERVICE) from $COMPOSE_FILE ..."
    compose up -d "$SERVICE"
  fi

  echo "Waiting for Postgres to accept connections ..."
  for _ in $(seq 1 60); do
    if compose exec -T "$SERVICE" pg_isready -U "$VANILLA_POSTGRES_USER" -d "$VANILLA_POSTGRES_DB" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Postgres did not become ready in time." >&2
  exit 1
}

ensure_postgres

LOG_DIR="${ROOT_DIR}/.context/vanilla-postgres"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/db-push-$(date -u +%Y%m%dT%H%M%SZ).log"

echo "Applying migrations with: bunx supabase db push --db-url <redacted>"
echo "Full log: $LOG_FILE"

set +e
bunx supabase db push --db-url "$DATABASE_URL" 2>&1 | tee "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -e

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "All migrations applied successfully."
else
  echo "Migration apply failed (exit $EXIT_CODE). See $LOG_FILE for details."
fi

exit "$EXIT_CODE"
