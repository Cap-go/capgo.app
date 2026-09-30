# R2 Delta Manifest Object Lifecycle

**Date:** 2026-09-30

**Status:** Idea and migration proposal; no implementation is included

**Scope:** Delta-manifest database rows, shared R2 objects, CLI upload compatibility, garbage collection, Cloudflare Queues, and replication/operational cost

---

## 1. Summary

Capgo delta bundles store one database manifest row per logical file while the
underlying R2 object may be shared by several versions. The current cleanup path
checks whether another manifest row references a file, moves an apparently
unreferenced R2 object to trash, and then deletes the manifest row. It performs
this work under a per-file advisory lock and holds the database transaction open
while making external storage calls.

That design has two important problems:

1. It is expensive at production scale: a version can contain thousands of
   files, the manifest table contains millions of rows, and every delete creates
   database work, WAL, logical-replication traffic, and downstream replica WAL.
2. It is still racy with a concurrent delta upload. The CLI decides that an R2
   object can be reused before the new version's manifest rows exist. Cleanup can
   delete the object between the CLI's existence check and the final manifest
   write.

This document explores a safer object-lifecycle model based on a database
inventory with one row per physical R2 object, batch reservations for new CLIs,
server-selected physical paths, and asynchronous garbage collection. It also
describes the unavoidable compatibility boundary for existing CLIs.

The recommended compatibility policy is:

- existing deterministic delta objects are **legacy-pinned** and may be reused
  by new clients, but are not physically deleted while legacy CLIs remain
  supported;
- new reservation-aware clients create **managed**, generation-specific objects
  that can be reclaimed safely;
- version deletion bulk-deletes manifest rows but performs no R2 I/O;
- one collector is the only owner of managed-object deletion;
- signed upload receipts are the synchronous source of truth for upload
  finalization, while R2 event notifications are used for reconciliation;
- before building the full system, consider the simpler option of treating
  shared delta storage as append-only and deleting only entire app or
  organization prefixes after uploads have been permanently disabled.

## 2. Why reconsider the current cleanup design

### 2.1 Current upload behavior

For unencrypted delta uploads, the CLI derives a deterministic physical path
from the organization, app, file hash, and logical filename. It then performs a
file read request for each candidate path. A successful response means "reuse
this object"; otherwise the CLI uploads to that same path.

Relevant code:

- deterministic path generation and the per-file existence check:
  [`cli/src/bundle/partial.ts`](../../../cli/src/bundle/partial.ts);
- manifest submission after all partial files have been processed:
  [`cli/src/bundle/upload.ts`](../../../cli/src/bundle/upload.ts);
- direct manifest persistence:
  [`supabase/functions/_backend/private/set_manifest.ts`](../../../supabase/functions/_backend/private/set_manifest.ts).

The version row exists while files are being checked and uploaded, but its
manifest rows are persisted only after the partial-file phase finishes. For a
large bundle, an early file may remain invisible to manifest-reference queries
for much of the upload.

Encrypted partial uploads are different: their paths contain session-specific
material and the CLI deliberately does not reuse existing objects. The principal
race described here concerns deterministic, reusable delta paths.

### 2.2 Current deletion behavior

The deleted-version handler currently processes manifest entries in small
groups. For each entry it:

1. starts a database transaction;
2. takes an advisory transaction lock derived from the file hash and filename;
3. checks whether another version has a matching manifest reference;
4. if not, performs R2 presence, copy-to-trash, and delete operations;
5. deletes the manifest row and commits.

See
[`supabase/functions/_backend/triggers/on_version_update.ts`](../../../supabase/functions/_backend/triggers/on_version_update.ts)
and
[`supabase/functions/_backend/utils/s3.ts`](../../../supabase/functions/_backend/utils/s3.ts).

The lock serializes competing cleanup workers, but manifest insertion does not
take the same object-level lock. Manifest persistence currently serializes by
version ID, not by physical R2 path.

The current shared-reference test also uses file hash plus logical filename,
whereas physical object identity is the exact `s3_path`. Because the R2 path is
scoped by organization and app, an identical hash and filename under another
physical prefix can suppress deletion without actually referencing the same
object. That failure mode leaks storage rather than deleting live data, but it
shows why the proposed inventory and collector must use exact physical paths.

### 2.3 The upload-versus-cleanup race

One valid interleaving is:

```text
CLI                       cleanup
---                       -------
GET deterministic key
200: object exists
decide to reuse
                          find no other persisted manifest reference
                          copy object to trash
                          delete original object
                          delete old manifest row
POST set_manifest
new live manifest references a missing object
```

The inverse race is also dangerous in an asynchronous-delete design:

```text
cleanup records an intention to delete path A
CLI uploads replacement bytes to path A
cleanup later deletes path A
```

An existing completed R2 object does not inherently make the current upload
fail. The upload handler can write the requested key again; its duplicate-upload
conflict concerns unfinished TUS state. Consequently, a stale deletion can
remove a replacement that the CLI successfully uploaded.

An outbox alone fixes the crash gap between a database commit and scheduling
storage work, but does not fix either race. A queued deletion must identify an
immutable physical object generation, not merely a path that future uploads can
reuse.

### 2.4 Operational cost

The current design combines several expensive operations:

- one database transaction and advisory lock per manifest file;
- external R2 calls while the transaction and lock remain open;
- one row deletion per manifest entry;
- WAL and logical-replication output for those deletes;
- WAL and index maintenance when downstream PostgreSQL instances apply them;
- retry and sweep activity when a large manifest cannot finish in one queue
  execution.

A bulk `DELETE` reduces statement, connection, and commit overhead, but it does
not make row-level WAL disappear. The replication identity and publication scope
of the manifest and any proposed lifecycle table therefore need an explicit
review as part of implementation.

## 3. Goals and non-goals

### Goals

- Remove R2 operations and long-held advisory locks from version deletion.
- Prevent a managed object selected by cleanup from being reused or overwritten.
- Reduce the CLI's per-file existence checks to one bounded batch request.
- Retain deduplication where it is safe.
- Keep published CLI versions working during a deliberate migration period.
- Discover R2 objects that were uploaded but never received a manifest reference.
- Process millions of object and manifest rows with indexed, bounded, resumable
  work.
- Make queue handlers idempotent and compatible with duplicate or out-of-order
  delivery.
- Prefer recoverable failure and leaked storage over deleting a live object.

### Non-goals

- This document does not implement a migration, endpoint, Worker, queue, or cron
  task.
- It does not promise immediate reclamation of legacy deterministic objects.
- It does not remove the WAL cost of deleting manifest rows.
- It does not use Cloudflare Queue delivery as a synchronous upload-completion
  protocol.
- It does not raise the repository-wide queue retry limit above five.

## 4. Fundamental constraint

The system cannot provide all three properties simultaneously:

```text
stable reusable physical paths
+ concurrent physical deletion
+ no coordination between upload and deletion
= unavoidable race
```

Strict correctness requires at least one of:

- a reservation/lifecycle record that both upload and deletion respect;
- shared synchronization before a reusable path is claimed;
- immutable generation-specific physical paths;
- or never physically deleting the shared objects.

The proposal uses short, conditional database state transitions and immutable
managed generations. It intentionally avoids advisory locks held during R2
network operations. PostgreSQL updates still take normal short-lived row and
index locks; removing all database locking is neither possible nor necessary.

## 5. Proposed object inventory

Introduce a conceptual `r2_manifest_files` table containing one row for each
physical delta object. Exact columns are an implementation decision, but the
model needs enough information to express:

- a unique physical `s3_path`;
- organization and app ownership, without storing customer PII;
- a logical content identity, including the file hash, logical filename, and any
  compression or encryption variant needed to avoid false reuse;
- the physical generation or upload identifier;
- object size and ETag when known;
- lifecycle state;
- management mode (`legacy_pinned` or `managed`);
- `last_cli_reserved_at` and/or an indexed `reservation_expires_at`;
- timestamps for discovery, upload confirmation, deletion candidacy, and final
  deletion;
- optional failure and retry metadata bounded by the global retry policy.

One possible state machine is:

```text
TO_BE_UPLOADED
      | signed receipt accepted or matching R2 create event
      v
   UPLOADED
      | zero manifest references and reservation expired
      v
TO_BE_DELETED
      | deletion worker conditionally claims the row
      v
   DELETING
      | exact R2 generation removed or already absent
      v
    DELETED
```

Management mode is orthogonal to lifecycle state:

| Management mode | Existing CLIs can use it | New CLIs can reuse it | Eligible for per-object GC |
| --- | --- | --- | --- |
| `legacy_pinned` | Yes | Yes | No |
| `managed` | No | Yes | Yes |

The registry is an operational index of R2, not a replacement for R2 as the
physical source of truth or for `manifest` as the reference relation.

## 6. New CLI reservation protocol

### 6.1 Batch reservation endpoint

A new CLI calls one authenticated endpoint with the complete or bounded chunk of
manifest candidates. A request can contain the same information already needed
to derive delta paths: logical filename, file hash, compression variant, and
encryption context where applicable.

The server performs set-based reads and writes using one database connection and
returns one decision per file:

```json
{
  "files": [
    {
      "file_name": "main.js",
      "action": "reuse",
      "s3_path": "orgs/example/apps/example/delta/existing-main.js",
      "file_size_receipt": "signed-receipt"
    },
    {
      "file_name": "index.html",
      "action": "upload",
      "s3_path": "orgs/example/apps/example/delta-v2/object-id/index.html"
    }
  ],
  "reservation_expires_at": "timestamp"
}
```

The values above are deliberately synthetic and contain no customer data.

The CLI keeps `file_name` as the logical path inside the bundle and uses the
server-provided `s3_path` as the physical upload and manifest path. The existing
manifest schema already separates these concepts.

### 6.2 Reservation decisions

- If a matching `UPLOADED` object is managed, extend its reservation and return
  its exact physical path.
- If a matching existing object is legacy-pinned, extend or record the
  best-effort reservation and return the legacy path. It remains safe because
  legacy-pinned objects are not eligible for physical deletion.
- If a matching path is `TO_BE_DELETED`, `DELETING`, or `DELETED`, do not revive
  or overwrite that physical generation. Allocate a new path.
- If another upload owns a `TO_BE_UPLOADED` path, either return a retry/wait
  decision or allocate a different generation. Allocating a new generation is
  simpler and avoids coupling two uploads, at the cost of occasional duplicate
  bytes.
- Use a random or otherwise contention-free object generation instead of
  querying for the next integer generation.

### 6.3 Reservation lifetime

A fixed fifteen-minute reservation may be too short for a large bundle on a
slow connection. The implementation must size the lease from measured upload
duration and support bounded renewal. A batch heartbeat is preferable to one
database call per file.

An alternative is an upload-session record with one renewable expiry, but that
requires a clear relationship between the session and every reserved object.
The implementation should choose the simpler model only after measuring the
write and index cost of renewing a large reservation set.

## 7. Upload completion: receipts first, Queue second

### 7.1 Synchronous completion

The current upload path already returns signed manifest-size receipts bound to
the physical path and size. For reservation-aware uploads, `set_manifest` should
submit the exact server-selected `s3_path` and receipt.

In one database transaction, the backend can:

1. verify every supplied receipt;
2. verify that every managed path belongs to the expected reservation and is not
   being deleted;
3. transition matching `TO_BE_UPLOADED` rows to `UPLOADED`;
4. insert the version's manifest references;
5. update version and app counters.

This transaction contains no R2 call. A receipt proves that the Capgo upload
service observed completion for the supplied path and size; it does not make a
later Queue notification part of the correctness boundary.

### 7.2 R2 event notifications

Cloudflare R2 event notifications can publish `object-create` and
`object-delete` events to Cloudflare Queues. They are useful for:

- discovering uploads whose CLI crashed before `set_manifest`;
- recording object size and ETag;
- discovering objects written outside the new reservation protocol;
- reconciling inventory drift;
- confirming deletion outcomes.

They should not make `set_manifest` wait. Cloudflare Queues provide at-least-once
delivery and do not guarantee publication order, so consumers must tolerate
duplicates and late events. Consumer batches are bounded and should be converted
into idempotent, set-based database writes rather than one transaction per
message. The currently documented maximum consumer batch size is 100 messages,
so an upload containing thousands of objects will arrive as many Queue batches,
not one upload-wide database transaction, unless another aggregation layer is
introduced.

A create-event consumer must use conditional transitions. A late or duplicate
event must not move `TO_BE_DELETED`, `DELETING`, or `DELETED` back to
`UPLOADED`. Matching the expected generation, reservation, and ETag where
available prevents stale events from mutating a newer lifecycle.

Official references:

- [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [Cloudflare Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cloudflare Queues ordering](https://developers.cloudflare.com/queues/reference/how-queues-works/)
- [Cloudflare Queues batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)

## 8. Version deletion

When an app version becomes deleted, its handler should:

1. bulk-delete all `manifest` rows belonging to the version;
2. update manifest counters in the same database transaction;
3. perform no R2 presence check, copy, move, or delete;
4. perform no per-file update to `r2_manifest_files`.

This deliberately makes version deletion cheap and deterministic. The inventory
collector independently discovers which physical objects have reached zero
references.

Full bundle archives are version-specific and can retain their existing,
separate deletion policy. This proposal concerns shared delta-manifest objects.

## 9. Detecting unreferenced managed objects

The collector must be driven from a bounded candidate index, not from a full
join or aggregate over millions of rows. Conceptually:

```sql
SELECT f.id, f.s3_path
FROM r2_manifest_files AS f
WHERE f.management_mode = 'managed'
  AND f.status = 'uploaded'
  AND f.reservation_expires_at < now()
  AND NOT EXISTS (
    SELECT 1
    FROM manifest AS m
    WHERE m.s3_path = f.s3_path
  )
ORDER BY f.reservation_expires_at, f.id
LIMIT :bounded_batch;
```

The actual state transition should be an atomic conditional update, optionally
using `FOR UPDATE SKIP LOCKED` inside a short transaction if multiple collectors
run concurrently. This is normal row-level coordination, not a long advisory
lock, and no transaction remains open during R2 I/O.

Required index direction:

- add a non-unique `manifest(s3_path)` index before enabling the anti-join;
- use a partial candidate index over reservation expiry and a stable cursor for
  managed `UPLOADED` rows;
- use a partial index for `TO_BE_DELETED` work;
- keep physical path uniqueness on `r2_manifest_files`;
- ensure every scan has a stable, indexed cursor and bounded batch size.

The current production schema has no direct `manifest(s3_path)` index, so this
collector must not be enabled before the index exists and its production-scale
query plan has been measured.

Per repository policy, implementation should extend the existing cron dispatcher
rather than add an independent PostgreSQL cron job. Incomplete work must commit
progress and be re-enqueued or swept; it must not consume more than five queue
reads as a progress mechanism.

## 10. Physical deletion worker

The deletion worker owns exact physical generations:

1. claim a bounded set of `TO_BE_DELETED` rows with a conditional transition to
   `DELETING`;
2. commit and release the database transaction;
3. move or copy the exact keys to the trash namespace and delete the originals
   in provider-supported batches where appropriate;
4. mark successfully removed or already-absent keys `DELETED` in a set-based
   database write;
5. record bounded failures for retry or a sweeper.

No R2 operation occurs while a database transaction is open. Once an object is
`TO_BE_DELETED`, the new reservation endpoint never returns that path. Once it
is `DELETING`, a new upload must use a new physical generation.

If trash copies generate R2 create notifications, notification rules or the
consumer must distinguish the trash prefix so trash objects are not reintroduced
as live manifest objects.

Queue messages and deletion calls are idempotent. Reprocessing a deletion for a
row already marked `DELETED`, or deleting an already-absent R2 key, succeeds as a
no-op.

## 11. Legacy CLI compatibility

### 11.1 Why the new protocol cannot be imposed on old CLIs

Existing CLIs compute their R2 paths locally. Their existence-check response
contains only existence and an optional receipt; it does not accept a replacement
physical path. The current TUS upload sends that locally computed path as
metadata, and the final manifest reports the same path.

Returning `404` for a legacy path does not redirect an old CLI. It causes the CLI
to upload to the same deterministic path. If that path has already been selected
for asynchronous deletion, the deletion worker can remove the replacement.

Waiting in `set_manifest` for R2 notifications does not solve the problem:

- Queue delivery is asynchronous, duplicate-capable, and unordered;
- older clients may use the legacy `app_versions.manifest` ingestion path rather
  than the direct endpoint;
- the race occurs when the client decides to reuse the path, before final
  manifest persistence.

The upload endpoint does authenticate and restrict writes to an authorized app
prefix, but the client currently controls the suffix of the physical key. A
backend-only rewrite would also require rewriting the manifest and receipt to
the new physical path, which the existing protocol does not support reliably.

### 11.2 Recommended transition: pin and adopt

Backfill existing deterministic delta objects into the inventory as
`legacy_pinned`. A new reservation-aware CLI may reuse such an object directly,
but the collector never physically deletes it while legacy CLIs remain
supported.

New content created by reservation-aware CLIs uses managed generation-specific
paths. This creates a transitional asymmetry:

- new CLIs can reuse old objects;
- old CLIs cannot discover managed objects under new paths;
- if a new CLI creates content first and an old CLI later uploads the same
  content, both physical copies may exist.

This is the compatibility cost of introducing safe reclamation without breaking
published clients.

When the supported-client policy eventually permits retiring the old protocol,
legacy-pinned rows can be converted to managed rows in bounded batches. Live
manifest references continue to protect them; unreferenced rows can then enter
the normal collector.

### 11.3 Do not run two deletion owners over shared paths

If new manifests may reference legacy objects, the current per-version R2
cleaner must not continue deleting those same paths. Otherwise the new protocol
inherits the old race.

During migration there should be one deletion policy:

- manifest rows are deleted uniformly;
- managed objects are reclaimed by the new collector;
- legacy-pinned objects are retained;
- full version archives follow their separate deletion policy.

### 11.4 Alternative: copy on adoption

Instead of referencing a legacy object directly, the server could copy it to a
managed generation and return the managed path. This avoids uploading bytes from
the CLI and isolates new manifests from legacy cleanup, but it introduces one R2
copy per adopted object, temporary duplicate storage, and a potentially large
fan-out for bundles containing thousands of files.

Copy-on-adoption is an optional migration tool, not the default recommendation.
It should be justified by measured storage cost and provider-operation limits.

## 12. R2 inventory population and reconciliation

The table should be populated from physical R2 inventory, not only from current
manifest rows. Doing so makes it possible to discover objects that were uploaded
successfully but never referenced because a CLI crashed or manifest persistence
failed.

A production backfill must:

- list only relevant delta prefixes;
- use provider cursors and resumable checkpoints;
- upsert in bounded database batches;
- classify existing deterministic objects as legacy-pinned;
- never reset a newer lifecycle state during reconciliation;
- keep a report of malformed keys and failed records;
- throttle database writes and monitor replication lag;
- avoid downloading object bodies when metadata is sufficient.

New R2 create/delete events then maintain the inventory incrementally. Periodic
reconciliation remains necessary because the Queue is an event transport, not
the sole source of physical truth.

## 13. Replication and database considerations

This design removes per-file transactions and R2 calls from version cleanup, but
it does not remove row churn automatically.

Before implementation:

- Measure the logical replication payload produced by current manifest deletes.
- Review why `manifest` uses `REPLICA IDENTITY FULL` despite having a primary key.
  If every subscriber can apply deletes using the primary key, changing replica
  identity may reduce logical delete payload. It will not eliminate source or
  subscriber WAL and must not be changed without validating the replication
  topology.
- Decide whether lifecycle rows are needed on every logical subscriber. If not,
  review whether the table can remain outside that publication rather than
  replicating high-churn operational state across regions.
- Measure index size and write amplification before storing long R2 paths in
  several indexes. A compact surrogate key or carefully chosen path identity may
  be preferable, while exact path equality must still be verified.
- Run production-scale `EXPLAIN (ANALYZE, BUFFERS)` for the bounded anti-join and
  reservation queries.
- Monitor autovacuum, dead tuples, lock waits, replication lag, WAL volume, and
  subscriber apply latency during backfill and rollout.

The lifecycle table trades expensive, poorly coordinated external work for
explicit database state. That trade is valuable only if queries are bounded and
the table's publication and index strategy are deliberate.

## 14. Simpler alternative: append-only delta storage

Before implementing the lifecycle system, measure whether individual shared
delta-object reclamation is economically necessary.

The simplest safe architecture is:

- bulk-delete manifest rows when versions are deleted;
- never physically delete shared delta objects at version scope;
- continue deleting version-specific full bundle archives;
- delete an entire app or organization prefix only after the owner is permanently
  deleted or disabled and new uploads are impossible;
- measure unique delta storage growth over time.

Because deterministic delta objects are content-addressed and reused, retained
storage grows with unique content rather than directly with the number of
versions. Depending on the measured ratio, R2 storage may cost less than exact
garbage collection, cross-region database churn, and the operational risk of
deleting live objects.

This option removes the upload/deletion race and all per-file cleanup locks
without requiring a new table. Its cost is unbounded unique delta storage for
active apps until whole-prefix deletion. It can serve either as the final design
or as a safe phase zero while the managed lifecycle is developed.

## 15. Problems solved by the managed design

- **Upload-versus-delete correctness for managed objects:** deletion targets an
  immutable physical generation that new reservations cannot reuse.
- **No external I/O in database transactions:** R2 operations occur only after a
  short state claim commits.
- **No per-file advisory-lock cleanup:** version deletion becomes one bounded
  database operation.
- **Fewer CLI round trips:** one reservation request replaces thousands of R2
  existence requests.
- **Crash recovery:** uploaded but unreferenced objects remain discoverable in
  R2 inventory and event reconciliation.
- **Duplicate and delayed Queue safety:** conditional, generation-aware state
  transitions make consumers idempotent.
- **Backward-compatible reuse:** new clients can reuse pinned legacy objects.
- **Bounded garbage collection:** indexed candidate scans and resumable deletion
  batches avoid full-table work.

## 16. Limitations and accepted trade-offs

- Legacy objects cannot be both safely reclaimed and transparently reusable by
  unchanged old CLIs. Pinning defers their reclamation.
- Old clients cannot reuse new generation-specific paths, so temporary duplicate
  storage is possible.
- Deleting millions of manifest rows still produces WAL and replica work.
- The inventory table itself adds rows, indexes, updates, and possibly logical
  replication traffic.
- R2 notifications improve reconciliation but cannot provide exactly-once or
  ordered lifecycle transitions.
- A reservation lease reduces races only when every managed client respects it;
  legacy safety comes from pinning, not from pretending old clients reserve.
- A short lease can expire during a slow upload; renewal and timeout values must
  be based on measured worst cases.

## 17. Observability required before enabling deletion

At minimum, expose and alert on:

- inventory rows by lifecycle state and management mode;
- age of the oldest `TO_BE_UPLOADED`, `TO_BE_DELETED`, and `DELETING` row;
- reservation endpoint latency, rows processed, and allocation/reuse ratio;
- collector rows scanned versus rows transitioned;
- R2 objects deleted, already absent, failed, and restored from trash;
- Queue lag, duplicate-event count, stale-event no-ops, and dead-letter volume;
- live manifest references whose R2 object is missing;
- R2 objects absent from the inventory and inventory rows absent from R2;
- database lock waits, query latency, connection usage, autovacuum health, WAL,
  logical replication lag, and subscriber apply lag;
- legacy-pinned and managed storage growth.

Managed deletion should begin in report-only mode. The first production passes
should identify candidates without changing lifecycle state or touching R2.

## 18. Suggested rollout

### Phase 0: remove immediate risk and measure

- Consider stopping per-version physical deletion of shared delta objects.
- Keep bulk manifest cleanup and full archive cleanup separate.
- Measure unique delta storage growth, current cleanup duration, lock waits, WAL,
  replication traffic, and orphan counts.
- Decide whether append-only delta storage is acceptable without further work.

### Phase 1: schema and query foundations

- Add the direct manifest path index.
- Introduce the lifecycle table and indexes without enabling deletion.
- Review replica identity and publication scope.
- Add query-plan and production-scale database tests.

### Phase 2: inventory backfill and report-only reconciliation

- Backfill R2 delta objects as legacy-pinned.
- Add idempotent R2 notification ingestion.
- Reconcile table, R2, and manifest state without deleting objects.
- Validate throughput, replication cost, and correctness metrics.

### Phase 3: reservation-aware CLI protocol

- Add the batch reservation endpoint.
- Release a CLI that uses server-selected physical paths.
- Keep all existing CLI paths functional.
- Use capability participation, not only a claimed CLI version header, to decide
  whether an upload follows the managed protocol.

### Phase 4: receipt-based finalization

- Bind reservations, receipts, and manifest insertion in one transaction.
- Keep Queue events as reconciliation only.
- Add abandoned-reservation recovery and bounded sweepers.

### Phase 5: managed deletion

- Enable report-only candidate selection first.
- Transition managed candidates to deletion states in small batches.
- Enable idempotent R2 trash/delete processing outside database transactions.
- Keep legacy-pinned paths ineligible.

### Phase 6: legacy retirement

- Measure managed-protocol adoption.
- Follow the published-CLI compatibility policy before changing support.
- Only after the support window closes, convert legacy-pinned objects to managed
  in bounded batches or perform a separate archival migration.

Each phase should be independently reversible. No phase should depend on a `202`
response meaning asynchronous work has completed.

## 19. Decisions required before implementation

1. Is append-only shared delta storage acceptable after measuring its real
   monthly growth?
2. If not, how long must legacy-pinned objects remain protected?
3. Should legacy adoption reference the original path or perform an R2
   server-side copy into a managed generation?
4. What reservation duration and renewal protocol covers measured large-bundle
   upload times?
5. Which exact logical identity fields make two files safe to reuse across
   compression and encryption variants?
6. Should lifecycle rows be included in the logical replication publication?
7. Can `manifest` safely use primary-key replica identity instead of full-row
   identity in the deployed topology?
8. What trash retention period is long enough for operational recovery?
9. What report-only success criteria must be met before managed deletion is
   enabled?

## 20. Recommendation

Adopt the following direction unless measurements support the simpler
append-only option:

1. Remove R2 work from deleted-version manifest cleanup.
2. Use one physical-object inventory and one deletion owner.
3. Pin and reuse legacy deterministic objects; do not run the old per-file R2
   cleaner in parallel over them.
4. Allocate generation-specific paths for new managed objects.
5. Let new CLIs reserve all manifest files in one batch and use returned paths.
6. Finalize uploads synchronously with signed receipts and manifest insertion.
7. Use R2 notifications for idempotent reconciliation, not correctness-critical
   waiting.
8. Detect zero-reference managed objects through bounded indexed anti-joins.
9. Perform R2 deletion only after committing a short lifecycle-state claim.
10. Defer legacy reclamation until published-client compatibility permits it.

This direction makes the trade-off explicit: temporary legacy storage retention
is preferable to database contention or deleting objects that an in-flight or
published client can still reference.
