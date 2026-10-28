#!/usr/bin/env bash
set -euo pipefail

# Point the existing subscription at the current source connection string
# (common.sh), for example to pick up options='-c statement_timeout=0' so an
# initial table copy longer than the role's statement_timeout can finish.
# ALTER SUBSCRIPTION ... CONNECTION restarts the apply and copy workers.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=read_replicate/common.sh
source "${SCRIPT_DIR}/common.sh"

load_replica_target
load_source
discover_subscription "capgo_google_$(replica_region_name)"

SAFE_CONNECTION_STRING="$(sql_literal_escape "$SOURCE_CONNECTION_STRING")"
echo "==> Updating connection of ${REPLICA_SUBSCRIPTION_NAME}..."
psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 \
  -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} CONNECTION '${SAFE_CONNECTION_STRING}';"
psql-17 "$REPLICA_TARGET_DB_URL" -P pager=off -c "
  SELECT c.relname, r.srsubstate
  FROM pg_subscription_rel r JOIN pg_class c ON c.oid = r.srrelid
  WHERE r.srsubstate <> 'r';"
echo "==> Done."
