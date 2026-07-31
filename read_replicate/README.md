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

`upgrade:reconnect` always runs a full reset (`READ_REPLICA_FULL_RESET=1`)
because a Postgres upgrade invalidates WAL continuity. Do not use
subscription-only reconnect after an upgrade.

Both commands read `internal/cloudflare/.env.prod` for DB URLs and use the
baked-in Capgo EU2 publication/subscription/slot names — no shell exports.

## Release reconciliation

The release job rebuilds the selected schema catalog from the checked-out local
migrations through Tinbase/PGlite. It never reads
`schema_replicate.catalog.json` as a release input.

Before primary Supabase migrations run, the job reads the bounded subscriber
catalog through Cloud SQL Data API and builds the complete reconciliation plan.
For an approved non-empty plan, the job writes one `BEGIN`/DDL/`COMMIT`
transaction to the dedicated private Cloud Storage bucket, invokes Cloud SQL's
server-side import as its existing `postgres` user, removes that object, and
then re-reads the catalog. The bucket grants the CI service account only
bucket-scoped object access and the Cloud SQL service agent only read access.
Any skipped, unsupported, or non-transactional change stops the release before
it can mutate either database.

This path has no direct PostgreSQL connection from GitHub Actions, no runner IP
allowlist, no temporary Worker, and no database-side helper, database role,
privilege, or object-owner setup.

Verification is directional rather than exact schema equality. The subscriber must
contain every required publisher object, but it may retain safe legacy
subscriber-only nullable/default-backed columns, supporting types, sequences,
functions, and ordinary non-unique indexes. The release stops on incompatible or
missing publisher objects, extra tables or constraints, unique indexes, and
subscriber-only required columns that can reject replicated rows.

| GitHub repository secret | Value                               |
| ------------------------ | ----------------------------------- |
| `GOOGLE_SERVICE_ACCOUNT` | Base64-encoded service-account JSON |

The project, instance, database, and import configuration are fixed in the
sync script, not supplied as GitHub variables.

```bash
bun scripts/sync-read-replica-schema.ts
```

For a no-write check of the local catalog, live subscriber catalog, and complete
plan preflight:

```bash
bun scripts/sync-read-replica-schema.ts --dry-run
```
