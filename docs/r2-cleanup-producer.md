# R2 cleanup producer

The production inventory Worker's existing minute cron enables the cleanup
producer. Each run checks live manifest replication health, writes the result to
PlanetScale for the future consumer, then retires eligible objects and publishes
cleanup messages. This producer performs no R2 COPY, DELETE, trash or restore
operations. The deletion consumer is a separate rollout.

## Live health and consumer checkpoint

`cloudflare_workers/r2_inventory/health.ts` opens the Supabase publisher and
standalone PlanetScale inventory connections concurrently. Both metadata queries
start together. The entire operation, including
connections and checkpoint commit, has a five-second deadline. Unknown data,
missing permissions, query/write errors and timeouts skip producer work. Client
connections close on failure, server statement/lock timeouts bound queries, and
late results cannot authorize production.

The source query checks the exact inventory slot and its active sender, WAL
availability, recent subscriber feedback, reported applied position, and expected
manifest publication. The destination checks the exact enabled subscription,
slot/publication identity, running apply worker, manifest readiness and recent
messages. These queries inspect catalog/statistics rows, not manifest contents.
The source SELECT contains `now()`, making it uncacheable through the existing
source Hyperdrive; inventory Hyperdrive query caching remains disabled.

Operating limits are 60 seconds for feedback/message freshness, 30 seconds for
reported replay delay when present, and 64 MiB for outstanding source WAL. These
are conservative operating bounds, not a proof of authoritative absence. A NULL
replay delay at idle is accepted alongside bounded WAL and fresh communications.
Historical error counters are included in diagnostics without permanently blocking
recovered replication. Source WAL distance includes unrelated database activity.

The helper makes no queue API calls and sends no probe messages. Notification,
repair and cleanup backlog, dead-letter messages and consumer availability do not
participate in its verdict. The producer keeps publishing eligible cleanup work
when consumers are down; there is no cleanup backlog cap. Deployment creates and
binds the queue, and the cron requires its normal cleanup queue binding.

The helper upserts `(bucket_name='capgo', job_name='cleanup_health', partition_key='')`
in `public.r2_inventory_checkpoints`. Its JSON checkpoint uses **schemaVersion 3**:

- `healthy`: manifest replication checks passed.
- `observedAt`: destination observation timestamp; `maxAgeSeconds`: 120.
- `manifestReplicationHealthy`, diagnostic `reasons`, and source/destination replication metrics.
- `checkedAt`: invocation-local timestamp, used only for producer freshness.

The producer uses the helper's returned object and never reads `cleanup_health`.
It checks the in-memory result before each transaction and expires it after
30 seconds. The cleanup consumer accepts schemaVersion 3 alongside the legacy
schemas, checks `manifestReplicationHealthy=true`, and retains its independent
observation age bound of zero to 300 seconds. Its remaining health budget bounds
storage work; the writer's `maxAgeSeconds` does not change that consumer policy.
Schema 3 replaces schema 2's queue-dependent verdict and removes its queue flags,
`producerReady` and `deletionBacklog`; older schemas are not the new contract.
Older observations cannot replace a newer checkpoint.
A failed write prevents producer work; an unavailable database leaves prior
consumer evidence to expire normally. The persisted verdict describes replication, not consumer health.

## Deployment and the separate consumer rollout

The stable release workflow creates `capgo-r2-inventory-prod-cleanup` before
binding `CLEANUP_QUEUE` and deploying the enabled producer. The separately added
cleanup consumer retains its deletion safeguards and accepts the new checkpoint
schema. Existing notification and repair consumers retain their settings.
The inventory runtime role needs only column SELECT on `manifest.s3_path` in
addition to its existing inventory/checkpoint grants. The narrow grant was applied
and verified separately before activation; no broader manifest access is required.

The deletion consumer must validate exact committed retirement identity
before R2 work and establish authoritative reference absence, including late
legacy finalization. Inventory retirement and primary manifest writes are separate
transactions: operational replication health and object age do not close that
race. A newly arriving reference may leave an object retired but physically present;
the consumer must preserve referenced objects. This producer cannot physically
remove such an object.

Queue retention is four days. Retirement intent survives in inventory after a
message expires. If the consumer rollout occurs after expiry, its rollout must
recover pending retirements with bounded, resumable indexed pagination and
publish their original retirement identity. This producer does not automatically
redispatch retired rows or reset poison-message retry budgets. The consumer must
include terminal failure/DLQ handling and retain the global maximum of five retries.

## Bounded progress and transaction model

One connection is reused for an entire producer invocation and closed in `finally`.
A dedicated `(bucket, cleanup_producer, '')` checkpoint holds a last fully handled
key, random invocation owner, monotonically increasing fence and 45-second lease.
The PK serializes acquisition. Crashes expire; overlapping runs cannot acquire an
unexpired lease. Admission checkpoints/floors are unchanged. Each transaction
locks/checks the fence before touching inventory and holds that checkpoint lock
through publication and commit. It checks lease expiry again when saving progress.
An old owner cannot overwrite/release a successor's lease. Database statement,
lock and idle-in-transaction limits bound stalls while the checkpoint is locked.

Discovery is outside retirement transactions. A materialized PK keyset page
examines at most 10,000 rows in the bucket's C-collated `orgs/` namespace; the
delta-path predicate and indexed exact manifest probes run only within that page.
Non-delta org rows are examined/ineligible, so sparse namespaces cannot cause an
unbounded scan seeking 10,000 candidates. Candidates must be present, never retired,
in `orgs/{org}/apps/{app}/delta/`, outside trash/ZIP/dot-segment paths, first seen
at least an hour ago, with known modified/event evidence no newer than an hour,
no current manifest lease, and no exact replicated reference. Unknown age is denied.

Each range contains at most 100 discovery candidates plus fully examined gaps.
Lock inventory keys in C order, then recheck every predicate using a new READ
COMMITTED snapshot. Concurrent reservations use those same row locks. Update to
`to_be_deleted`, take the database trigger's exact microsecond retirement timestamp,
publish the messages with Cloudflare `delaySeconds: 30`, then commit the retirement
and examined cursor together. The trigger makes retirement permanent, including
after `deleted`. There is no `deleting` state or reset to present.

The work budget is 20 seconds; stop starting work with fewer than five seconds
left, reserving time for publication/commit/rollback. Discovery statements have a
five-second timeout; transaction statements two seconds, locks 500ms, and idle
transactions five seconds. These starting bounds are not latency guarantees.
Publication has one two-second deadline for the whole transaction, even if split
by bytes. Several pages/ranges may complete in a run. Empty-candidate pages advance
their examined key too. At exhaustion persist an empty cursor and end the run;
the next run revisits behind-cursor inserts and previously leased rows. Budget
interruptions leave unfinished ranges for the next invocation.

A later failure does not undo earlier committed ranges. Any ambiguous commit
terminates the invocation; the next run reloads database progress. Never advance
an in-memory cursor on a failed commit. No scan republishes existing retired rows:
they may be in flight, blocked, or in DLQ. Cron must not reset delivery budgets.

## Queue boundary contract

Messages contain only `schemaVersion: 1`, `bucket`, exact `key`, and
`cleanupRequestedAt`, the permanent identity of this particular retirement.
Revision is mutable and is not a job id. The encoder splits at 100 messages and
256,000 encoded bytes, counting JSON escaping/wrappers conservatively and enforcing
the individual 128,000-byte bound. Current [Cloudflare limits](https://developers.cloudflare.com/queues/platform/limits/)
use decimal KB. [sendBatch](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
resolution confirms durable publication, not consumption. Delay is in Cloudflare,
not a sleep inside the transaction.

Drizzle does not make Cloudflare part of a Postgres atomic transaction. Rejection,
deadline, lease expiry or DB commit failure rolls retirement/progress back, but
cannot revoke messages accepted by Cloudflare. The binding has no AbortSignal.
A timed-out call may resolve later; it must not start additional split-batch sends.

The future consumer **must** load current committed inventory before any R2 action
and require an exact matching retirement identity and expected retired state.
Uncommitted/non-visible retirement retries only that message with a 30-second
delay, within its delivery budget. Old/mismatched/extraneous messages never authorize
R2 work. Recheck reference/reservation safety according to the separately reviewed
consumer contract. A newly found reference preserves R2, retains retirement,
logs/optionally alerts, and acknowledges that message without blocking peers.
No R2 COPY, DELETE, trashing, consumer, Discord notification or local runner is
included here. Tests observe visibility from another connection during publication,
rollback and a later retirement with a different identity.

## Validation and capacity evidence

Unit tests cover enabled scheduling despite queue backlog or unavailable consumer metrics,
absence of health probe messages, concurrent health checks, timeout/write failures, encoded limits,
examined cursor partitioning and late publication. Postgres tests cover actual
Drizzle commits/rollback, reference/lease rechecks, reservation races, ownership
fencing, microsecond identity, partial progress, lost commit responses, page bounds,
zero-result progress/wrap and no redispatch. Health checkpoint tests cover real
commits, rejection of stale observations and cancellation of locked publication.

The exact source health query was validated with production
`EXPLAIN (ANALYZE, BUFFERS)` on 2026-10-15: execution took 1.458ms, inspecting
replication/publication catalogs without reading manifest rows. The exact
destination query returned the expected ready subscription and fresh messages.

Read-only `EXPLAIN (ANALYZE, BUFFERS)` of this PR's exact discovery query on
2026-10-14 examined 10,000 rows through `r2_objects_pkey` and performed 5,612
`manifest_s3_path_idx` index-only probes. Execution took 124.853ms with shared
buffer hits (warm-cache observation); there was no large-table sequential scan.
This does not measure retirement transactions, provider publication or cold-cache
performance and does not prove an overall drain rate.

An earlier bounded discovery measurement examined one 10,000-row page, performed
5,801 indexed manifest probes and returned 820 candidates in 1.505 seconds. This
is one-page evidence, not a dataset benchmark or a throughput guarantee. No large
index is added. Consumer activation still needs a measured backlog drain
calculation including queue/provider/DB limits.
