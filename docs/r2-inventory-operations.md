# R2 inventory rollout

Merge the schema PR first, then the queue consumer, then the historical scanner. This inventory rollout does not enable physical object cleanup or change published CLI behavior.

## Queue consumer

The dedicated Worker uses one database connection per event batch, releases it before publication, and awaits all work before returning. Configure a Hyperdrive connection with query caching **disabled**; stale inventory reads are unsafe. Existing environment bindings follow the files Worker. Preproduction currently shares the production `capgo` bucket: use an isolated bucket and matching `INVENTORY_BUCKET`/R2 binding when testing there; do not attach a second notification rule to production casually.

Inventory configuration is the `INVENTORY_CONFIG` constant in `supabase/functions/_backend/utils/r2_inventory.ts`; tombstones are retained for seven days. No Vault secret or runtime enablement switch is required. To pause a deployed consumer for maintenance, pause delivery in Cloudflare so messages do not burn their five-delivery budget.

Capgo releases deploy the inventory consumer through the `Deploy R2 inventory consumer` job in `.github/workflows/build_and_deploy.yml`. It waits for any required schema deployments, creates missing inventory queues, then deploys the Worker from the resolved immutable release tag. Stable releases use `prod`; alpha releases use `alpha`. Both queue provisioning and Worker deployment reject stale release targets. The Cloudflare deployment token requires Workers and Queues write permissions.

Bucket event notification rules remain a manual activation step. You can deploy and validate the consumer before connecting the bucket; until a rule is created, R2 notifications do not enter the event queue.

Manual deployment commands (run after the schema exists, when not using the release workflow):

```sh
bun scripts/ensure-r2-inventory-queues.ts alpha
bunx wrangler deploy --config cloudflare_workers/r2_inventory/wrangler.jsonc --env alpha
bunx wrangler r2 bucket notification create capgo-alpha --event-types object-create object-delete --queue capgo-r2-inventory-alpha --description capgo-r2-inventory
```

The release workflow does not create the bucket notification rule. For a reviewed production activation, inspect existing rules and use `prod`/`capgo` in the manual notification command. Queue creation is idempotent, but notification-rule creation is not: inspect existing rules before creating one. All four queues retain messages for four days. Existing queues require verifying their retention manually; the setup script does not silently change shared infrastructure.

The event consumer has batch size 100, timeout 10 seconds, concurrency one, and four retries (at most five deliveries). The repair queue has batches of ten and concurrency one. Each invocation opens at most one database connection at a time, so both queues together use at most two active inventory database connections per environment. Repairs release the database connection before issuing up to two concurrent HEAD requests; ordinary uploads never perform HEAD. Consumer handlers return as soon as their work finishes, with no artificial pacing delay. The ten-second timeout coalesces small batches; it is not a minimum batch size or a rate limiter. Measure actual throughput, database WAL/latency and backlog.

This bound applies to queue consumers. A separately run backfill holds another connection; pause queue delivery during a backfill if the same two-connection budget must cover that operation. Hyperdrive's retained pool connections and other application traffic have separate connection budgets.

Test a synthetic creation and deletion, then confirm the row transitions and queue acknowledgement. Monitor source/repair backlog, oldest-message age, failed batches and both DLQs. A maximum event timestamp is not a watermark because delivery can be out of order. Re-drive expired events through repair/reconciliation, never blind replay. Tombstone collection stays off until an initial backfill and complete reconciliation are verified.

## Ordering and repair

A batch collapses duplicate/older notifications per key, preserves conflicting equal-time events for verification, and applies fresh missing creates directly. Inserts use `ON CONFLICT DO NOTHING`; existing rows are locked in sorted key order and updated in one bulk statement within the same transaction. Retries do not churn revisions or extend duplicate tombstones. These short row locks protect ingestion races; no provider call or publication happens in the transaction.

Admission checkpoints protect the event horizon. Requests lock the bucket admission record in shared mode; any tombstone collector must exclusively advance its durable floor before purging history. Old notifications without covering history request verification. Revision comparisons prevent observations from overwriting concurrent events. Observations are limited to two minutes, use database request-start time and a five-second event-clock safety band, and preserve deletion intent through `cleanup_requested_at`, including after a tombstone. Compare-and-swap checks both revision and the original discovery timestamp, so a purged/reinserted key cannot be mistaken for the captured row. Near-boundary conflicting events are repaired conservatively.

Normal notifications are acknowledged after their database transaction commits. Ambiguous notifications wait for successful repair publication; publication failures retry only those messages. Repair consumers batch database work while acknowledging successfully applied keys and retrying only keys with failed HEAD requests or revision conflicts. All messages for a duplicated failed key retry together, and successful absence checks are applied as observations. Database snapshot or write failures retry all unconfirmed repair messages. No acknowledgement precedes the database commit for its observation. Ambiguous rows stay unchanged, so a publication failure can safely replay and retry publication. Invalid event and repair payloads are published directly in batches to their respective DLQs, then acknowledged only after publication succeeds. If publication fails, only those rejected messages retry; valid peers still proceed. Transient processing failures keep the existing five-delivery retry budget and automatic DLQ forwarding.

Directly rejected messages use an `invalid_inventory_message` envelope containing the original `body`, queue name, message ID, timestamp, attempt count and validation reason. Ordinary JSON payloads remain previewable in Cloudflare; non-JSON bodies use V8 serialization. A crash after publication and before acknowledgement can duplicate DLQ entries: deduplicate on `(originalQueue, originalMessageId)` and replay the original `body` after fixing the cause. Automatic retry-exhaustion DLQ entries retain their original payload without this envelope. No recovery consumer is installed; the existing setup script creates both DLQs with four-day retention, and deployment configures their producer bindings.
