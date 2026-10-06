# R2 inventory rollout

Merge the schema PR first, then the queue consumer, then the historical scanner. This inventory rollout does not enable physical object cleanup or change published CLI behavior.

## Queue consumer

The dedicated Worker uses one database connection per event batch, releases it before publication, and awaits all work before returning. Configure a Hyperdrive connection with query caching **disabled**; stale inventory reads are unsafe. Existing environment bindings follow the files Worker. Preproduction currently shares the production `capgo` bucket: use an isolated bucket and matching `INVENTORY_BUCKET`/R2 binding when testing there; do not attach a second notification rule to production casually.

Inventory configuration is the `INVENTORY_CONFIG` constant in `supabase/functions/_backend/utils/r2_inventory.ts`; tombstones are retained for seven days. No Vault secret or runtime enablement switch is required. To pause a deployed consumer for maintenance, pause delivery in Cloudflare so messages do not burn their five-delivery budget.

Deployment commands (run after the schema exists):

```sh
bun scripts/ensure-r2-inventory-queues.ts alpha
bunx wrangler deploy --config cloudflare_workers/r2_inventory/wrangler.jsonc --env alpha
bunx wrangler r2 bucket notification create capgo-alpha --event-types object-create object-delete --queue capgo-r2-inventory-alpha --description capgo-r2-inventory
```

Use `prod`/`capgo` only for the reviewed production rollout. Queue creation is idempotent, but notification-rule creation is not: inspect existing rules before creating one. All four queues retain messages for four days. Existing queues require verifying their retention manually; the setup script does not silently change shared infrastructure.

The event consumer has batch size 100, timeout 10 seconds, concurrency one, and four retries (at most five deliveries). The repair queue has batches of ten and concurrency one. Each invocation opens at most one database connection at a time, so both queues together use at most two active inventory database connections per environment. Repairs release the database connection before issuing up to two concurrent HEAD requests; ordinary uploads never perform HEAD. Consumer handlers return as soon as their work finishes, with no artificial pacing delay. The ten-second timeout coalesces small batches; it is not a minimum batch size or a rate limiter. Measure actual throughput, database WAL/latency and backlog.

This bound applies to queue consumers. A separately run backfill holds another connection; pause queue delivery during a backfill if the same two-connection budget must cover that operation. Hyperdrive's retained pool connections and other application traffic have separate connection budgets.

Test a synthetic creation and deletion, then confirm the row transitions and queue acknowledgement. Monitor source/repair backlog, oldest-message age, failed batches and both DLQs. A maximum event timestamp is not a watermark because delivery can be out of order. Re-drive expired events through repair/reconciliation, never blind replay. Tombstone collection stays off until an initial backfill and complete reconciliation are verified.

## Ordering and repair

A batch collapses duplicate/older notifications per key, preserves conflicting equal-time events for verification, and applies fresh missing creates directly. Inserts use `ON CONFLICT DO NOTHING`; existing rows are locked in sorted key order and updated in one bulk statement within the same transaction. Retries do not churn revisions or extend duplicate tombstones. These short row locks protect ingestion races; no provider call or publication happens in the transaction.

Admission checkpoints protect the event horizon. Requests lock the bucket admission record in shared mode; any tombstone collector must exclusively advance its durable floor before purging history. Old notifications without covering history request verification. Revision comparisons prevent observations from overwriting concurrent events. Observations are limited to two minutes, use database request-start time and a five-second event-clock safety band, and preserve deletion intent through `cleanup_requested_at`, including after a tombstone. Compare-and-swap checks both revision and the original discovery timestamp, so a purged/reinserted key cannot be mistaken for the captured row. Near-boundary conflicting events are repaired conservatively.

Repair publication is awaited before acknowledging the source batch. Ambiguous rows stay unchanged, so a publication failure can safely replay and retry publication. Malformed messages retry independently and reach the DLQ within the same five-delivery budget; they do not block valid peers.
