#!/usr/bin/env bash

# Shared helpers for Capgo read-replica maintenance.
# The current topology has one Google Cloud SQL subscriber from Supabase. Google
# handles replication from that instance to downstream regional replicas.

REPLICA_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPLICA_ENV_FILE="${REPLICA_ENV_FILE:-${REPLICA_SCRIPT_DIR}/../internal/cloudflare/.env.prod}"

REPLICA_TABLES=(
  "orgs"
  "stripe_info"
  "org_users"
  "apps"
  "app_versions"
  "channels"
  "channel_devices"
  "manifest"
  "notifications"
  "onboarding_demo_data"
)

REPLICA_PRIORITY_TABLES=(
  "orgs"
  "stripe_info"
  "org_users"
  "apps"
  "app_versions"
  "channels"
  "notifications"
  "onboarding_demo_data"
)

REPLICA_DEFERRED_TABLES=(
  "channel_devices"
  "manifest"
)

ensure_env_file() {
  if [[ ! -f "$REPLICA_ENV_FILE" ]]; then
    echo "Error: $REPLICA_ENV_FILE not found"
    exit 1
  fi
}

get_env_value() {
  local key="$1"
  local line

  if [[ -n "${!key:-}" ]]; then
    echo "${!key}"
    return 0
  fi

  ensure_env_file
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" ]] && continue
    [[ "${line:0:1}" == "#" ]] && continue
    if [[ "$line" == "${key}="* ]]; then
      echo "${line#*=}"
      return 0
    fi
  done < "$REPLICA_ENV_FILE"

  return 1
}

ensure_sslrootcert_system() {
  local url="$1"
  if [[ "$url" == *"sslmode=require"* ]]; then
    printf "%s" "$url"
    return 0
  fi
  if [[ "$url" == *"sslrootcert="* ]]; then
    printf "%s" "$url"
    return 0
  fi
  if [[ "$url" == *"?"* ]]; then
    printf "%s" "${url}&sslrootcert=system"
  else
    printf "%s" "${url}?sslrootcert=system"
  fi
}

ensure_connect_timeout() {
  local url="$1"
  local timeout="${2:-10}"

  if [[ "$url" == *"connect_timeout="* ]]; then
    printf "%s" "$url"
  elif [[ "$url" == *"?"* ]]; then
    printf "%s&connect_timeout=%s" "$url" "$timeout"
  else
    printf "%s?connect_timeout=%s" "$url" "$timeout"
  fi
}

normalize_cloudsql_ssl() {
  local url="$1"
  if [[ "$url" == *"sslmode=no-verify"* ]]; then
    echo "==> WARNING: PostgreSQL 17 rejects sslmode=no-verify." >&2
    echo "==> Downgrading this connection to sslmode=require for this command." >&2
    printf "%s" "${url/sslmode=no-verify/sslmode=require}"
    return 0
  fi
  if [[ "$url" == *"sslmode=verify-full"* ]]; then
    echo "==> WARNING: Google Cloud SQL URLs using IP hosts usually fail with sslmode=verify-full." >&2
    echo "==> Downgrading this connection to sslmode=require for this command." >&2
    printf "%s" "${url/sslmode=verify-full/sslmode=require}"
    return 0
  fi
  printf "%s" "$url"
}

extract_host() {
  local url="$1"
  echo "$url" | sed -E 's|.*@([^/:?]+).*|\1|'
}

sanitize_identifier_part() {
  local value="$1"
  value="${value//-/_}"
  value="${value//[^A-Za-z0-9_]/_}"
  printf '%s' "$value" | tr '[:upper:]' '[:lower:]'
}

uri_decode() {
  perl -e 'my $s = shift; $s =~ tr/+/ /; $s =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/eg; print $s;' "$1"
}

libpq_escape_value() {
  local value="$1"
  local escaped_quote
  escaped_quote=$'\\\''
  value="${value//\\/\\\\}"
  value="${value//\'/$escaped_quote}"
  printf "'%s'" "$value"
}

sql_literal_escape() {
  local value="$1"
  printf "%s" "${value//\'/''}"
}

validate_public_identifier() {
  local value="$1"
  local label="${2:-identifier}"

  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "Error: invalid ${label}: ${value}"
    exit 1
  fi
}

load_source_db_url() {
  local db_url

  if ! db_url="$(get_env_value "MAIN_SUPABASE_DB_URL")"; then
    echo "Error: MAIN_SUPABASE_DB_URL not set in $REPLICA_ENV_FILE"
    exit 1
  fi

  db_url="${db_url//ssl=false/sslmode=disable}"
  db_url="$(normalize_cloudsql_ssl "$db_url")"
  printf "%s" "$db_url"
}

build_source_connection_parts() {
  local db_url="$1"
  local source_password_encoded

  SOURCE_USER=$(echo "$db_url" | sed -E 's|postgresql://([^:]+):.*|\1|')
  source_password_encoded=$(echo "$db_url" | sed -E 's|postgresql://[^:]+:(.*)@[^@]+$|\1|')
  SOURCE_PASSWORD="$(uri_decode "$source_password_encoded")"
  _HOST_PORT_DB=$(echo "$db_url" | sed -E 's|.*@([^@]+)$|\1|')
  SOURCE_HOST=$(echo "$_HOST_PORT_DB" | sed -E 's|([^:]+):.*|\1|')
  SOURCE_PORT=$(echo "$_HOST_PORT_DB" | sed -E 's|[^:]+:([0-9]+)/.*|\1|')
  SOURCE_DB=$(echo "$_HOST_PORT_DB" | sed -E 's|[^/]+/([^?]+).*|\1|')

  if [[ "$SOURCE_USER" == postgres.* ]]; then
    PROJECT_ID=$(echo "$SOURCE_USER" | sed -E 's|postgres\.(.+)|\1|')
    SOURCE_HOST="db.${PROJECT_ID}.supabase.co"
    SOURCE_PORT="5432"
    SOURCE_USER="postgres"
    echo "==> Converted Supabase pooler URL to direct connection: $SOURCE_HOST:$SOURCE_PORT"
  elif [[ "$SOURCE_PORT" == "6543" ]]; then
    SOURCE_PORT="5432"
    echo "==> Changed Supabase source port from 6543 to 5432 for direct replication"
  fi

  SOURCE_SSLMODE='require'
  SOURCE_DB_URL="postgresql://${SOURCE_USER}:${source_password_encoded}@${SOURCE_HOST}:${SOURCE_PORT}/${SOURCE_DB}?sslmode=${SOURCE_SSLMODE}"
  SOURCE_CONNECTION_STRING="host=$(libpq_escape_value "$SOURCE_HOST")
            port=$(libpq_escape_value "$SOURCE_PORT")
            dbname=$(libpq_escape_value "$SOURCE_DB")
            user=$(libpq_escape_value "$SOURCE_USER")
            password=$(libpq_escape_value "$SOURCE_PASSWORD")
            sslmode=$(libpq_escape_value "$SOURCE_SSLMODE")
            connect_timeout=10
            keepalives=1
            keepalives_idle=10
            keepalives_interval=5
            keepalives_count=3"
}

load_source() {
  local db_url
  db_url="$(load_source_db_url)"
  build_source_connection_parts "$db_url"
}

load_replica_target() {
  local forced_key="${READ_REPLICA_TARGET_ENV:-}"
  local key
  local value
  local matches_file
  local preferred_matches=()
  local candidate_keys=(
    READ_REPLICATE_GOOGLE_EU1
    READ_REPLICA_DB_URL
    GOOGLE_READ_REPLICA_DB_URL
    GOOGLE_PRIMARY_REPLICA_DB_URL
    GOOGLE_REPLICA_DB_URL
    GOOGLE_DB_URL
    GOOGLE_EU_2
    GOOGLE_EU
    GOOGLE_PRIMARY
    GOOGLE_REPLICA
  )
  local count

  ensure_env_file

  if [[ -n "$forced_key" ]]; then
    if ! value="$(get_env_value "$forced_key")"; then
      echo "Error: READ_REPLICA_TARGET_ENV=$forced_key is not set in $REPLICA_ENV_FILE"
      exit 1
    fi
    if [[ "$value" != postgresql://* ]]; then
      echo "Error: $forced_key does not look like a PostgreSQL URL"
      exit 1
    fi
    REPLICA_TARGET_ENV="$forced_key"
    REPLICA_TARGET_DB_URL="$(ensure_connect_timeout "$(ensure_sslrootcert_system "$(normalize_cloudsql_ssl "$value")")" 10)"
    REPLICA_TARGET_HOST="$(extract_host "$value")"
    return 0
  fi

  for key in "${candidate_keys[@]}"; do
    if value="$(get_env_value "$key")" && [[ "$value" == postgresql://* ]]; then
      preferred_matches+=("$key")
    fi
  done

  if [[ ${#preferred_matches[@]} -gt 1 ]]; then
    echo "Error: multiple preferred Google read-replica database URLs found. Refusing to guess."
    echo "Set READ_REPLICA_TARGET_ENV to one of:"
    printf '  %s\n' "${preferred_matches[@]}"
    exit 1
  fi

  if [[ ${#preferred_matches[@]} -eq 1 ]]; then
    key="${preferred_matches[0]}"
    value="$(get_env_value "$key")"
    REPLICA_TARGET_ENV="$key"
    REPLICA_TARGET_DB_URL="$(ensure_connect_timeout "$(ensure_sslrootcert_system "$(normalize_cloudsql_ssl "$value")")" 10)"
    REPLICA_TARGET_HOST="$(extract_host "$value")"
    return 0
  fi

  matches_file="$(mktemp)"
  grep -E '^(READ_REPLICATE_[A-Z0-9_]*|GOOGLE_[A-Z0-9_]*|CLOUDSQL_[A-Z0-9_]*)=postgresql://' "$REPLICA_ENV_FILE" \
    | cut -d'=' -f1 > "$matches_file" || true
  count=$(wc -l < "$matches_file" | tr -d ' ')

  if [[ "$count" == "1" ]]; then
    key="$(cat "$matches_file")"
    rm -f "$matches_file"
    value="$(get_env_value "$key")"
    REPLICA_TARGET_ENV="$key"
    REPLICA_TARGET_DB_URL="$(ensure_connect_timeout "$(ensure_sslrootcert_system "$(normalize_cloudsql_ssl "$value")")" 10)"
    REPLICA_TARGET_HOST="$(extract_host "$value")"
    return 0
  fi

  if [[ "$count" -gt 1 ]]; then
    echo "Error: multiple Google/Cloud SQL database URLs found. Refusing to guess."
    echo "Set READ_REPLICA_TARGET_ENV to one of:"
    sed 's/^/  /' "$matches_file"
    rm -f "$matches_file"
    exit 1
  fi

  rm -f "$matches_file"
  echo "Error: no Google read-replica PostgreSQL URL found in $REPLICA_ENV_FILE"
  echo "Set READ_REPLICA_DB_URL or READ_REPLICA_TARGET_ENV."
  exit 1
}

replica_region_name() {
  local host_part

  if [[ -n "${READ_REPLICA_REGION:-}" ]]; then
    sanitize_identifier_part "$READ_REPLICA_REGION"
    return 0
  fi

  host_part="${REPLICA_TARGET_HOST%%.*}"
  sanitize_identifier_part "$host_part"
}

discover_publication_name() {
  local existing
  local count

  if [[ -n "${READ_REPLICA_PUBLICATION_NAME:-}" ]]; then
    printf "%s" "$READ_REPLICA_PUBLICATION_NAME"
    return 0
  fi

  if [[ -n "${REPLICA_TARGET_DB_URL:-}" ]]; then
    existing=$(psql-17 "$REPLICA_TARGET_DB_URL" -t -A -c "
      SELECT DISTINCT unnest(subpublications)
      FROM pg_subscription;
    " 2>/dev/null || true)
    count=$(printf '%s\n' "$existing" | sed '/^$/d' | wc -l | tr -d ' ')
    if [[ "$count" == "1" ]]; then
      printf "%s" "$existing"
      return 0
    fi
  fi

  existing=$(psql-17 "$SOURCE_DB_URL" -t -A -c "
    SELECT pubname
    FROM pg_publication
    WHERE pubname = 'capgo_google_replicate'
    LIMIT 1;
  " 2>/dev/null || true)

  if [[ -n "$existing" ]]; then
    printf "%s" "$existing"
  else
    printf "%s" "capgo_google_replicate"
  fi
}

discover_subscription() {
  local default_name="${1:-}"
  local rows
  local count
  local subname
  local slotname

  if [[ -n "${READ_REPLICA_SUBSCRIPTION_NAME:-}" ]]; then
    REPLICA_SUBSCRIPTION_NAME="$READ_REPLICA_SUBSCRIPTION_NAME"
    slotname=$(psql-17 "$REPLICA_TARGET_DB_URL" -t -A -c "
      SELECT COALESCE(subslotname, '')
      FROM pg_subscription
      WHERE subname = '${REPLICA_SUBSCRIPTION_NAME}'
      LIMIT 1;
    " 2>/dev/null || true)
    REPLICA_SLOT_NAME="${READ_REPLICA_SLOT_NAME:-${slotname:-${REPLICA_SUBSCRIPTION_NAME}_slot}}"
    return 0
  fi

  rows=$(psql-17 "$REPLICA_TARGET_DB_URL" -t -A -F '|' -c "
    SELECT subname, COALESCE(subslotname, '')
    FROM pg_subscription
    ORDER BY subname;
  " 2>/dev/null || true)
  count=$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d ' ')

  if [[ "$count" == "1" ]]; then
    subname="${rows%%|*}"
    slotname="${rows#*|}"
    REPLICA_SUBSCRIPTION_NAME="$subname"
    REPLICA_SLOT_NAME="${READ_REPLICA_SLOT_NAME:-${slotname:-${subname}_slot}}"
    return 0
  fi

  if [[ "$count" -gt 1 ]]; then
    echo "Error: multiple subscriptions found on $REPLICA_TARGET_ENV. Refusing to guess."
    echo "$rows" | sed 's/^/  /'
    echo "Set READ_REPLICA_SUBSCRIPTION_NAME and READ_REPLICA_SLOT_NAME."
    exit 1
  fi

  REPLICA_SUBSCRIPTION_NAME="${default_name:-capgo_google_subscription}"
  REPLICA_SLOT_NAME="${READ_REPLICA_SLOT_NAME:-${REPLICA_SUBSCRIPTION_NAME}_slot}"
}

print_target_summary() {
  echo "==> Replica target env: ${REPLICA_TARGET_ENV}"
  echo "==> Replica target host: ${REPLICA_TARGET_HOST}"
  echo "==> Subscription: ${REPLICA_SUBSCRIPTION_NAME:-unknown}"
  echo "==> Slot: ${REPLICA_SLOT_NAME:-unknown}"
}
