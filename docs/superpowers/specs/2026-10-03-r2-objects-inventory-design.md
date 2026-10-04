# R2 Objects: Inventory, Queue Ingestion, and Backfill

**Date:** 2026-10-03  
**Status:** Design proposal; implementation and production sizing remain to be validated.

Build `public.r2_objects` as an operational inventory of physical R2 keys. Populate it from live notifications and a resumable historical LIST scan. Maintain it through conditional bulk writes and periodic reconciliation.

This is the first stage of the [R2 object lifecycle proposal](2026-09-30-r2-manifest-object-lifecycle-design.md). It can ship before upload reservation and cleanup read this table. This stage creates no new physical deletion behavior and does not change published CLI contracts.

## 1. Scope and guarantees

The initial deliverable is an inventory that follows R2 with measurable lag and repairs drift. Capture completed objects in each configured bucket, including keys with no manifest reference or corresponding app row. Manifest contents are not the source of the backfill.

Use the same bucket/key scope for notifications, backfill, and reconciliation. Start with all completed physical objects in the selected buckets. Trash objects are separate keys and should also be represented; future cleanup queries can restrict eligible prefixes. Incomplete multipart sessions are outside this inventory.

The normal notification path uses event metadata without an R2 request. LIST handles bulk discovery and comparison. HEAD is reserved for isolated ambiguous cases.

An asynchronous queue cannot make Postgres match R2 at every instant. The operational goal is bounded normal lag, durable handling of failed work, and repeated reconciliation that prevents discrepancies from becoming permanent.

## 2. Table: public.r2_objects

### Lifecycle enum

`public.r2_object_state` contains exactly four values:

| Value            | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `to_be_uploaded` | An upload has been reserved; completion is unconfirmed.                       |
| `present`        | Object presence has been confirmed.                                           |
| `to_be_deleted`  | Irreversibly selected for cleanup; work may be waiting, running, or retrying. |
| `deleted`        | Object absence confirmed; a temporary tombstone remains.                      |

The managed lifecycle is:

```text
to_be_uploaded → present → to_be_deleted → deleted
```

There is no `deleting` state. The queue owns delivery and retry progress. Once cleanup commits `to_be_deleted`, notification ingestion and reconciliation must not return that physical key to `present`.

During this inventory-only stage, discovery normally creates `present` rows and deletion notifications create `deleted` tombstones. The two intention states are defined now for subsequent upload and cleanup integration.

### Columns

| Column                 | PostgreSQL type          | Nullable | Purpose                                                                                                                               |
| ---------------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bucket_name`          | `text`                   | No       | R2 bucket name; part of the primary key.                                                                                              |
| `r2_key`               | `text COLLATE "C"`       | No       | Exact physical object key; part of the primary key. Byte ordering supports indexed scan ranges.                                       |
| `r2_state`             | `public.r2_object_state` | No       | Lifecycle state described above.                                                                                                      |
| `size_bytes`           | `bigint`                 | Yes      | Known object size; must be non-negative when supplied.                                                                                |
| `etag`                 | `text`                   | Yes      | R2 ETag, normalized consistently across notifications and S3 metadata. It is not assumed to be a content hash or generation sequence. |
| `r2_last_modified_at`  | `timestamptz`            | Yes      | Provider object modification time from LIST/HEAD when available.                                                                      |
| `last_event_at`        | `timestamptz`            | Yes      | Latest accepted R2 notification `eventTime`; never replaced with DB processing time.                                                  |
| `last_reconciled_at`   | `timestamptz`            | Yes      | Conservative observation boundary for the most recent successful LIST/HEAD verification applied to this row.                          |
| `tombstone_expires_at` | `timestamptz`            | Yes      | Eligibility time for tombstone removal; NULL for other states.                                                                        |
| `first_seen_at`        | `timestamptz`            | No       | First insertion into Capgo's inventory; default `now()`. This is not the object's creation time.                                      |
| `updated_at`           | `timestamptz`            | No       | Time this row was last changed; maintained by writes.                                                                                 |
| `revision`             | `bigint`                 | No       | Starts at 1 and increments on every accepted change. Protects reconciliation writes from intervening DB updates.                      |

`revision` is one operational addition to the previously discussed columns. It allows a slow R2 observation to be applied only if the row still has the revision read before that observation. It is not a deletion-worker claim.

Use `PRIMARY KEY (bucket_name, r2_key)`. No additional ID is needed initially. Do not add foreign keys to `manifest`, versions, apps, or organizations: orphaned physical objects must remain discoverable.

Initial additional index:

```sql
CREATE INDEX r2_objects_expired_tombstones_idx
ON public.r2_objects (tombstone_expires_at, bucket_name, r2_key)
WHERE r2_state = 'deleted'::public.r2_object_state;
```

Enforce that `tombstone_expires_at` is populated only for `deleted` rows, and require it for those rows. Pending uploads and delete events can have unknown size and ETag.

Keep access internal: RLS enabled, no public or authenticated-user inventory access, and narrowly permissioned internal writes. Any new SQL helper must have an explicit owner, `search_path = ''`, fully qualified references, and explicit grants/revocations.

Do not automatically add this high-churn table to regional logical publications. Decide replication needs before implementation. Measure path/index storage and WAL at representative cardinality.

## 3. Live notification queue

Use a dedicated Cloudflare queue and consumer Worker for R2 inventory, separate from native notifications and plugin request processing.

```text
R2 object-create / object-delete
                ↓
       capgo-r2-inventory-prod
                ↓
   bounded consumer → bulk Postgres write
                ↓
      acknowledge committed messages
```

Register both event types for every bucket in scope. Create events include uploads, copies, and completed multipart uploads; delete events include explicit and lifecycle deletion. Notifications provide the key and action time, with size and ETag on create events. [R2 notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)

### Starting configuration

These are conservative starting values for load testing, not a claim that production capacity has already been measured.

| Setting                     | Initial value                            | Purpose                                                        |
| --------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `max_batch_size`            | `100`                                    | Coalesce writes during upload bursts.                          |
| `max_batch_timeout`         | `10` seconds                             | Flush small batches when traffic is quiet.                     |
| `max_concurrency`           | `2`                                      | Cap simultaneous ingestion invocations.                        |
| `max_retries`               | `4`                                      | One initial delivery plus four retries: at most five attempts. |
| `dead_letter_queue`         | Dedicated inventory DLQ                  | Preserve failed work for investigation and repair.             |
| Message retention           | Explicitly configure four days initially | Establish a known recovery budget.                             |
| Minimum invocation duration | `500 ms` initially                       | Pace transaction frequency under a full backlog.               |

The size or timeout threshold triggers delivery first. Therefore, the ten-second timeout is not a throughput limiter under a backlog. Fixed concurrency limits parallel work; explicit pacing also limits sustained transaction frequency. [Batching](https://developers.cloudflare.com/queues/configuration/batching-retries/), [concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)

Use one checked-out DB connection and one short bulk transaction per valid batch. Release it before any pacing delay or provider request. Do not open a connection or issue a statement per object.

With two invocations, batches of 100, and a minimum 0.5-second invocation duration, the approximate sustained ceiling is:

```text
transactions/second ≈ 2 / max(actual batch duration, 0.5 seconds)
events/second       ≈ transactions/second × actual batch size
```

This gives up to about four batch transactions and 400 events per second under full batches. It permits short bursts in transaction timing; it is not a strict global sliding-window rate limiter.

Pacing belongs inside the awaited handler before completion. Keep it configurable through the project's runtime configuration mechanisms. Deployment settings such as consumer concurrency belong in Wrangler.

Use the existing background Postgres path when provisioned. The code already supports a background Hyperdrive binding and short transactions in `supabase/functions/_backend/utils/pg.ts`. Verify its production deployment rather than assuming that the binding is configured everywhere.

### Batch processing

1. Validate bucket, exact key, action, timestamp, size, and payload bounds.
2. Group by physical key. Collapse exact duplicates and retain the newest distinct timestamp. Preserve conflicting events with an identical timestamp as an ambiguous case.
3. Submit the distinct keys as one structured bulk SQL input. Sort mutations consistently by bucket/key to reduce deadlock risk.
4. Apply eligible conditional updates and collect keys requiring verification.
5. Publish verification tasks in a batch to a separate, tightly limited repair queue, and await successful publication.
6. Acknowledge valid source messages after their DB work and any required repair publication complete.

Await this work in the queue handler. Do not acknowledge first and finish inventory writes in background work.

If a DB commit succeeds but acknowledgement fails, replay is harmless. If repair publication fails, leave the source messages unacknowledged and retry. Ambiguous events must remain classified as needing repair on replay until verification has actually resolved them; do not preemptively apply them and then mistake them for successful duplicates.

Malformed messages must not prevent valid messages in the same batch from committing. They reach the DLQ under the same delivery-attempt cap.

The SQL execution model is one internal call per batch, reachable only by the internal service identity. Normal ingestion looks up at most 100 distinct physical keys through the composite primary key and reads bucket checkpoint state through its own indexed key. Backfill supplies at most 1,000 objects per write. These paths must not introduce broad inventory scans, per-row permission checks, or primary-DB work in plugin endpoints. Verify plans at millions of rows before implementation ships.

## 4. Conditional event application

The comparison and write happen atomically in Postgres. A Worker-side read followed by an unconditional upsert is insufficient.

| Incoming observation                                           | DB action                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Fresh create; no existing row                                  | Insert `present` with supplied metadata and `last_event_at`.                                                             |
| Fresh delete; no existing row                                  | Insert a `deleted` tombstone, including its timestamp.                                                                   |
| Event older than `last_event_at`                               | Ignore as stale.                                                                                                         |
| Equal timestamp and equivalent observation                     | Ignore as duplicate.                                                                                                     |
| Equal timestamp with conflicting presence or metadata          | Request verification; do not choose an arbitrary winner.                                                                 |
| Newer create against `present` or `to_be_uploaded`             | Update metadata and confirm `present`.                                                                                   |
| Newer delete against an ordinary live row                      | Record `deleted` and establish tombstone retention.                                                                      |
| Create against `to_be_deleted`                                 | Preserve deletion intent; update safe observation metadata or report a conflict. Never restore reuse.                    |
| Newer create against an ordinary inventory `deleted` tombstone | Apply the newer create directly; a missing reservation is normal for old CLIs. Managed retirement rules remain separate. |

An inventory tombstone records observed absence. A later verified recreation of an unmanaged key is different from reversing a committed cleanup decision. Before managed cleanup is enabled, its immutable-key/retirement rules must preserve that distinction. No event or repair is allowed to cancel a committed `to_be_deleted` decision.

Events predating an applied reconciliation observation are generally covered by that observation. Use the observation's request-start boundary, with an explicit clock-skew margin, rather than response completion time. Events near that boundary are ambiguous and should be verified.

Cloudflare describes `eventTime` as the triggering action's time; it does not document a strict per-key sequence number. Timestamp comparisons are the normal ordering mechanism, with ties and timing ambiguity handled by repair. Periodic reconciliation remains necessary.

Application lifecycle transitions increment `revision` but do not change `last_event_at`. Exact notification duplicates should avoid row updates and unnecessary WAL.

## 5. Bounded tombstones and old-event admission

Start by evaluating a seven-day event/tombstone window against actual deletion volume. This is a proposed operating value, not a provider guarantee.

After accepting a deletion or verifying absence, retain a minimal tombstone for that window. Keep key identity, ordering/verification timestamps, and expiry; clear obsolete object metadata when appropriate. Duplicate notifications must not extend retention indefinitely.

Every event-application transaction also enforces an age cutoff using the original `eventTime`. Events older than the accepted window trigger current-state repair instead of inserting or deleting inventory blindly.

If a successfully applied current-state observation already covers that old event, acknowledge it as covered rather than scheduling another identical repair.

This closes the resurrection gap:

```text
delete accepted → tombstone retained → stale create rejected
tombstone purged → sufficiently old create requires current-state repair
```

Queue retention alone is insufficient: an old event can be replayed later, and time spent before enqueue is not bounded by queue retention. Cloudflare's configured retention supports up to fourteen days and defaults to four. [Queue configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)

Maintain a durable, monotonic accepted-event floor per bucket in operational checkpoint state. Tombstone GC advances that floor before removing the history it protects. Changing the retention setting must never reopen timestamps for which deletion history has already been discarded. The effective cutoff is the later of that floor and the current rolling age limit.

Keep this bookkeeping in the primary database. A small `r2_inventory_checkpoints` table has a unique key `(bucket_name, job_name, partition_key)`, bounded checkpoint data, update time, and an `accepted_event_floor` for each bucket's admission record. It stores operational progress; retention and throughput settings remain runtime configuration.

Event application reads that bucket's admission record under a short shared transaction lock. GC exclusively advances the record and waits for earlier admission transactions to finish before discarding protected tombstones. This prevents an in-flight batch from using an old cutoff after GC has removed its comparison row. There is no R2 I/O while holding these locks, and ingestion batches can hold shared locks concurrently.

GC removes expired tombstones in indexed, bounded batches. Purge only when their deletion/absence observation is behind the accepted-event floor. Do not enable tombstone GC during the initial scan; enable it after a completed backfill and validation pass.

The approximate retained row count is:

```text
live/reserved objects + distinct keys deleted within the retained window
```

This bounds history in time, but a high deletion rate can still produce a large table. Measure deletion rate, key lengths, storage, and vacuum behavior before selecting retention.

## 6. Historical backfill

### Enable capture first

Create the table and internal write path, enable notifications and the consumer, and verify actual create/delete delivery on a synthetic key. Then start historical listing. Do not leave the consumer disabled while waiting for the full backfill.

Enable capture independently for every configured bucket. Log the activation boundary and keep the scope/version in job checkpoints.

### Resumable streaming scan

Use an operational Bun script with the S3 `ListObjectsV2` API. Request up to 1,000 objects per page without a delimiter when enumerating physical keys. Stream one page at a time; never accumulate millions of keys or fetch object bodies.

R2 supports continuation tokens and `start-after`. Save the last committed key as well as the token, allowing a scan to restart from that key if the token becomes unusable. [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [LIST limits and pagination](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

For each page:

1. Record the request-start observation boundary.
2. LIST the next page and validate the returned metadata.
3. Bulk insert discovered keys as `present`, including size, ETag, provider modification time, and the conservative observation boundary.
4. Use `ON CONFLICT (bucket_name, r2_key) DO NOTHING`.
5. Commit before advancing the durable checkpoint.

Existing rows belong to live ingestion or earlier work. This initial scan must not overwrite them, including deletion tombstones and future reservation/cleanup states.

Checkpoint per bucket/partition: job identifier, scope, scan start, last committed key, continuation token, progress counters, completion state, and update time. Use durable operational storage shared with the dispatcher, not a singleton runtime-configuration table.

If the DB commit succeeds but checkpointing fails, re-read the page; insert-only conflict handling makes replay safe. If the script pauses, re-fetch the pending page on resume rather than applying hours-old cached metadata. Observation age is based on when LIST ran, not the object's potentially old modification time.

Persist failed-record reports privately and keep actual tenant paths and credentials out of git. A partition with unresolved failed records is not complete.

### Backfill write budget

Begin load testing with one backfill writer, one transaction per 1,000-object page, and at least one second between batch starts. That is approximately 1,000 objects per second before latency and pauses.

At that illustrative rate, five million objects require about 5,000 LIST pages and at least 83 minutes of sustained processing. Measure real bucket cardinality and batch latency; this is an estimate, not current production evidence.

Prioritize live ingestion. Pause or slow the backfill when queue lag grows, DB batch latency worsens, or replication/vacuum pressure crosses the agreed budget. The consumer and backfill have separate explicit limits; both count toward total DB capacity.

## 7. Repair and periodic reconciliation

Initial backfill fills missing rows. Reconciliation repairs existing rows and discovers missed notifications in both directions.

### Targeted repair

For isolated timestamp conflicts or old events, a separate repair consumer verifies the current object through a direct R2 binding or S3 metadata request. Avoid cached public URLs and the file-serving endpoint.

Start with one repair invocation, at most ten distinct keys per invocation, and at most two concurrent HEAD requests. Bulk-load DB rows before provider reads and bulk-apply results afterward. Use the same five-attempt ceiling and a dedicated repair DLQ.

Read each candidate's `revision` before R2 I/O. Apply the result only if that revision remains unchanged; for a previously missing row, insert only if it is still missing. If the comparison fails, schedule a fresh observation instead of overwriting the intervening event or lifecycle transition.

Keep observations short and bounded. Never apply an old verification result after a long pause. Ordinary live rows cannot be removed and recreated within this verification interval because deletion tombstones outlive the interval; expired tombstones are not reused as comparison targets.

If a DLQ replay or outage produces many repair keys, coalesce them into LIST reconciliation ranges. Do not turn a large historical recovery into one HEAD per object.

### Two-way LIST comparison

Use a restartable scan over bounded ordered key ranges. A concrete range algorithm:

1. Read a bounded DB key chunk using the composite primary key, including revisions and metadata. Its last key defines the range's upper boundary.
2. LIST R2 from the preceding range boundary with `StartAfter`, following every continuation page until the upper boundary is covered.
3. Stream returned objects into bounded bulk writes. Insert unknown keys; conditionally refresh existing candidates using their captured revisions.
4. Only after the whole range succeeds, mark initially captured `present` DB keys missing from that range as absent, and only if their revisions remain unchanged.
5. Checkpoint the completed range. Restart unfinished ranges with fresh DB revisions and fresh LIST observations.

Keep at most the bounded DB candidate set and one R2 page in memory. If the range expands beyond its time/work budget, split it or restart smaller; do not hold a DB transaction during listing. Include the final R2 tail after the last DB key, so objects missing from the DB are also discovered.

A truncated page is not proof that an arbitrary key is absent. Provider errors or incomplete ranges never become deletion observations. Use byte-compatible ordering and test non-ASCII keys and boundary inclusivity.

Individual R2 reads and LIST calls are strongly consistent, but a multi-page scan is not one atomic bucket snapshot. Concurrent changes are handled by live events, conditional writes, and later passes. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)

Verification boundaries belong to the relevant page/request, not the scan's eventual completion time. Reconciliation also respects irreversible cleanup intent. Updating freshness timestamps across a full inventory produces real row writes and WAL; batch size does not eliminate that cost.

An absent `to_be_uploaded` object is not automatically a deletion: upload confirmation and reservation expiry own that transition in subsequent work. The absence sweep targets `present` rows.

Run reconciliation continuously in bounded chunks through the existing task dispatcher. Add work to `process_all_cron_tasks` when implementation reaches scheduling; do not introduce an independent Postgres cron job. Choose the sweep interval from measured scan duration and an explicit maximum tolerable drift age.

## 8. Capacity, failure handling, and health

The starting limits permit at most two ingestion transactions, one backfill transaction, and one repair transaction concurrently from these components. Pool and Hyperdrive connection budgets must be configured and verified separately; an invocation cap is not a guarantee about all physical DB connections.

Measure the sustained event arrival rate, upload burst size/duration, deletion rate, batch fill, commit p95/p99, and drain rate while unrelated production-like queries run.

```text
backlog growth = incoming events/second − processed events/second
burst drain    = burst backlog / (drain capacity − continuing arrivals)
```

For illustration, a 10,000-event backlog at 400 events/second with no new arrivals takes about 25 seconds to drain. A sustained 500 events/second cannot be served by a 400-event/second consumer. Benchmark and increase the bounded budget, improve the write path, or revise the capacity plan before deployment.

On sustained DB failure, pause consumer delivery through the operational circuit breaker and alert. Do not burn repeated retries as a substitute for waiting out an outage. Failed work remains in the source queue or DLQ and is replayed through normal age checks and repair.

Monitor:

| Metric                                                                            | What it reveals                                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Queue backlog and delivery/event age distributions                                | Whether inventory follows uploads closely and can catch up.          |
| Applied, stale, duplicate, ambiguous, and rejected-old events                     | Whether ordering and repair policies behave as intended.             |
| DB latency, active connections, WAL, dead tuples, and replication lag             | Whether the combined write budget is safe.                           |
| Source and repair DLQs, failures, and oldest outstanding work                     | Whether discrepancies can persist unnoticed.                         |
| Backfill checkpoint, failed records, and last completed reconciliation range/pass | Whether historical coverage is complete and current.                 |
| Missing rows, missing objects, and metadata differences found per pass            | Whether repair converges rather than repeatedly rediscovering drift. |

Because delivery is unordered, the newest observed event timestamp is not a completeness watermark. A healthy queue is necessary but insufficient evidence that a bucket is fully reconciled.

## 9. Implementation sequence and validation

1. Create the enum, table, indexes, internal bulk write helpers, and checkpoint support in one CLI-created migration.
2. Add the dedicated notification queue, DLQ, and bounded consumer.
3. Verify live events and failure replay, then enable capture.
4. Implement and run the insert-only historical backfill with checkpoints and a write budget.
5. Implement targeted repair and two-way LIST reconciliation; complete a validation pass.
6. Enable bounded tombstone GC and establish measured lag/drift targets.
7. Integrate reservation and cleanup behavior in subsequent work.

Before ingestion/backfill ships, cover these cases:

| Scenario                                                | Required result                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Duplicate notification or commit followed by failed ACK | Idempotent replay; no duplicate object row.                                                |
| Delete arrives before older create                      | Tombstone is inserted; older create cannot resurrect it.                                   |
| Replacement create arrives before older delete          | Replacement remains present.                                                               |
| Conflicting events share one timestamp                  | Verification required; no arbitrary timestamp winner.                                      |
| Delete commits while a backfill page is in flight       | Insert-only backfill preserves the tombstone.                                              |
| Notification changes a row during repair/LIST           | Old observation cannot overwrite the changed revision.                                     |
| Tombstone expires, then an old event is replayed        | Current-state repair; no blind resurrection.                                               |
| Old object discovered by a fresh LIST                   | Accepted; old modification time is not an old observation.                                 |
| Truncated/failed LIST or interrupted range              | No absence conclusion from incomplete coverage.                                            |
| Create notification arrives for `to_be_deleted`         | Deletion intent remains committed.                                                         |
| Reconciliation process crashes or resumes               | Checkpointed work replays safely with fresh observations.                                  |
| Millions of rows and concurrent large uploads           | Indexed bounded plans, measured catch-up capacity, and acceptable unrelated-query latency. |

Test normal and worst-case batches, byte ordering, JSON payload size, malformed messages, publication-before-ACK failures, and the full five-attempt budget. Use Postgres-level tests and provider integration tests for the new paths.

The first milestone is complete when historical coverage is known, live ingestion stays within the measured DB budget, and recurring comparison demonstrates that discrepancies are repaired. Physical cleanup remains a later consumer of this inventory.

Implementation guard: `cleanup_requested_at` persists retirement through a deleted tombstone, preventing notification or observation writes from restoring retired keys. A later presence observation queues the key for deletion again. Admission checkpoint floors cannot decrease or be removed, and checkpoint progress timestamps update automatically.
