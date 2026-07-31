#!/usr/bin/env bash
# Repair Capgo-EU / Alpha migration history after a *_baseline.sql squash.
# Updates supabase_migrations history only — never runs baseline DDL.
#
# Usage:
#   bunx supabase link --project-ref <PROJECT_REF>
#   bash scripts/repair-prod-migration-squash.sh            # dry-run
#   bash scripts/repair-prod-migration-squash.sh --execute  # apply repair
#
# Optional:
#   --db-url 'postgresql://...'   # instead of --linked
#   --baseline 20260708000000     # default: sole local migration version
#   --batch-size 80

set -euo pipefail

EXECUTE=0
DB_TARGET=(--linked)
BASELINE_VERSION=''
BATCH_SIZE=80
MIGRATIONS_DIR='supabase/migrations'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    --linked) DB_TARGET=(--linked); shift ;;
    --local) DB_TARGET=(--local); shift ;;
    --db-url)
      [[ $# -ge 2 ]] || { echo "missing value for --db-url" >&2; exit 1; }
      DB_TARGET=(--db-url "$2"); shift 2
      ;;
    --baseline)
      [[ $# -ge 2 ]] || { echo "missing value for --baseline" >&2; exit 1; }
      BASELINE_VERSION="$2"; shift 2
      ;;
    --batch-size)
      [[ $# -ge 2 ]] || { echo "missing value for --batch-size" >&2; exit 1; }
      BATCH_SIZE="$2"; shift 2
      ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v bunx >/dev/null 2>&1; then
  echo "bunx is required" >&2
  exit 1
fi

mapfile -t LOCAL_FILES < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort)
if [[ ${#LOCAL_FILES[@]} -eq 0 ]]; then
  echo "No local migrations under $MIGRATIONS_DIR" >&2
  exit 1
fi

declare -A LOCAL_VERSIONS=()
for file in "${LOCAL_FILES[@]}"; do
  base="$(basename "$file")"
  if [[ "$base" =~ ^([0-9]{14})_ ]]; then
    LOCAL_VERSIONS["${BASH_REMATCH[1]}"]=1
  fi
done

if [[ -z "$BASELINE_VERSION" ]]; then
  if [[ ${#LOCAL_VERSIONS[@]} -ne 1 ]]; then
    echo "Expected exactly one local migration for a squash repair, found ${#LOCAL_VERSIONS[@]}." >&2
    echo "Pass --baseline <version> explicitly if this is intentional." >&2
    printf '  %s\n' "${!LOCAL_VERSIONS[@]}" | sort >&2
    exit 1
  fi
  BASELINE_VERSION="$(printf '%s\n' "${!LOCAL_VERSIONS[@]}" | head -1)"
fi

if [[ -z "${LOCAL_VERSIONS[$BASELINE_VERSION]+x}" ]]; then
  echo "Baseline version $BASELINE_VERSION is not present locally." >&2
  exit 1
fi

echo "Fetching remote migration list..."
LIST_OUT="$(mktemp)"
trap 'rm -f "$LIST_OUT"' EXIT
bunx supabase migration list "${DB_TARGET[@]}" >"$LIST_OUT"

# Parse version tokens from CLI table/text output.
mapfile -t REMOTE_VERSIONS < <(
  # shellcheck disable=SC2016
  sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' "$LIST_OUT" \
    | grep -oE '[0-9]{14}' \
    | sort -u
)

if [[ ${#REMOTE_VERSIONS[@]} -eq 0 ]]; then
  echo "Could not parse any remote migration versions from:" >&2
  cat "$LIST_OUT" >&2
  exit 1
fi

TO_REVERT=()
for version in "${REMOTE_VERSIONS[@]}"; do
  if [[ -z "${LOCAL_VERSIONS[$version]+x}" ]]; then
    TO_REVERT+=("$version")
  fi
done

TO_MARK_APPLIED=()
if ! printf '%s\n' "${REMOTE_VERSIONS[@]}" | grep -qxF "$BASELINE_VERSION"; then
  TO_MARK_APPLIED+=("$BASELINE_VERSION")
fi

echo
echo "Local migrations: ${#LOCAL_VERSIONS[@]} (baseline $BASELINE_VERSION)"
echo "Remote versions parsed: ${#REMOTE_VERSIONS[@]}"
echo "Will mark reverted: ${#TO_REVERT[@]}"
echo "Will mark applied: ${#TO_MARK_APPLIED[@]}"
echo

if [[ ${#TO_REVERT[@]} -eq 0 && ${#TO_MARK_APPLIED[@]} -eq 0 ]]; then
  echo "Nothing to repair. History already matches the squash."
  exit 0
fi

run_repair() {
  local status="$1"
  shift
  local versions=("$@")
  local i=0
  local batch=()
  for version in "${versions[@]}"; do
    batch+=("$version")
    i=$((i + 1))
    if (( i % BATCH_SIZE == 0 )); then
      echo "-> migration repair --status $status (${#batch[@]} versions)"
      if (( EXECUTE == 1 )); then
        bunx supabase migration repair "${DB_TARGET[@]}" --status "$status" --yes "${batch[@]}"
      fi
      batch=()
    fi
  done
  if (( ${#batch[@]} > 0 )); then
    echo "-> migration repair --status $status (${#batch[@]} versions)"
    if (( EXECUTE == 1 )); then
      bunx supabase migration repair "${DB_TARGET[@]}" --status "$status" --yes "${batch[@]}"
    fi
  fi
}

if (( ${#TO_REVERT[@]} > 0 )); then
  echo "Reverting remote-only versions..."
  run_repair reverted "${TO_REVERT[@]}"
fi

if (( ${#TO_MARK_APPLIED[@]} > 0 )); then
  echo "Marking baseline applied (no DDL)..."
  run_repair applied "${TO_MARK_APPLIED[@]}"
fi

if (( EXECUTE == 0 )); then
  echo
  echo "Dry-run only. Re-run with --execute to apply."
  exit 0
fi

echo
echo "Repair finished. Verifying..."
bunx supabase migration list "${DB_TARGET[@]}"
echo
echo "Confirm db push would apply nothing before merging/deploying:"
echo "  bunx supabase db push ${DB_TARGET[*]} --dry-run"
