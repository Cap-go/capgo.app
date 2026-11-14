# Read Replica Scripts

These scripts manage the Supabase-to-Google Cloud SQL subscriber. Google then
replicates this subscriber to the regional read replicas, so reconciliation
always targets only this database.


## Supabase Postgres upgrade

Capgo-EU blocks upgrades while the active logical slot `capgo_google_eu_2_slot`
exists. Use the premade bun commands (they load
`internal/cloudflare/.env.prod`; no exports needed):

```bash
# 1) Drop Google subscription + Supabase slot (unblocks dashboard upgrade)
bun run readreplicate:upgrade:teardown

# 2) Run the Supabase Postgres upgrade in the Capgo-EU dashboard, wait healthy

# 3) Rebuild subscriber data + recreate slot/subscription (WAL was wiped)
bun run readreplicate:upgrade:reconnect

# 4) Verify lag / active slot
bun run readreplicate:status
```

`upgrade:reconnect` runs a full reset (`READ_REPLICA_FULL_RESET=1`) because a
Postgres upgrade invalidates WAL continuity. Table copy is **resumable**:
already-synced tables (matching row counts) are skipped, complete dump files
are reused, and schema is not wiped if replica tables already exist. Do not
use subscription-only reconnect after an upgrade.

Both commands read `internal/cloudflare/.env.prod` for DB URLs and use the
baked-in Capgo EU2 publication/subscription/slot names (`capgo_google_eu_2_pub` /
`capgo_google_eu_2_sub` / live slot), with no shell exports.

`public.manifest_per_version` is primary-only while the encoded format is not
used by plugin reads. The migration removing it from the EU2 publication stops
future logical row changes from crossing to Google; setup/reset scripts must
not add it back. Existing subscriber rows and physical tables are deliberately
left alone. This change does not reclaim their storage or eliminate primary WAL.

## Repairing a gap without a reload

When the subscription is streaming again but missed changes (for example
`capgo_google_eu_2_slot` was invalidated with `wal_removed` and recreated at
the current WAL position), repair the live tables instead of reloading them:

```bash
# Dry run: per table, how many rows differ
bun run readreplicate:repair
# Fix them
bun run readreplicate:repair -- --apply
```

It compares every row by primary key and an md5 of its columns, then inserts,
overwrites or deletes only the rows that differ, one transaction per table,
while the subscription keeps streaming. Readers never see an empty table, and
row-count matches do not hide updated rows. It only touches subscribed tables
in state `r`, and skips `delta_files` and `version_files` by default (large,
and copied fresh by `REFRESH PUBLICATION`); pass `--tables a,b` or `--skip`
to change that. Rows that changed during the repair are reported; run it again
to settle them.

## Release and CI guardrails

Production deploy no longer runs automatic Google subscriber DDL from GitHub
Actions (see #4007). Schema drift is prevented in the repository instead:

1. **Before every PR merge and before `supabase db push` in production**, CI
   runs `bun scripts/check-read-replica-migrations-catalog.ts`. It builds the
   replicated-table catalog from all local migrations through PGlite/Tinbase and
   requires an exact match with the committed
   `read_replicate/schema_replicate.catalog.json`. Any migration that adds or
   alters columns on a replicated table without updating the snapshot fails the
   job.

2. **On Supabase integration CI**, `bun run readreplicate:check-schema`
   regenerates `read_replicate/schema_replicate.sql` and
   `read_replicate/schema_replicate.catalog.json` from a freshly migrated local
   Postgres dump and fails when those files drift.

When a migration touches replicated tables, update the snapshot before merge:

```bash
bun run readreplicate:prepare
git add read_replicate/schema_replicate.sql read_replicate/schema_replicate.catalog.json
```

New replicated tables must be listed in `REPLICA_TABLES` (`schema_catalog.ts`)
and, when first introduced, in `ALLOWED_NEW_REPLICA_TABLES`
(`schema_additive_sync.ts`) with their exact `CREATE TABLE` SQL.

Manual Google reconciliation (copy, repair, subscription refresh, upgrade
teardown) still uses the scripts in this directory with
`internal/cloudflare/.env.prod`. Those paths are operator-only; they are not
invoked from the release workflow.

### Plugin replication lag

The primary updates `public.read_replica_commit_marker` on a schedule. Plugin
workers on regional replicas combine upstream WAL statistics with the age of that
row so a subscriber stuck in an apply loop (fresh `last_msg_receipt_time`, no
applied commits) still reports lag and tightens edge cache TTL.

Optional operator sync against a live Google subscriber (not used in release CI):

```bash
bun scripts/sync-read-replica-schema.ts --dry-run
```

Requires `GOOGLE_SERVICE_ACCOUNT` and manual credentials; production release
does not call this script anymore.