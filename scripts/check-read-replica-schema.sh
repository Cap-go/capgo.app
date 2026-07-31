#!/usr/bin/env bash

set -euo pipefail

SCHEMA_FILES=(
  'read_replicate/schema_replicate.sql'
  'read_replicate/schema_replicate.catalog.json'
)

echo "Generating read-replica schema snapshots from the current database schema..."
bash read_replicate/replicate_prepare.sh

if git diff --quiet -- "${SCHEMA_FILES[@]}"; then
  echo "Read-replica schema snapshots are up to date."
  exit 0
fi

echo "::error title=Read-replica schema is out of date::Read-replica snapshots changed after running bun run readreplicate:prepare."
echo ''
echo "The PR changes the schema replicated to Google read replicas."
echo "Before merge:"
echo "  1. Run: bun run readreplicate:prepare"
echo "  2. Commit the updated read_replicate/schema_replicate.sql and read_replicate/schema_replicate.catalog.json."
echo "Release CI applies safe additive subscriber DDL from this snapshot before primary migrations. Keep the snapshot current."
echo ''
echo "Diff:"
git --no-pager diff -- "${SCHEMA_FILES[@]}"
exit 1
