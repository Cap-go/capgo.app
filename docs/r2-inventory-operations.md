# R2 inventory rollout

Merge the schema PR first, then the queue consumer, then the historical scanner. This inventory rollout does not enable physical object cleanup or change published CLI behavior.

## Queue consumer

The dedicated Worker uses one database connection per event batch, releases it before publication/pacing, and awaits all work before returning. Configure a Hyperdrive connection with query caching **disabled**; stale inventory/configuration reads are unsafe. Existing environment bindings follow the files Worker. Preproduction currently shares the production `capgo` bucket: use an isolated bucket and matching `INVENTORY_BUCKET`/R2 binding when testing there; do not attach a second notification rule to production casually.

Runtime configuration is a Vault secret named `r2_inventory_config`, containing:

```json
{ "enabled": true, "tombstoneDays": 7, "minBatchMs": 500 }
```

Missing configuration disables ingestion. A malformed secret fails closed. Use the existing Vault administration workflow to set it; no new configuration table is introduced. Set it before notifications are enabled. To pause a deployed consumer for maintenance, pause delivery in Cloudflare so messages do not burn their five-delivery budget while disabled.

Deployment commands (run after the schema exists):

```sh
bun scripts/ensure-r2-inventory-queues.ts alpha
bunx wrangler deploy --config cloudflare_workers/r2_inventory/wrangler.jsonc --env alpha
bunx wrangler r2 bucket notification create capgo-alpha --event-types object-create object-delete --queue capgo-r2-inventory-alpha --description capgo-r2-inventory
```

Use `prod`/`capgo` only for the reviewed production rollout. Queue creation is idempotent, but notification-rule creation is not: inspect existing rules before creating one. All four queues retain messages for four days. Existing queues require verifying their retention manually; the setup script does not silently change shared infrastructure.

The event consumer has batch size 100, timeout 10 seconds, concurrency 2, and four retries (at most five deliveries). Each invocation lasts at least 500ms, including pacing after the connection closes. Full-batch capacity starts around 400 events/s, with at most two concurrent event writers plus one repair writer; measure database WAL/latency and backlog before changing it. Timeout is not a minimum batch size or a global rate limiter. The repair queue has batches of ten, concurrency one, and two concurrent HEAD requests; ordinary uploads never perform HEAD.

Test a synthetic creation and deletion, then confirm the row transitions and queue acknowledgement. Monitor source/repair backlog, oldest-message age, failed batches and both DLQs. A maximum event timestamp is not a watermark because delivery can be out of order. Re-drive expired events through repair/reconciliation, never blind replay. Tombstone collection stays off until an initial backfill and complete reconciliation are verified.

## Ordering and repair

A batch collapses duplicate/older notifications per key, preserves conflicting equal-time events for verification, and applies fresh missing creates directly. Inserts use `ON CONFLICT DO NOTHING`; existing rows are locked in sorted key order and updated in one bulk statement within the same transaction. Retries do not churn revisions or extend duplicate tombstones. These short row locks protect ingestion races; no provider call or publication happens in the transaction.

Admission checkpoints protect the event horizon. Requests lock the bucket admission record in shared mode; any tombstone collector must exclusively advance its durable floor before purging history. Old notifications without covering history request verification. Revision comparisons prevent observations from overwriting concurrent events. Observations are limited to two minutes, use database request-start time and a five-second event-clock safety band, and preserve deletion intent through `cleanup_requested_at`, including after a tombstone. Compare-and-swap checks both revision and the original discovery timestamp, so a purged/reinserted key cannot be mistaken for the captured row. Near-boundary conflicting events are repaired conservatively.

Repair publication is awaited before acknowledging the source batch. Ambiguous rows stay unchanged, so a publication failure can safely replay and retry publication. Malformed messages retry independently and reach the DLQ within the same five-delivery budget; they do not block valid peers.

## Historical backfill and drift reconciliation

Enable and test notifications first so new changes are captured before scanning historical data. The script requires `R2_INVENTORY_DATABASE_URL` (internal writer connection), `R2_ENDPOINT` (the private R2 S3 endpoint), `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. R2 credentials need LIST access only; the script never requests object bodies, copies/deletes objects, or performs HEAD.

Preview a bounded page without writes, then backfill:

```sh
bun scripts/backfill-r2-inventory.ts --bucket capgo-alpha --job initial --max-pages 1
bun scripts/backfill-r2-inventory.ts --bucket capgo-alpha --job initial --write --max-pages 1000
```

Resume by repeating the same command. Checkpoints are scoped by bucket, mode, job and prefix. Each page uses `ListObjectsV2` with 1,000 objects and no delimiter. The object inserts and cursor advancement commit in one transaction; existing rows win over historical discovery. Invalid continuation tokens fall back to the last committed key. Failed pages are read fresh on resume. One writer processes at most one page per second by default; tune `--interval-ms` upward when live ingestion or WAL/latency indicates pressure. SDK attempts are capped at five, provider requests at 30 seconds, transaction statements at ten seconds, and standalone client queries at fifteen seconds. SIGINT/SIGTERM stop after the current page.

Run a complete two-way validation pass with the same job:

```sh
bun scripts/backfill-r2-inventory.ts --bucket capgo-alpha --job initial --mode reconcile --write --max-pages 1000
```

Repeat until `complete` is true. Reconciliation reads an indexed chunk of at most 1,000 database keys before one fresh R2 LIST page. It compares only the fully covered range, including unknown objects and absent known objects. A range can require up to 2,000 observations, written in two bounded chunks inside the page/checkpoint transaction. It preserves concurrent events using revision and discovery-time comparisons and counts skipped conflicts. A truncated/failed page never proves absence beyond its covered range. Pending reservations remain intact. The final provider-only tail is scanned as well.

For subsequent drift checks, explicitly restart the completed reconciliation checkpoint:

```sh
bun scripts/backfill-r2-inventory.ts --bucket capgo-alpha --job initial --mode reconcile --write --restart
```

Use `--restart` only for the first invocation of a new pass, then resume normally. It refuses active incomplete checkpoints (an old reconciliation invalidated by a restarted backfill can be reset) and competing writers cannot reset active work. Arrange recurring execution through the existing operational dispatcher/scheduler after the rollout; this PR introduces a resumable script and no new Postgres cron. LIST is strongly consistent per request, but a multi-page scan is not one atomic snapshot; repeated reconciliation repairs changes behind the cursor.

Failure reports default to `.context/r2-inventory-failures.jsonl`, contain bounded page keys plus the last committed progress, and stay local. Files are created with mode `0600`, existing files are tightened before appending, and symbolic links are refused. They may contain private storage identifiers: never commit or publish them. A DB failure rolls the page back; provider failures leave the cursor untouched. Dry runs write neither objects nor checkpoints. A page budget exit is resumable and does not mean the bucket is fully inventoried.

Reconciliation records the exact completion version of its backfill and rechecks it under a shared lock on every commit. Restarting backfill invalidates the earlier reconciliation for GC purposes. After the full-bucket initial backfill and reconciliation for the same completion version finish without skipped observations, bounded tombstone collection is available explicitly:

```sh
bun scripts/backfill-r2-inventory.ts --bucket capgo-alpha --job initial --mode gc --write
```

Each run examines at most 1,000 expired database tombstones and removes eligible history, using the bucket-first partial expiry index. It advances the monotonic admission floor in the same transaction and waits for in-flight event transactions before forgetting history. Admission-protected history remains; zero deletions can mean the age guards still apply. It never deletes R2 objects. If a replay predates the floor after its tombstone is gone, ingestion requests verification instead of recreating a row blindly. Large old-event recovery should use LIST reconciliation, rather than re-driving millions of notifications through individual HEAD repairs. Physical cleanup and manifest leases remain future work.

Creation events have no separate LastModified field. When a newer creation replaces a known key, its historical modification timestamp becomes unknown until the next direct observation; ingestion does not carry metadata from the replaced object forward.
