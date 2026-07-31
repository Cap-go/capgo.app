#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=read_replicate/common.sh
source "${SCRIPT_DIR}/common.sh"

echo "==> Starting Supabase -> Google read-replica replication setup..."

load_replica_target
load_source

PUBLICATION_NAME="$(discover_publication_name)"
DEFAULT_SUBSCRIPTION_NAME="capgo_google_$(replica_region_name)"
discover_subscription "$DEFAULT_SUBSCRIPTION_NAME"
print_target_summary
echo "==> Publication: ${PUBLICATION_NAME}"

SUBSCRIPTION_ONLY=true
if [[ "${READ_REPLICA_FULL_RESET:-}" == "1" || "${READ_REPLICA_FULL_RESET:-}" == "true" ]]; then
  SUBSCRIPTION_ONLY=false
elif [[ "${READ_REPLICA_SUBSCRIPTION_ONLY:-}" == "1" || "${READ_REPLICA_SUBSCRIPTION_ONLY:-}" == "true" ]]; then
  SUBSCRIPTION_ONLY=true
elif [[ -t 0 ]]; then
  echo ""
  echo "Reset mode:"
  echo "  1) Subscription only (keeps data/schema, recreates subscription)"
  echo "  2) Full reset (drops replica-managed tables, imports schema/data, recreates subscription)"
  echo ""
  read -rp "Enter choice [1-2]: " RESET_CHOICE
  case "$RESET_CHOICE" in
    1) SUBSCRIPTION_ONLY=true ;;
    2) SUBSCRIPTION_ONLY=false ;;
    *) echo "Invalid choice"; exit 1 ;;
  esac
fi

SAFE_CONNECTION_STRING="$(sql_literal_escape "$SOURCE_CONNECTION_STRING")"

drop_target_subscription() {
  echo "==> Dropping target subscription ${REPLICA_SUBSCRIPTION_NAME} if present..."
  SUB_EXISTS=$(psql-17 "$REPLICA_TARGET_DB_URL" -t -A -c "
    SELECT 1
    FROM pg_subscription
    WHERE subname = '${REPLICA_SUBSCRIPTION_NAME}';
  " || true)

  if [[ -z "$SUB_EXISTS" ]]; then
    echo "    No target subscription named ${REPLICA_SUBSCRIPTION_NAME}"
    return 0
  fi

  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=0 -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} DISABLE;" || true
  sleep 2
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=0 -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} SET (slot_name = NONE);" || true
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=0 -c "DROP SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME};" || true
}

drop_source_slot() {
  echo "==> Dropping source slot ${REPLICA_SLOT_NAME} if present..."
  psql-17 "$SOURCE_DB_URL" -v ON_ERROR_STOP=0 <<SQL
DO \$\$
DECLARE
  slot record;
BEGIN
  SELECT slot_name, active, active_pid
  INTO slot
  FROM pg_replication_slots
  WHERE slot_name = '${REPLICA_SLOT_NAME}';

  IF slot.slot_name IS NOT NULL THEN
    RAISE NOTICE 'Found replication slot: % (active: %)', slot.slot_name, slot.active;

    IF slot.active AND slot.active_pid IS NOT NULL THEN
      PERFORM pg_terminate_backend(slot.active_pid);
      PERFORM pg_sleep(2);
    END IF;

    BEGIN
      PERFORM pg_drop_replication_slot(slot.slot_name);
      RAISE NOTICE 'Dropped slot: %', slot.slot_name;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not drop slot: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'No source slot named ${REPLICA_SLOT_NAME}';
  END IF;
END
\$\$;
SQL
}

source_slot_exists() {
  local exists
  exists=$(psql-17 "$SOURCE_DB_URL" -t -A -c "
    SELECT 1
    FROM pg_replication_slots
    WHERE slot_name = '${REPLICA_SLOT_NAME}';
  " || true)
  [[ -n "$exists" ]]
}

source_slot_is_lost() {
  local slot_status
  local wal_status
  local invalidation_reason

  slot_status=$(psql-17 "$SOURCE_DB_URL" -t -A -F '|' -c "
    SELECT COALESCE(wal_status, ''), COALESCE(invalidation_reason, '')
    FROM pg_replication_slots
    WHERE slot_name = '${REPLICA_SLOT_NAME}';
  " || true)
  wal_status="${slot_status%%|*}"
  invalidation_reason="${slot_status#*|}"

  [[ "$wal_status" == "lost" || "$invalidation_reason" == "wal_removed" ]]
}

ensure_source_slot_before_copy() {
  if source_slot_exists; then
    if source_slot_is_lost; then
      echo "==> Source slot ${REPLICA_SLOT_NAME} is lost; recreating before table copy."
      drop_source_slot
    else
      echo "==> Preserving existing source slot ${REPLICA_SLOT_NAME} before table copy."
      return 0
    fi
  fi

  echo "==> Creating source slot ${REPLICA_SLOT_NAME} before table copy..."
  psql-17 "$SOURCE_DB_URL" -v ON_ERROR_STOP=1 -c "SELECT pg_create_logical_replication_slot('${REPLICA_SLOT_NAME}', 'pgoutput');"
}

ensure_publication_tables() {
  echo "==> Ensuring source publication includes configured tables..."
  for table in "${REPLICA_TABLES[@]}"; do
    psql-17 "$SOURCE_DB_URL" -v ON_ERROR_STOP=0 <<SQL
DO \$\$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '${table}'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = '${PUBLICATION_NAME}'
      AND schemaname = 'public'
      AND tablename = '${table}'
  ) THEN
    EXECUTE 'ALTER PUBLICATION ${PUBLICATION_NAME} ADD TABLE public.${table}';
    RAISE NOTICE 'Added public.${table} to ${PUBLICATION_NAME}';
  ELSE
    RAISE NOTICE 'public.${table} already present or missing on source';
  END IF;
END
\$\$;
SQL
  done
}

create_subscription() {
  local create_slot="${1:-auto}"

  if [[ "$create_slot" == "auto" ]]; then
    if source_slot_exists; then
      if source_slot_is_lost; then
        echo "==> Source slot ${REPLICA_SLOT_NAME} is lost; dropping it before subscription creation."
        drop_source_slot
        create_slot=true
      else
        create_slot=false
      fi
    else
      create_slot=true
    fi
  fi

  echo "==> Creating subscription ${REPLICA_SUBSCRIPTION_NAME} using slot ${REPLICA_SLOT_NAME}..."
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 <<SQL
CREATE SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME}
CONNECTION '${SAFE_CONNECTION_STRING}'
PUBLICATION ${PUBLICATION_NAME}
WITH (
  slot_name = '${REPLICA_SLOT_NAME}',
  copy_data = false,
  create_slot = ${create_slot},
  enabled = true,
  disable_on_error = false
);
SQL
}

dump_table() {
  local table_name="$1"
  local expected_count="${2:-}"
  local dump_file="${DUMP_DIR}/${table_name}.csv.gz"
  local rows_file="${dump_file}.rows"

  echo "    [${table_name}] Dumping from source..."
  # manifest (and similar) exceed Supabase statement_timeout on a full COPY.
  # Do NOT validate dumps with wc -l: CSV fields can contain newlines.
  rm -f "$dump_file" "$rows_file"
  psql_no_timeout "$SOURCE_DB_URL" -v ON_ERROR_STOP=1 \
    -c "\COPY public.${table_name} TO STDOUT WITH (FORMAT csv, HEADER)" \
    | gzip > "$dump_file"

  if ! gzip -t "$dump_file" 2>/dev/null || [[ ! -s "$dump_file" ]]; then
    echo "Error: dump for ${table_name} is missing or corrupt"
    rm -f "$dump_file" "$rows_file"
    exit 1
  fi

  if [[ -n "$expected_count" ]]; then
    printf '%s\n' "$expected_count" > "$rows_file"
  fi

  echo "    [${table_name}] Dump complete: $(du -h "$dump_file" | cut -f1)"
}

table_count() {
  local url="$1"
  local table_name="$2"
  psql_no_timeout "$url" -t -A -v ON_ERROR_STOP=1 -c "
    SELECT COUNT(*)::bigint
    FROM public.${table_name};
  "
}

# Reuse dump only when gzip is healthy and sidecar row marker matches source count.
# Never use wc -l on CSV (embedded newlines break that check).
dump_reusable() {
  local table_name="$1"
  local expected="$2"
  local dump_file="${DUMP_DIR}/${table_name}.csv.gz"
  local rows_file="${dump_file}.rows"
  local marked

  [[ -f "$dump_file" && -f "$rows_file" ]] || return 1
  gzip -t "$dump_file" 2>/dev/null || return 1
  [[ -s "$dump_file" ]] || return 1
  marked=$(tr -d '[:space:]' < "$rows_file")
  [[ "$marked" == "$expected" ]]
}

restore_table() {
  local table_name="$1"
  local dump_file="${DUMP_DIR}/${table_name}.csv.gz"

  echo "    [${table_name}] Dropping non-constraint indexes..."
  psql-17 "$REPLICA_TARGET_DB_URL" -t -A -c "
    SELECT 'DROP INDEX IF EXISTS \"' || i.indexname || '\";'
    FROM pg_indexes i
    LEFT JOIN pg_constraint c ON c.conname = i.indexname
    WHERE i.tablename = '${table_name}'
      AND i.schemaname = 'public'
      AND i.indexname NOT LIKE '%_pkey'
      AND c.conname IS NULL;
  " | psql-17 "$REPLICA_TARGET_DB_URL" 2>/dev/null || true

  echo "    [${table_name}] Truncating and loading..."
  psql_no_timeout "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE TABLE public.${table_name};"
  gunzip -c "$dump_file" | psql_no_timeout "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 \
    -c "\COPY public.${table_name} FROM STDIN WITH (FORMAT csv, HEADER)"

  echo "    [${table_name}] Recreating indexes..."
  awk "/CREATE (UNIQUE )?INDEX.*ON public\.${table_name}/,/;/" "${SCRIPT_DIR}/schema_replicate.sql" \
    | awk 'BEGIN{RS=";"} /CREATE.*INDEX/{print $0 ";"}' \
    | while read -r idx_sql; do
      if [[ -n "$idx_sql" ]]; then
        psql_no_timeout "$REPLICA_TARGET_DB_URL" -c "$idx_sql" 2>/dev/null || true
      fi
    done

  COUNT=$(table_count "$REPLICA_TARGET_DB_URL" "$table_name")
  echo "    [${table_name}] Restored: ${COUNT} rows"
}

target_table_exists() {
  local table_name="$1"
  psql-17 "$REPLICA_TARGET_DB_URL" -t -A -c "SELECT to_regclass('public.${table_name}') IS NOT NULL;" | grep -q t
}

replica_schema_present() {
  local table
  for table in "${REPLICA_TABLES[@]}"; do
    target_table_exists "$table" || return 1
  done
  return 0
}

# Resume-friendly sync: skip when source/target counts already match.
# Reuse a complete dump file when present; otherwise dump then restore.
sync_table() {
  local table_name="$1"
  local source_count
  local target_count
  local source_after

  source_count=$(table_count "$SOURCE_DB_URL" "$table_name")
  if target_table_exists "$table_name"; then
    target_count=$(table_count "$REPLICA_TARGET_DB_URL" "$table_name")
  else
    target_count=-1
  fi

  if [[ "$target_count" == "$source_count" ]]; then
    echo "    [${table_name}] Already synced (${source_count} rows) — skipping"
    return 0
  fi

  echo "    [${table_name}] Needs sync (source=${source_count} target=${target_count})"

  if dump_reusable "$table_name" "$source_count"; then
    echo "    [${table_name}] Reusing dump marked for ${source_count} rows"
  else
    dump_table "$table_name" "$source_count"
  fi

  restore_table "$table_name"
  target_count=$(table_count "$REPLICA_TARGET_DB_URL" "$table_name")
  source_after=$(table_count "$SOURCE_DB_URL" "$table_name")

  # Accept snapshot match (pre-dump count) or live match (writes during copy).
  if [[ "$target_count" == "$source_count" || "$target_count" == "$source_after" ]]; then
    echo "    [${table_name}] Sync ok (target=${target_count} source_now=${source_after})"
    return 0
  fi

  echo "    [${table_name}] Count drift after restore (target=${target_count} snapshot=${source_count} source_now=${source_after}); retrying once"
  source_count="$source_after"
  dump_table "$table_name" "$source_count"
  restore_table "$table_name"
  target_count=$(table_count "$REPLICA_TARGET_DB_URL" "$table_name")
  source_after=$(table_count "$SOURCE_DB_URL" "$table_name")
  if [[ "$target_count" != "$source_count" && "$target_count" != "$source_after" ]]; then
    echo "Error: ${table_name} restore count ${target_count} != source ${source_after}"
    exit 1
  fi
}

drop_target_subscription

if [[ "$SUBSCRIPTION_ONLY" == "true" ]]; then
  echo "==> Subscription-only mode: leaving replica data/schema untouched."
  ensure_publication_tables
  create_subscription
else
  echo "==> Full reset mode: syncing missing/outdated replica tables (resumable)."
  ensure_publication_tables
  ensure_source_slot_before_copy

  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS public;
GRANT ALL ON SCHEMA public TO PUBLIC;
SQL

  DUMP_DIR="${SCRIPT_DIR}/dumps"
  mkdir -p "$DUMP_DIR"

  if replica_schema_present; then
    echo "==> Replica schema already present — skipping destructive schema reload (resume)."
  else
    echo "==> Applying replica schema (destructive first-time load)..."
    psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 -f "${SCRIPT_DIR}/schema_replicate.sql"
  fi

  echo "==> Syncing priority tables..."
  for table in "${REPLICA_PRIORITY_TABLES[@]}"; do
    if psql-17 "$SOURCE_DB_URL" -t -A -c "SELECT to_regclass('public.${table}') IS NOT NULL;" | grep -q t; then
      sync_table "$table"
    fi
  done

  echo "==> Syncing deferred tables..."
  for table in "${REPLICA_DEFERRED_TABLES[@]}"; do
    if psql-17 "$SOURCE_DB_URL" -t -A -c "SELECT to_regclass('public.${table}') IS NOT NULL;" | grep -q t; then
      sync_table "$table"
    fi
  done

  create_subscription false
fi

echo "==> Verifying subscription health..."
HEALTHY=false
for i in {1..12}; do
  STATUS_ROW=$(psql-17 "$REPLICA_TARGET_DB_URL" -t -A -F '|' -c "
    SELECT pid, received_lsn, last_msg_receipt_time
    FROM pg_stat_subscription
    WHERE subname = '${REPLICA_SUBSCRIPTION_NAME}';
  ")
  if [[ -n "$STATUS_ROW" ]]; then
    PID=$(echo "$STATUS_ROW" | cut -d'|' -f1)
    LAST_MSG=$(echo "$STATUS_ROW" | cut -d'|' -f3)
    if [[ -n "$PID" && "$PID" != "0" ]]; then
      echo "==> Subscription worker running: pid=${PID}, last_msg_receipt_time=${LAST_MSG:-none yet}"
      HEALTHY=true
      break
    fi
  fi
  echo "==> Waiting for subscription to become healthy... (${i}/12)"
  sleep 5
done

if [[ "$HEALTHY" != "true" ]]; then
  echo "Error: subscription did not reach healthy state within timeout."
  echo "Check with:"
  echo "psql-17 \"\$READ_REPLICA_DB_URL\" -c \"SELECT subname, pid, received_lsn, last_msg_receipt_time FROM pg_stat_subscription;\""
  exit 1
fi

echo "==> Done."
