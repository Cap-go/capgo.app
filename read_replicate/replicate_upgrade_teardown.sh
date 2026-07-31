#!/usr/bin/env bash
set -euo pipefail

# Drop the Capgo Google EU2 subscription + source slot so Supabase can upgrade.
# Loads DB URLs from internal/cloudflare/.env.prod. No env exports required.
# Exits nonzero unless subscription and source slot are verified gone.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=read_replicate/common.sh
source "${SCRIPT_DIR}/common.sh"

echo "==> Preparing Capgo-EU for Supabase Postgres upgrade (teardown replication)..."

load_replica_target
load_source

PUBLICATION_NAME="$(discover_publication_name)"
DEFAULT_SUBSCRIPTION_NAME="capgo_google_$(replica_region_name)"
discover_subscription "$DEFAULT_SUBSCRIPTION_NAME"
print_target_summary
echo "==> Publication: ${PUBLICATION_NAME}"

echo "==> Dropping target subscription ${REPLICA_SUBSCRIPTION_NAME} if present..."
SUB_EXISTS=$(psql-17 "$REPLICA_TARGET_DB_URL" -t -A -v ON_ERROR_STOP=1 -c "
  SELECT 1
  FROM pg_subscription
  WHERE subname = '${REPLICA_SUBSCRIPTION_NAME}';
")

if [[ -n "$SUB_EXISTS" ]]; then
  # DISABLE / detach slot may already be done; ignore those, but DROP must succeed.
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=0 -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} DISABLE;" || true
  sleep 2
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=0 -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} SET (slot_name = NONE);" || true
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "DROP SUBSCRIPTION IF EXISTS ${REPLICA_SUBSCRIPTION_NAME};"
  echo "    Dropped subscription ${REPLICA_SUBSCRIPTION_NAME}"
else
  echo "    No target subscription named ${REPLICA_SUBSCRIPTION_NAME}"
fi

echo "==> Verifying subscription is gone on target..."
SUB_REMAINING=$(psql-17 "$REPLICA_TARGET_DB_URL" -t -A -v ON_ERROR_STOP=1 -c "
  SELECT subname
  FROM pg_subscription
  WHERE subname = '${REPLICA_SUBSCRIPTION_NAME}';
")
if [[ -n "$SUB_REMAINING" ]]; then
  echo "Error: subscription ${REPLICA_SUBSCRIPTION_NAME} still exists on target. Fix before upgrading."
  exit 1
fi

echo "==> Dropping source slot ${REPLICA_SLOT_NAME} if present..."
# Walsender can stay attached briefly after subscription drop; terminate + retry
# until inactive, then drop. A single terminate+2s sleep is not enough in prod.
psql-17 "$SOURCE_DB_URL" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  slot record;
  attempt int := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    SELECT slot_name, active, active_pid
    INTO slot
    FROM pg_replication_slots
    WHERE slot_name = '${REPLICA_SLOT_NAME}';

    IF slot.slot_name IS NULL THEN
      RAISE NOTICE 'No source slot named ${REPLICA_SLOT_NAME}';
      RETURN;
    END IF;

    IF NOT COALESCE(slot.active, false) THEN
      PERFORM pg_drop_replication_slot(slot.slot_name);
      RAISE NOTICE 'Dropped slot: %', slot.slot_name;
      RETURN;
    END IF;

    RAISE NOTICE 'Slot % still active (pid %, attempt %/15)', slot.slot_name, slot.active_pid, attempt;

    IF slot.active_pid IS NOT NULL THEN
      PERFORM pg_terminate_backend(slot.active_pid);
    END IF;

    IF attempt >= 15 THEN
      RAISE EXCEPTION 'replication slot % still active for PID % after % attempts',
        slot.slot_name, slot.active_pid, attempt;
    END IF;

    PERFORM pg_sleep(2);
  END LOOP;
END
\$\$;
SQL

echo "==> Verifying slot is gone on source..."
REMAINING=$(psql-17 "$SOURCE_DB_URL" -t -A -v ON_ERROR_STOP=1 -c "
  SELECT slot_name
  FROM pg_replication_slots
  WHERE slot_name = '${REPLICA_SLOT_NAME}';
")

if [[ -n "$REMAINING" ]]; then
  echo "Error: slot ${REPLICA_SLOT_NAME} still exists. Fix before upgrading."
  exit 1
fi

echo ""
echo "Teardown complete. Next:"
echo "  1) Run the Supabase Postgres upgrade in the Capgo-EU dashboard"
echo "  2) After the project is healthy: bun run readreplicate:upgrade:reconnect"
echo "  3) Verify: bun run readreplicate:status"
