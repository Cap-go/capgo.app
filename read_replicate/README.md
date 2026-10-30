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
`capgo_google_eu_2_sub` / live slot) — no shell exports.

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

## Manual reconciliation

Replica schema maintenance and subscription refresh are manual operations.
Complete the required subscriber changes before deploying primary migrations
that affect replicated tables. Production releases apply Supabase migrations
and deploy the application without running replica reconciliation or waiting
for a subscription refresh.

The schema helper rebuilds the selected schema catalog from local migrations
through Tinbase/PGlite and reads the subscriber catalog over the direct
PostgreSQL URL in `READ_REPLICATE_GOOGLE_EU1`. It never uses
`schema_replicate.catalog.json` as its expected schema.

For an approved non-empty plan, the helper writes one `BEGIN`/DDL/`COMMIT`
transaction to the dedicated private Cloud Storage bucket, invokes Cloud SQL's
server-side import as its existing `postgres` user, removes that object, and
then re-reads the catalog. The bucket grants the service account only
bucket-scoped object access and the Cloud SQL service agent only read access.
Any skipped, unsupported, or non-transactional change stops the helper before
it can mutate the subscriber.

New replicated tables are only created when they are listed in
`ALLOWED_NEW_REPLICA_TABLES` (`schema_additive_sync.ts`), which pins their exact
`CREATE TABLE` SQL and catalog shape; any other missing table stops the
helper. After adding a table to the primary publication, refresh
`capgo_google_eu_2_sub` as the subscription owner and verify that its initial
copy has completed before deploying readers that depend on it.

Verification is directional rather than exact schema equality. The subscriber must
contain every required publisher object, but it may retain safe legacy
subscriber-only nullable/default-backed columns, supporting types, sequences,
functions, and ordinary non-unique indexes. The helper stops on incompatible or
missing publisher objects, extra tables or constraints, unique indexes, and
subscriber-only required columns that can reject replicated rows.

Authenticate `gcloud` with an account that can perform the server-side import
and set `READ_REPLICATE_GOOGLE_EU1` to the direct subscriber PostgreSQL URL.
The project, instance, database, and import configuration are fixed in the
sync script.

```bash
bun scripts/sync-read-replica-schema.ts
```

For a no-write check of the local catalog, live subscriber catalog, and complete
plan preflight:

```bash
bun scripts/sync-read-replica-schema.ts --dry-run
```
