#!/usr/bin/env bash

# Runs the vitest files listed in tests/local-db-sql-tests.txt against this worktree's
# local Postgres (`bun run db:up && bun run db:provision`), without the Supabase stack.
# These files only talk to Postgres: raw SQL (`executeSQL` / `getPostgresClient`) and the
# SQL test data client. There is no GoTrue, PostgREST, Storage or edge runtime here:
# SUPABASE_URL points at a port nothing listens on, so any HTTP call fails the test.
# A file that needs one of those stays on the Supabase shards.
# Extra arguments are passed to vitest.

set -euo pipefail

LIST="tests/local-db-sql-tests.txt"
DB_URL="$(bun scripts/local-db.ts url)"
FILES=()
while IFS= read -r file; do
  [ -n "$file" ] && FILES+=("$file")
done < "$LIST"

# Same boundary as the Supabase shards: stop the seeded scheduler and purge its queues
# so background cron work does not race the tests.
SUPABASE_DB_URL="$DB_URL" bun scripts/quiesce-test-scheduler.ts

# All four variables set stops tests/test-utils.ts from starting the Supabase stack.
# The sb_ placeholders map to service_role and anon in tests/sql-data-client.ts.
SUPABASE_URL="http://127.0.0.1:9" \
  SUPABASE_ANON_KEY="sb_publishable_local_db_no_api" \
  SUPABASE_SERVICE_KEY="sb_secret_local_db_no_api" \
  SUPABASE_DB_URL="$DB_URL" \
  bunx vitest run "${FILES[@]}" "$@"
