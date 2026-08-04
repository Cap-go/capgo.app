#!/usr/bin/env bash
set -euo pipefail

# Re-sync one table on the single Google read-replica subscriber.
# Usage: ./replicate_add_table.sh <table_name>

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=read_replicate/common.sh
source "${SCRIPT_DIR}/common.sh"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <table_name>"
  echo "Example: $0 channels"
  exit 1
fi

TABLE_NAME="$1"
validate_public_identifier "$TABLE_NAME" "table name"
DUMP_DIR="${SCRIPT_DIR}/dumps"
mkdir -p "$DUMP_DIR"

load_replica_target
load_source

PUBLICATION_NAME="$(discover_publication_name)"
DEFAULT_SUBSCRIPTION_NAME="capgo_google_$(replica_region_name)"
discover_subscription "$DEFAULT_SUBSCRIPTION_NAME"
print_target_summary
echo "==> Publication: ${PUBLICATION_NAME}"
echo "==> Re-syncing table: public.${TABLE_NAME}"

SAFE_CONNECTION_STRING="$(sql_literal_escape "$SOURCE_CONNECTION_STRING")"
SOURCE_SLOT_STATUS=$(psql-17 "$SOURCE_DB_URL" -t -A -F '|' -c "
  SELECT COALESCE(wal_status, ''), COALESCE(invalidation_reason, '')
  FROM pg_replication_slots
  WHERE slot_name = '${REPLICA_SLOT_NAME}';
" || true)
SOURCE_SLOT_WAL_STATUS="${SOURCE_SLOT_STATUS%%|*}"
SOURCE_SLOT_INVALIDATION_REASON="${SOURCE_SLOT_STATUS#*|}"
SOURCE_SLOT_LOST=false
if [[ "$SOURCE_SLOT_WAL_STATUS" == "lost" || "$SOURCE_SLOT_INVALIDATION_REASON" == "wal_removed" ]]; then
  SOURCE_SLOT_LOST=true
  echo "==> Source slot is lost (${SOURCE_SLOT_WAL_STATUS}/${SOURCE_SLOT_INVALIDATION_REASON}); this run will recreate subscription and slot after copy."
fi

TABLE_EXISTS=$(psql-17 "$SOURCE_DB_URL" -t -A -c "
  SELECT 1
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name = '${TABLE_NAME}';
" || true)

if [[ -z "$TABLE_EXISTS" ]]; then
  echo "ERROR: public.${TABLE_NAME} does not exist in source database."
  exit 1
fi

echo "==> Ensuring public.${TABLE_NAME} is in source publication..."
psql-17 "$SOURCE_DB_URL" -v ON_ERROR_STOP=0 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = '${PUBLICATION_NAME}'
      AND schemaname = 'public'
      AND tablename = '${TABLE_NAME}'
  ) THEN
    EXECUTE 'ALTER PUBLICATION ${PUBLICATION_NAME} ADD TABLE public.${TABLE_NAME}';
    RAISE NOTICE 'Added public.${TABLE_NAME} to ${PUBLICATION_NAME}';
  ELSE
    RAISE NOTICE 'public.${TABLE_NAME} already in ${PUBLICATION_NAME}';
  END IF;
END
\$\$;
SQL

DUMP_FILE="${DUMP_DIR}/${TABLE_NAME}.csv.gz"
SCHEMA_FILE="${DUMP_DIR}/${TABLE_NAME}_schema.sql"

echo "==> Exporting source data..."
psql_no_timeout "$SOURCE_DB_URL" -v ON_ERROR_STOP=1 -c "\\COPY public.${TABLE_NAME} TO STDOUT WITH (FORMAT csv, HEADER)" | gzip > "$DUMP_FILE"
ROW_COUNT=$(gunzip -c "$DUMP_FILE" | wc -l | tr -d ' ')
ROW_COUNT=$((ROW_COUNT - 1))
echo "    Exported ${ROW_COUNT} rows."

echo "==> Extracting source table schema..."
psql-17 "$SOURCE_DB_URL" -t -A -c "
SELECT 'CREATE TABLE public.${TABLE_NAME} (' || string_agg(
  quote_ident(column_name) || ' ' ||
  CASE
    WHEN data_type = 'ARRAY' THEN udt_name
    WHEN data_type = 'USER-DEFINED' THEN udt_schema || '.' || udt_name
    ELSE data_type
  END ||
  CASE WHEN character_maximum_length IS NOT NULL THEN '(' || character_maximum_length || ')' ELSE '' END ||
  CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
  CASE WHEN column_default IS NOT NULL THEN ' DEFAULT ' || column_default ELSE '' END,
  ', ' ORDER BY ordinal_position
) || ');'
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = '${TABLE_NAME}';
" > "$SCHEMA_FILE"

echo "ALTER TABLE ONLY public.${TABLE_NAME} REPLICA IDENTITY FULL;" >> "$SCHEMA_FILE"

PK_COLUMNS=$(psql-17 "$SOURCE_DB_URL" -t -A -c "
SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY array_position(i.indkey, a.attnum))
FROM pg_index i
JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
WHERE i.indrelid = 'public.${TABLE_NAME}'::regclass
  AND i.indisprimary;
")

if [[ -n "$PK_COLUMNS" ]]; then
  echo "ALTER TABLE ONLY public.${TABLE_NAME} ADD CONSTRAINT ${TABLE_NAME}_pkey PRIMARY KEY (${PK_COLUMNS});" >> "$SCHEMA_FILE"
fi

psql-17 "$SOURCE_DB_URL" -t -A -c "
SELECT pg_get_indexdef(i.indexrelid) || ';'
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = 'public.${TABLE_NAME}'::regclass
  AND NOT i.indisprimary
  AND c.relname NOT LIKE '%_pkey';
" >> "$SCHEMA_FILE"

echo "==> Disabling subscription while table is reloaded..."
psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} DISABLE;"

cleanup_enable_subscription() {
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=0 -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} ENABLE;" >/dev/null 2>&1 || true
}
trap cleanup_enable_subscription EXIT

TABLE_EXISTS_TARGET=$(psql-17 "$REPLICA_TARGET_DB_URL" -t -A -c "
  SELECT 1
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name = '${TABLE_NAME}';
" 2>/dev/null || true)

if [[ -n "$TABLE_EXISTS_TARGET" ]]; then
  echo "==> Truncating target public.${TABLE_NAME}..."
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE TABLE public.${TABLE_NAME};"
else
  echo "==> Creating target public.${TABLE_NAME}..."
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 -f "$SCHEMA_FILE"
fi

echo "==> Importing source data into target..."
gunzip -c "$DUMP_FILE" | psql_no_timeout "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "\\COPY public.${TABLE_NAME} FROM STDIN WITH (FORMAT csv, HEADER)"

IMPORTED_COUNT=$(psql-17 "$REPLICA_TARGET_DB_URL" -t -A -c "SELECT COUNT(*) FROM public.${TABLE_NAME};")
echo "    Imported ${IMPORTED_COUNT} rows."

trap - EXIT

if [[ "$SOURCE_SLOT_LOST" == "true" ]]; then
  echo "==> Recreating lost subscription and slot..."
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=0 -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} SET (slot_name = NONE);" || true
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=0 -c "DROP SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME};" || true
  psql-17 "$SOURCE_DB_URL" -v ON_ERROR_STOP=0 -c "SELECT pg_drop_replication_slot('${REPLICA_SLOT_NAME}') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '${REPLICA_SLOT_NAME}');" || true
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 <<SQL
CREATE SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME}
CONNECTION '${SAFE_CONNECTION_STRING}'
PUBLICATION ${PUBLICATION_NAME}
WITH (
  slot_name = '${REPLICA_SLOT_NAME}',
  copy_data = false,
  create_slot = true,
  enabled = true,
  disable_on_error = false
);
SQL
else
  echo "==> Re-enabling subscription..."
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} ENABLE;"

  echo "==> Refreshing subscription publication..."
  psql-17 "$REPLICA_TARGET_DB_URL" -v ON_ERROR_STOP=1 -c "ALTER SUBSCRIPTION ${REPLICA_SUBSCRIPTION_NAME} REFRESH PUBLICATION WITH (copy_data = false);"
fi

echo "==> Subscription table state:"
psql-17 "$REPLICA_TARGET_DB_URL" -c "
  SELECT srrelid::regclass AS table_name, srsubstate
  FROM pg_subscription_rel
  WHERE srrelid = 'public.${TABLE_NAME}'::regclass;
"

echo "==> Done."
