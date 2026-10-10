#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/vanilla-postgres-env.sh
source "$ROOT_DIR/scripts/vanilla-postgres-env.sh"
cd "$ROOT_DIR"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
SERVICE="${VANILLA_POSTGRES_SERVICE:-postgres}"

docker compose -f "$COMPOSE_FILE" up -d "$SERVICE"
