#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=read_replicate/common.sh
source "${SCRIPT_DIR}/common.sh"

DUMP_FILE="schema_replicate.dump"
LIST_FILE="schema_replicate.list"
FILTERED_LIST="schema_replicate.filtered.list"
OUT_SQL="${OUT_SQL:-read_replicate/schema_replicate.sql}"
CATALOG_FILE="${CATALOG_FILE:-read_replicate/schema_replicate.catalog.json}"

PSQL_BIN="${PSQL_BIN:-$(command -v psql-17 || command -v psql || true)}"
PG_DUMP_BIN="${PG_DUMP_BIN:-$(command -v pg_dump-17 || command -v pg_dump || true)}"
PG_RESTORE_BIN="${PG_RESTORE_BIN:-$(command -v pg_restore-17 || command -v pg_restore || true)}"

if [[ -z "$PSQL_BIN" || -z "$PG_DUMP_BIN" || -z "$PG_RESTORE_BIN" ]]; then
  echo "Error: psql, pg_dump, and pg_restore are required to prepare read-replica schema." >&2
  exit 1
fi

replica_config_pattern() {
  local export_name="$1"

  REPLICA_SCHEMA_EXPORT="$export_name" bun --silent -e '
    import {
      REPLICA_EXCLUDED_INDEXES,
      REPLICA_FUNCTIONS,
      REPLICA_TYPES,
      replicaConfigPattern,
    } from "./read_replicate/schema_catalog.ts"

    const configs = {
      REPLICA_EXCLUDED_INDEXES,
      REPLICA_FUNCTIONS,
      REPLICA_TYPES,
    }
    const name = process.env.REPLICA_SCHEMA_EXPORT
    const values = name ? configs[name] : undefined
    if (!values) {
      console.error("Unknown read-replica schema config")
      process.exit(1)
    }
    console.log(replicaConfigPattern(values))
  '
}

DB_SB="$(load_source_db_url)"
echo "==> Dumping replica schema from Supabase source"

TABLE_ARGS=()
for table in "${REPLICA_TABLES[@]}"; do
  EXISTS=$("$PSQL_BIN" "$DB_SB" -t -A -c "
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = '${table}';
  " || true)
  if [[ -n "$EXISTS" ]]; then
    TABLE_ARGS+=("--table=${table}")
  else
    echo "==> Skipping missing table public.${table}"
  fi
done

if [[ ${#TABLE_ARGS[@]} -eq 0 ]]; then
  echo "Error: no configured replica tables were found in the source database." >&2
  exit 1
fi

# 1) Dump schema in custom format (includes everything, but we will filter on restore)
# Include custom types and tables
"$PG_DUMP_BIN" -Fc --schema-only \
  --no-owner --no-privileges --no-comments \
  "${TABLE_ARGS[@]}" \
  "$DB_SB" > "$DUMP_FILE"

# Also dump custom types (they're not included with --table flag)
TYPES_DUMP="types_replicate.dump"
"$PG_DUMP_BIN" -Fc --schema-only \
  --no-owner --no-privileges --no-comments \
  "$DB_SB" > "$TYPES_DUMP" 2>/dev/null || true

# 2) Create restore list
"$PG_RESTORE_BIN" -l "$DUMP_FILE" > "$LIST_FILE"

# 3) Filter out things you DON'T want, keep indexes
#    - FK CONSTRAINT: remove foreign keys
#    - TRIGGER: remove triggers
#    - POLICY: remove RLS policies
#    - ROW SECURITY: removes ALTER TABLE ... ENABLE ROW LEVEL SECURITY (wording varies by pg_dump version)
REPLICA_EXCLUDED_INDEX_PATTERN="$(replica_config_pattern REPLICA_EXCLUDED_INDEXES)"
export REPLICA_EXCLUDED_INDEX_PATTERN
perl -ne '
  next if /\bFK CONSTRAINT\b/;
  next if /\bTRIGGER\b/;
  next if /\bPOLICY\b/;
  next if /\bROW SECURITY\b/;
  next if /\bINDEX\b/ && ($ENV{REPLICA_EXCLUDED_INDEX_PATTERN} // "") ne "" && /$ENV{REPLICA_EXCLUDED_INDEX_PATTERN}/;
  print;
' "$LIST_FILE" > "$FILTERED_LIST"

# 4) Restore to SQL using the filtered list (this includes indexes)
"$PG_RESTORE_BIN" -f - --no-owner --no-privileges --no-comments \
  -L "$FILTERED_LIST" \
  "$DUMP_FILE" > "$OUT_SQL"

# 4b) Extract and add custom types and required functions from full dump
if [[ -f "$TYPES_DUMP" ]]; then
  echo "==> Extracting custom types and functions..."
  TYPES_LIST="types_replicate.list"
  TYPES_FILTERED_LIST="types_replicate.filtered.list"
  TYPES_SQL="types_replicate.sql"
  
  # Create restore list for types dump
  "$PG_RESTORE_BIN" -l "$TYPES_DUMP" > "$TYPES_LIST" 2>/dev/null || true
  
  # Filter to only include the types and functions we need
  if [[ -f "$TYPES_LIST" ]]; then
    REPLICA_TYPE_PATTERN="$(replica_config_pattern REPLICA_TYPES)"
    REPLICA_FUNCTION_PATTERN="$(replica_config_pattern REPLICA_FUNCTIONS)"

    # Extract types
    if [[ -n "$REPLICA_TYPE_PATTERN" ]]; then
      grep -E '\bTYPE\b' "$TYPES_LIST" | \
        grep -E "$REPLICA_TYPE_PATTERN" > "$TYPES_FILTERED_LIST" || true
    else
      : > "$TYPES_FILTERED_LIST"
    fi
    
    # Also extract the functions required by replica table defaults
    if [[ -n "$REPLICA_FUNCTION_PATTERN" ]]; then
      grep -E '\bFUNCTION\b' "$TYPES_LIST" | \
        grep -E "$REPLICA_FUNCTION_PATTERN" >> "$TYPES_FILTERED_LIST" || true
    fi
    
    if [[ -s "$TYPES_FILTERED_LIST" ]]; then
      # Restore only the filtered types and functions to SQL
      "$PG_RESTORE_BIN" -f - --no-owner --no-privileges --no-comments \
        -L "$TYPES_FILTERED_LIST" \
        "$TYPES_DUMP" > "$TYPES_SQL" 2>/dev/null || true
      
      if [[ -s "$TYPES_SQL" ]]; then
        # Prepend types and functions to output SQL
        cat "$TYPES_SQL" "$OUT_SQL" > "${OUT_SQL}.tmp"
        mv "${OUT_SQL}.tmp" "$OUT_SQL"
        echo "==> Added custom types and functions to SQL file"
      fi
    fi
    rm -f "$TYPES_LIST" "$TYPES_FILTERED_LIST" "$TYPES_SQL"
  fi
  rm -f "$TYPES_DUMP"
fi

# 5) Drop pg_dump SET noise and psql-only restrict wrappers.
perl -0777 -i -pe '
  s/^SET[^\n]*\n//mg;
  s/^SELECT pg_catalog\.set_config\([^\n]*\);\n//mg;
  s/^\\(?:un)?restrict\b[^\n]*\n//mg;
  s/^-- Dumped from database version[^\n]*\n//mg;
  s/^-- Dumped by pg_dump version[^\n]*\n//mg;
  s/^-- PostgreSQL database dump(?: complete)?\n//mg;
  s/\n{4,}/\n\n\n/g;
' "$OUT_SQL"

# 6) Wrap the full schema restore in one transaction and reset only the
# replica-managed objects. Do not drop the public schema; target databases can
# have grants/extensions/objects that are unrelated to this replica import.
{
  printf 'BEGIN;\n\n'
  printf 'DROP TABLE IF EXISTS public.channel_devices, public.manifest, public.onboarding_demo_data, public.app_versions, public.channels, public.apps, public.notifications, public.org_users, public.orgs, public.stripe_info CASCADE;\n'
  printf 'DROP SEQUENCE IF EXISTS public.app_versions_id_seq, public.channel_devices_id_seq, public.channel_id_seq, public.manifest_id_seq, public.org_users_id_seq, public.stripe_info_id_seq CASCADE;\n'
  printf 'DROP FUNCTION IF EXISTS public.one_month_ahead();\n'
  printf 'DROP TYPE IF EXISTS public.manifest_entry, public.disable_update, public.stripe_status;\n\n'
  cat "$OUT_SQL"
  printf '\nCOMMIT;\n'
} > "${OUT_SQL}.tmp"
mv "${OUT_SQL}.tmp" "$OUT_SQL"

# 7) Sanity checks (should be empty; indexes should still exist)
echo "==> Should be empty:"
grep -nE 'CREATE POLICY|ROW LEVEL SECURITY|FK CONSTRAINT|FOREIGN KEY|CREATE TRIGGER|^\\(un)?restrict([[:space:]]|$)' "$OUT_SQL" || true

echo "==> Index count:"
grep -cE '^\s*CREATE (UNIQUE )?INDEX\b' "$OUT_SQL" || true
# 8) Cleanup temporary files
echo "==> Cleaning up temporary files..."
rm -f "$DUMP_FILE" "$LIST_FILE" "$FILTERED_LIST" "$TYPES_DUMP" "$TYPES_SQL" 2>/dev/null || true
echo "==> Writing catalog snapshot..."
MAIN_SUPABASE_DB_URL="$DB_SB" bun scripts/write-read-replica-schema-catalog.ts "$CATALOG_FILE"
echo "==> Done. Output: $OUT_SQL"
