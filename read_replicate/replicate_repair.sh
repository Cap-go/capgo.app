#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=read_replicate/common.sh
source "${SCRIPT_DIR}/common.sh"

load_replica_target
load_source

SOURCE_DB_URL="$SOURCE_DB_URL" REPLICA_TARGET_DB_URL="$REPLICA_TARGET_DB_URL" \
  exec bun "${SCRIPT_DIR}/replicate_repair.ts" "$@"
