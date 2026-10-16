# R2 inventory rollout

Merge the schema PR first, then the queue consumer, then the historical scanner. This inventory rollout does not enable physical object cleanup or change published CLI behavior.

The production inventory Worker's minute cleanup producer checks manifest replication health,
persists consumer evidence, and retires/enqueues eligible objects. Stable release
deployment provisions its producer-only cleanup queue. See [R2 cleanup producer](r2-cleanup-producer.md)
for the transaction/queue contract and separate physical deletion consumer rollout.

## Queue consumer

R2 inventory is production-only. Only the `prod` Worker environment and its five queues are configured (including the producer-only cleanup queue); alpha and preproduction do not deploy inventory. The dedicated Worker uses one database connection per event batch, releases it before publication, and awaits all work before returning. Configure a Hyperdrive connection with query caching **disabled**; stale inventory reads are unsafe. The dedicated `HYPERDRIVE_R2_INVENTORY` binding selects the inventory database independently of the files Worker.

Inventory configuration is the `INVENTORY_CONFIG` constant in `supabase/functions/_backend/utils/r2_inventory.ts`; tombstones are retained for seven days. No Vault secret or runtime enablement switch is required. To pause a deployed consumer for maintenance, pause delivery in Cloudflare so messages do not burn their five-delivery budget.

Stable Capgo releases deploy the inventory consumer through the `Deploy R2 inventory consumer` job in `.github/workflows/build_and_deploy.yml`. It waits for any required schema deployments, creates missing production inventory queues, then deploys the Worker with `--env=prod` from the resolved immutable release tag. Alpha releases skip this job. The provisioning script accepts only `prod` and rejects other environments before API access. Both queue provisioning and Worker deployment reject stale release targets. The Cloudflare deployment token requires Workers and Queues write permissions.

Bucket event notification rules remain a manual activation step. You can deploy and validate the consumer before connecting the bucket; until a rule is created, R2 notifications do not enter the event queue.

Manual deployment commands (run after the schema exists, when not using the release workflow):

```sh
bun scripts/ensure-r2-inventory-queues.ts prod
bunx wrangler deploy --config cloudflare_workers/r2_inventory/wrangler.jsonc --env prod
bunx wrangler r2 bucket notification create capgo --event-types object-create object-delete --queue capgo-r2-inventory-prod --description capgo-r2-inventory
```

The release workflow does not create the bucket notification rule. For a reviewed production activation, inspect existing rules before running the manual notification command. Queue creation is idempotent, but notification-rule creation is not. All five queues retain messages for four days; the provisioning script repairs retention drift and verifies the final settings while preserving other queue settings.

The event consumer has batch size 100, timeout 10 seconds, concurrency one, and four retries (at most five deliveries). The repair queue has batches of ten and concurrency one. Each invocation opens at most one database connection at a time, so both queues together use at most two active inventory database connections in production. Repairs release the database connection before issuing up to two concurrent HEAD requests; ordinary uploads never perform HEAD. Consumer handlers return as soon as their work finishes, with no artificial pacing delay. The ten-second timeout coalesces small batches; it is not a minimum batch size or a rate limiter. Measure actual throughput, database WAL/latency and backlog.

This bound applies to queue consumers. A separately run backfill holds another connection; pause queue delivery during a backfill if the same two-connection budget must cover that operation. Hyperdrive's retained pool connections and other application traffic have separate connection budgets.

Test a synthetic creation and deletion, then confirm the row transitions and queue acknowledgement. Monitor source/repair backlog, oldest-message age, failed batches and both DLQs. A maximum event timestamp is not a watermark because delivery can be out of order. Re-drive expired events through repair/reconciliation, never blind replay. Tombstone collection stays off until an initial backfill and complete reconciliation are verified.

## PlanetScale production destination

Production notifications and repairs both write to the standalone PlanetScale Postgres database `capgo/capgo-r2-inventory`, branch `main`, database `postgres`. The production inventory Worker binds Hyperdrive `capgo-r2-inventory-planetscale-prod` with caching disabled. There is no fallback to the primary database: a missing inventory binding fails the batch and leaves valid messages available for retry.

The standalone database needs `r2_objects`, its lifecycle trigger and enum, and `r2_inventory_checkpoints`. Its `manifest` table is reserved for a separate replication setup; the notification consumer does not access it. The checkpoint schema is recorded in `cloudflare_workers/r2_inventory/sql/20261009_checkpoints.sql` and was prepared on the target before this binding change. This is a standalone database setup, not a Supabase migration. Run it only once against an empty checkpoint schema, with a separately created runtime role; rerunning it fails atomically rather than silently accepting a different schema.

The Hyperdrive origin uses the `r2_inventory_consumer` role. It can select, insert and update the two inventory tables, use the object-state enum, and select only the `manifest.s3_path` column for cleanup reference checks. It has no inherited database-wide or administrative roles, no direct table DELETE grant, and no schema-creation permission. Its deletion capability is limited to executing the approved `expire_r2_manifest_placeholders(text, integer)` function for bounded batches of expired upload placeholders. Runtime credentials are stored in Hyperdrive, never in repository files. These explicit grants were verified on the target, and Cloudflare accepted the restricted origin connection.

### Manifest reservation lease schema preparation

`supabase/migrations/20261013093816_r2_objects_manifest_lease.sql` records the
additive lease schema in the repository's migration history. Applying Supabase
migrations does **not** update the authoritative standalone PlanetScale inventory.
The lease preparation requires a separate reviewed schema deployment to that
inventory database; merging this PR alone does not complete that deployment.

The column is nullable `timestamptz`, with no default or existing-row backfill.
The four lifecycle states stay unchanged. The partial index contains only
`to_be_uploaded` rows with a non-null lease and supports bucket-scoped queries
ordered by `(manifest_lease_expires_at, r2_key)` with an expiry cutoff and limit.
Manifest reservations and registration extend it using
`GREATEST(COALESCE(existing_expiry, database_now), database_now + interval '30 minutes')`;
see "Manifest reservations and receipt registration" and "Placeholder expiry
deployment and limits" below.

For a later authorized PlanetScale deployment, use an existing administrator
connection to the production destination above, not the restricted Hyperdrive
runtime role. Apply the migration's exact `ALTER TABLE` and `COMMENT ON COLUMN`
statements in a short transaction with `SET LOCAL lock_timeout = '5s'`. If the
lock times out, roll back and retry later; do not wait indefinitely behind active
inventory work. Commit those statements before building the index.

Then apply the migration's same index definition with `CONCURRENTLY`, outside a
transaction, so notifications, repairs and backfill writes can continue:

```sql
CREATE INDEX CONCURRENTLY r2_objects_expired_manifest_leases_idx
ON public.r2_objects (bucket_name, manifest_lease_expires_at, r2_key)
WHERE r2_state = 'to_be_uploaded'::public.r2_object_state
AND manifest_lease_expires_at IS NOT NULL;
```

The regular index statement in the migration is for transactional Supabase
migration execution. Do not run that regular build on the large live inventory.
Even the initially empty partial index requires table scans during construction;
schedule the concurrent build with capacity available, deferring it if necessary
while the historical backfill runs without modifying that backfill. Afterward,
verify the column's type, nullability and absent default, the column comment, and
the index definition plus `pg_index.indisvalid` / `indisready`. A failed concurrent
build can leave an invalid index: inspect and remove only that invalid index with
`DROP INDEX CONCURRENTLY public.r2_objects_expired_manifest_leases_idx` before
retrying. Do not use `IF NOT EXISTS` to accept an invalid or mismatched index.
This deployment needs no credential, binding, consumer or R2 object changes.

### Starting without the old inventory history

This change starts a new inventory; it does not import existing Supabase inventory rows or historical R2 objects. The first insertion of a bucket's admission checkpoint records the database statement-start time as its initial event floor. That floor is preserved on subsequent `ON CONFLICT DO NOTHING` insertions. The existing guard prevents moving it backwards or deleting it.

Notifications older than this initial boundary need verification against R2 when no newer event or observation covers them. This prevents a delayed pre-cutover creation from resurrecting an object whose deletion was recorded only in the old database. The first batch can therefore generate repairs. Ordinary notifications created after the boundary follow the usual batched SQL path without a HEAD per upload. Historic coverage still requires the separate backfill, and file cleanup must remain disabled until both inventory coverage and manifest replication are verified.

Each queue retains concurrency one, so at most two inventory application connections are active in production. Hyperdrive's origin pool has a soft limit of five; it may retain idle connections and this is not a hard two-connection limit on Postgres.

### Release and rollback

The normal Capgo release workflow deploys the changed inventory binding. The bucket's existing notification rule and four existing queues are reused; the producer-only cleanup queue is provisioned separately, so no bucket reconfiguration or new application secret is needed. After deployment, verify the deployed Hyperdrive binding, both queue backlogs and DLQs, successful batch logs, and new inventory rows in PlanetScale. Source ingestion in Supabase stops when the old consumer is replaced.

If a cutover fails, pause delivery of both inventory queues before exhausting their five-delivery budget, inspect the failure and repair the target. Do not simply point back to Supabase after successful PlanetScale acknowledgements: Supabase then lacks the acknowledged interval. A rollback needs a resumable reconciliation of that interval (including deletions) before the old inventory can be trusted again. No data is automatically deleted by this PR.

## Ordering and repair

A batch collapses duplicate/older notifications per key, preserves conflicting equal-time events for verification, and applies fresh missing creates directly. Inserts use `ON CONFLICT DO NOTHING`; existing rows are locked in sorted key order and updated in one bulk statement within the same transaction. Retries do not churn revisions or extend duplicate tombstones. These short row locks protect ingestion races; no provider call or publication happens in the transaction.

Admission checkpoints protect the event horizon. Requests lock the bucket admission record in shared mode; any tombstone collector must exclusively advance its durable floor before purging history. Old notifications without covering history request verification. Revision comparisons prevent observations from overwriting concurrent events. Observations are limited to two minutes, use database request-start time and a five-second event-clock safety band, and preserve deletion intent through `cleanup_requested_at`, including after a tombstone. Compare-and-swap checks both revision and the original discovery timestamp, so a purged/reinserted key cannot be mistaken for the captured row. Near-boundary conflicting events are repaired conservatively.

Normal notifications are acknowledged after their database transaction commits. Ambiguous notifications wait for successful repair publication; publication failures retry only those messages. Repair consumers batch database work while acknowledging successfully applied keys and retrying only keys with failed HEAD requests or revision conflicts. All messages for a duplicated failed key retry together, and successful absence checks are applied as observations. Database snapshot or write failures retry all unconfirmed repair messages. No acknowledgement precedes the database commit for its observation. Ambiguous rows stay unchanged, so a publication failure can safely replay and retry publication. Invalid event and repair payloads are published directly in batches to their respective DLQs, then acknowledged only after publication succeeds. If publication fails, only those rejected messages retry; valid peers still proceed. Transient processing failures keep the existing five-delivery retry budget and automatic DLQ forwarding.

Directly rejected messages use an `invalid_inventory_message` envelope containing the original `body`, queue name, message ID, timestamp, attempt count and validation reason. Ordinary JSON payloads remain previewable in Cloudflare; non-JSON bodies use V8 serialization. A crash after publication and before acknowledgement can duplicate DLQ entries: deduplicate on `(originalQueue, originalMessageId)` and replay the original `body` after fixing the cause. Automatic retry-exhaustion DLQ entries retain their original payload without this envelope. No recovery consumer is installed; the existing setup script creates both DLQs with four-day retention, and deployment configures their producer bindings.

## Manifest reservations and receipt registration

The production API Worker independently selects the uncached inventory Hyperdrive;
there is no primary Supabase inventory fallback. Each reservation or finalization
opens one inventory connection for the whole request and releases it in `finally`.
The primary authorization connection and inventory connection have separate budgets;
API concurrency adds to the existing event/repair consumer budget. Alpha and preprod
keep the previous upload flow. Isolated local tests can explicitly select
`LOCAL_R2_INVENTORY_DB_URL`; this must never point at production.

Reservations query at most 100 files × 20 candidates per chunk, using the inventory
primary key `(bucket_name, r2_key)`. Generation zero preserves the existing path.
Generations 1–19 and the rare UUID directory follow the encryption session, if any,
without changing the existing name/hash/Brotli encoding. Usable present or pending
keys are reused; deleted keys and committed retirement are never reactivated.
Conditional upserts validate state and extend a nonshortening 30-minute database
lease atomically. At most two rechecks operate only on unresolved files, followed by
one UUID reservation attempt. Database failures abort rather than generating paths.
Added paths retain both the manifest limit and R2's 1024-byte key limit. An added
candidate too long for R2 is unavailable; a usable original path can still succeed.
Numbered/UUID paths use existing literal packing. Tombstone pruning remains disabled.

Files and completed TUS writes mint only opaque v2 size receipts under the existing
header, below the CLI's 128-character bound. HMAC binds bucket and physical key to
size, signing time, evidence source/time and authenticated R2 identity. Read evidence
starts before actual R2 metadata/body access. Upload evidence uses the `uploaded`
timestamp returned by `put`/multipart completion, conservatively rounded down for
ordering; signing happens after success. Cached receipts retain their original token
and timestamps; old cache entries need an actual metadata read to mint v2. No
inventory connection is added to files uploads or cached device downloads. CLI existence checks require the exact reserved physical key, including cached
GETs and HEADs. Receipt-aware requests bypass the outer Managed Files cache and
reach the inner cache evidence gate. A legacy dotfile alias counts as missing for that protocol, so the
published CLI uploads the canonical reserved key; ordinary device alias reads
retain their existing behavior. Canonical put/multipart ETags are retained losslessly
in the receipt, allowing normal notifications to match registration without per-file
HEAD repair. An exceptional upload-clock ambiguity uses a direct metadata read
instead of treating a successful write as fresh local-clock evidence.

Finalization verifies every receipt before inventory or primary manifest writes. It
locks/evaluates at most 500 keys per SQL statement in one bounded Drizzle transaction
(up to the existing 10,000-file manifest limit), then releases the connection before
the existing primary manifest transaction. V2 receipts require an existing,
non-null reservation that is strictly unexpired at renewal. The conditional update
checks the database clock after taking row locks and extends the lease in that
same statement; missing, null or expired reservations reject the whole manifest
with a conflict before primary writes. Receipts cannot recreate expired placeholders.
Upload notifications preserve existing reservation expiry exactly, including expired
leases. Deleted/pending rows reject contradictory,
equal or ambiguous evidence; deleted rows require a boundary clearly newer than
both event and reconciliation history. A five-second safety band covers event/local
clock ambiguity and sub-millisecond database precision. Present rows ignore stale
metadata. Retirement rejects every flow regardless of freshness. v1 and receiptless
flows only check retirement and do not write inventory or leases. Receipt facts never
manufacture `last_event_at`. A later primary failure can leave an unreferenced
inventory row; this safe orphan is an explicit consequence of separate databases.
Finalized-manifest idempotent retries retain the existing behavior.

## Placeholder expiry deployment and limits

Apply these prerequisites separately before deploying the production API Worker:

1. Verify the nullable lease column from migration `20261013093816` and build/verify
   its exact partial expiry index **concurrently** as described above. Read-only
   target inspection on 2026-10-13 found the column but no expiry index; a merged
   Supabase migration does not establish PlanetScale deployment.
2. Apply `cloudflare_workers/r2_inventory/sql/20261013_manifest_placeholder_expiry.sql`
   as an inventory administrator in a short transaction with a five-second lock
   timeout. It installs the exact additive helper and grants EXECUTE only to
   `r2_inventory_consumer`; it does not grant table DELETE or manifest access.
   Supabase migration `20261013165559` records the service-role equivalent only.
   Verify owner `postgres`, empty search path, revoked PUBLIC EXECUTE, helper limit
   1–1000, and that the runtime still lacks direct DELETE. Apply no unrelated grants.
3. Verify Hyperdrive `capgo-r2-inventory-planetscale-prod` still targets the standalone
   inventory using the restricted role, with caching disabled. The API production
   binding uses that independently selected existing origin; alpha/preprod have no
   inventory binding. Confirm both consumer queues, their DLQs and notifications are
   healthy. The four production queue bindings only read metrics in this feature.
4. For initial activation, deploy the API Worker first and verify it accepts both
   v1 and v2 receipts before deploying the files Worker that mints v2. Use this
   controlled order even when a normal release deploys these Workers in parallel:
   the previous API only verifies v1. Keep the receipt secret separate from upload
   capability secrets. No bucket rule, backfill, replica or packed protocol change
   is required. Roll back files first; do not revert API v2 verification while
   completed uploads can still submit v2 receipts.

The existing every-minute API callback runs notification flushing and expiry as
independent tasks. Expiry never runs on API requests or in alpha/preprod. Fresh
private Queue `metrics()` calls must show zero backlog count and bytes in **all
four** queues; missing metrics, failure, timeout, backlog or a DLQ message skips
expiry. Metrics are best-effort approximate health readings, not a strict completion
watermark. In particular, maximum observed event time is never used as completeness.
Health reads time out in five seconds and their authorization expires after fifteen
seconds; a new invocation obtains fresh readings. Expiry is capped at 10,000 rows,
1,000 per transaction, with a 20-second invocation work budget (each in-flight helper
has a five-second statement limit and one-second lock limit). It opens one inventory
connection per invocation. There is no pacing floor, new PostgreSQL cron or renewal API.

The service-only helper first locks the bucket admission checkpoint `FOR UPDATE`.
This conflicts with the event consumer's existing `FOR SHARE` held across its
INSERT-then-SELECT transaction, so an expired placeholder cannot disappear in that
gap and cause a creation to be acknowledged without recording it. Missing admission
history skips deletion. Repair snapshots retain revision/discovery-time CAS; expiry
conflicts return failed keys for the existing retry path, with unchanged concurrency
and at most five deliveries. Batches use the partial index and `SKIP LOCKED`, deleting
only `to_be_uploaded` rows with a non-null elapsed lease. No extra first-seen age
condition, R2 HEAD/copy/delete, retirement reversal or physical cleanup is introduced.

Read-only production catalog estimates on 2026-10-13 showed about 18.7 million
inventory rows (12 GB table; 26 GB primary-key index) and two checkpoint rows.
The expiry helper runs once per bounded internal batch, reachable only by the
service runtime role; no new anonymous/authenticated RLS, view or public RPC
function call is introduced. It touches one indexed checkpoint and at most 1,000
indexed placeholders. The row lifecycle trigger is constant-time per changed row.

Local PostgreSQL 17 verification used 100,000 synthetic inventory rows. The expiry
selection returned 1,000 rows through `r2_objects_expired_manifest_leases_idx` in
0.343 ms (1,218 buffer hits); representative key lookup used `r2_objects_pkey` in
0.064 ms; admission locking used its primary key in 0.031 ms. No sequential scan
appeared in those measured plans. Real isolated 5,000- and 10,000-file reservation
and registration tests passed, together with ingestion/repair/expiry concurrency.
These measurements establish indexed bounded work, not production throughput.
A read-only production lookup of 2,000 synthetic missing keys used
`r2_objects_pkey` in 3.463 ms (8 buffer hits, 2 reads), without scanning inventory.
The absent production expiry index prevented validating that plan on live rows;
its exact definition and readiness must be checked after separate application.
Production deployment must verify expiry plans and pool capacity against actual traffic;
no production schema, credentials, handlers or backfill were mutated for this PR.

References: [R2 returned object metadata](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[Queue metrics limitations](https://developers.cloudflare.com/api/resources/queues/methods/get_metrics/).
