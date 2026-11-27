#!/usr/bin/env bash
# Print the database errors an Edge server log recorded, with the lines that follow each
# (error message, pg code, stack). A request that answered 503 upstream_unavailable only
# says "Database temporarily unavailable"; the cause is in this log, which is otherwise
# uploaded only when the job fails.
set -euo pipefail
log="${1:?usage: print-edge-db-errors.sh <edge-server-log>}"
[ -f "$log" ] || { echo "No Edge server log at $log"; exit 0; }
pattern='transient_pg_error|drizzle_error|PG Pool Error|PG Client Error|deadlock detected|too many clients|Connection terminated'
count="$(sed $'s/\x1b\\[[0-9;]*m//g' "$log" | grep -cE "$pattern" || true)"
echo "Database error records in $(basename "$log"): $count"
[ "$count" = "0" ] && exit 0
echo "::group::Database errors in $(basename "$log")"
sed $'s/\x1b\\[[0-9;]*m//g' "$log" | grep -E -A 14 "$pattern" | head -n 400
echo "::endgroup::"
