# Plugin state in Workers KV

The plugin worker can answer `/updates`, `/updates/manifest_size`, `/stats`, and
all `/channel_self` methods from precomputed state. The deprecated `/plugin/*`
aliases use the same handlers. Snapshot readers reuse the existing response
logic. Stats collection and device channel writes retain their existing sinks.

The database remains the source of truth. Statement triggers enqueue changed
apps, bundle names, manifests, and device overrides. The API worker reads the
primary on this write path, writes immutable KV documents, and conditionally
publishes pointers to them in R2. It then queues the app's Cache API purge.
Plugin requests never rebuild state from the primary.

## Consistency and latency

Cache API serves successful document reads for 30 seconds at each Cloudflare
location. On a miss, the reader gets the logical key's pointer through the R2
binding, validates its generation and immutable KV key, then reads that exact
KV value. Popular app and manifest documents can reuse a parsed copy in isolate
memory only after checking the Cache API's publication-generation revision.
Pointer lookup and JSON decoding share a 50 ms deadline; the subsequent KV
value read has its own 50 ms deadline. A timeout discards the late result and
falls back to the existing replica path. Each request may load at most 16
distinct document keys, with at most four concurrent document loads. Oversized
stats or manifest-key fanout uses the existing batched replica query instead.
Build timestamps are not cache identities: two publications can have the same
millisecond timestamp. A successful snapshot request
opens no SQL connection. A document miss can require both an R2 read and a KV
read; it is not a KV-only cache miss.

R2 provides strongly consistent object reads and conditional writes. Each
database claim allocates a monotonically increasing generation from
`public.plugin_state_sync_generation`. The writer first stores a uniquely named
KV value, then advances its R2 pointer with an ETag condition, or a create-only
condition when no pointer exists. It retries contention at most five times and
never replaces a pointer whose generation is equal or newer. A worker that
resumes after losing its database lease therefore cannot replace a newer
published value. Deletions retain a generation-bearing pointer with `kvKey: null`.

These conditions protect each logical key, not an atomic snapshot of all keys.
The app document is published after its dependencies, but different keys can
still become visible at different times. KV remains eventually consistent;
Cloudflare documents that writes and negative lookups can remain stale for
60 seconds or more. A 30-second KV `cacheTtl` is not a propagation guarantee.
If R2 points to an immutable value that a location cannot read yet, the reader
falls back to the replica. The Cache API can retain a previous published value
until its 30-second TTL or a purge; R2 consistency does not bypass that cache.
Missing document results have a separate 60-second negative TTL. Plugin-state
entries use their own app tag, separate from DB/control and snippet caches.
Writer publications purge only that namespace; they do not use the replica-lag
re-purge ladder. KV-sourced answers must not fill the shared DB read cache or
teach the snippet answers that can be served outside the KV cohort.
The snippet must also refuse direct on-prem/plan-response cache learning from
KV-marked Worker responses; skipping only the snippet fill header is not enough.
Deploy that snippet guard before enabling any read cohort, while preserving
all existing DB-sourced snippet cache behavior and response contracts.

Read failures, invalid documents, missing bundle-name keys, and missing manifest
keys use the existing replica path, including in authoritative app mode.
Backfill publishes channel-referenced manifests; historical and unpublished
bundles may still need the replica. The writer estimates manifest size in
Postgres before loading its rows. Estimates above 4 MiB get a
`fallback: 'replica', reason: 'worker_memory_limit'` marker; estimates above KV's
25 MiB value limit, or a final serialized value exceeding that limit, use
`reason: 'kv_value_limit'`. These explicit markers keep valid large bundles on
replicas instead of producing repeated upload failures or truncated data.

Apps with at most 500 forced overrides inline the complete override map. Larger
sets use per-device documents. Removing a known override publishes
`{ channel_id: null }`, which is distinct from a missing key. A missing key for
a device outside the inline map falls back rather than treating an unsynced
forced override as absent. Authoritative mode applies to app existence only;
it does not waive these dependency checks.

For apps above the 500-override inline limit, devices without a published
per-device pointer intentionally use replicas. This can include most devices
that never had a forced override. Treat their fallback rate, request latency,
and R2/KV/database operations as an explicit rollout and cost gate. Small-app
cache-hit measurements cannot establish the savings or latency of that cohort,
and this fallback still requires the replicas to remain available.

Do not infer worldwide latency or release visibility from local workerd. Keep
all regional replicas and Worker placement until production measurements prove
that both request latency and time to observe changes meet the existing
behavior in every region. This change does not consolidate or remove replicas.

References: [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations),
[KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/),
[KV limits](https://developers.cloudflare.com/kv/platform/limits/).

## Controls

| Setting | Scope | Default and purpose |
| --- | --- | --- |
| `CAPGO_PLUGIN_STATE_SYNC_ENABLED` | Vault | Disabled. Set to `true` to enqueue changes and run backfill. |
| `PLUGIN_STATE_KV` | Plugin Worker runtime | Off. Accepts `off`, `on`, or a percentage such as `1%`. Sampling is stable by app and device across endpoints. |
| `PLUGIN_STATE_KV_AUTHORITATIVE` | Plugin Worker runtime | False. Leave false during backfill so absent apps use replicas. Enable only after verifying complete coverage. |
| `PLUGIN_STATE_KV_STRICT` | Plugin Worker runtime | False. Tests enable it to reject database reads that escape a KV session. |
| `PLUGIN_STATE_TIMING` | Plugin Worker runtime | Off. Accepts the same percentage syntax and samples both response paths. |

Set read/timing shares with the internal per-environment commands:

```sh
bun run plugin-state:set 0.1% prod_eu --dry-run
bun run plugin-state:timing 1% prod_eu --dry-run
```

Remove `--dry-run` only during an authorized rollout. Both commands require
explicit environment names: they never default to all production regions.
Keep `PLUGIN_STATE_KV`, its authoritative/strict settings, and
`PLUGIN_STATE_TIMING` out of the shared `.env.prod`. The production plugin bulk
upload commands reject those keys rather than overwriting regional canaries.
The strict flag remains false outside tests; leave authoritative mode false
during rollout. Requests without a device ID use the DB path under a percentage
share rather than sampling an entire app as one device.

Both the `PLUGIN_STATE` KV namespace and the `PLUGIN_STATE_POINTERS` R2 bucket
must match between API and plugin workers in each environment. The pointer
buckets are provisioned and bound for production, preproduction, and alpha;
local workers share a local pointer bucket. Provisioning those bindings does
not enable reads or sync. Rollout remains off until the controls above are
explicitly enabled. The sync endpoint requires the existing internal API secret.

## Sync limits and SQL execution model

All new SQL functions use an empty search path and qualified object names.
Internal RPCs are restricted to `service_role`; the migration changes no
published CLI RPC or existing grant. No new function runs in plugin-request
RLS or per-device SQL reads.

Repair-status checks run once per claimed app that needs an app document but
holds no full job, at most four apps per claim. The three existence checks use
the app primary key, the pending-full app index and the failed-key primary key.
ACK completion checks likewise run per settled app, rather than per source row.
Explicit full repair clears completion markers once per selected app; selecting
all apps is an operator-triggered repair operation, not a device request.
The selected set includes apps known only by pending or archived work, so a
deleted app's unfinished cleanup remains discoverable. Explicit repair resets
exhausted pending budgets without releasing live leases, and moves archived
exact keys back to pending. Durable enqueue and marker changes commit together;
an insertion error fails the repair call. A wake failure leaves the queued work
for the existing tick.

The enqueue trigger runs once per source statement over transition tables,
including writes reached through authenticated APIs and internal jobs. It
records changed keys without rebuilding state inside the transaction. Joins
use the owning app, org, version, and channel indexes from `prod.sql`. Delta
size changes find affected versions through the existing `version_files`
GIN index. Large maintenance writes still pay for every affected version;
stage their query plans before enabling sync for a bulk backfill.

The schema dump supplies indexes and constraints, not production row counts.
Manifest-related data has millions of rows per the repository scale contract.
Sync does not scan that dataset per plugin request. It loads one selected
bundle's manifest with indexed version lookup. A 5,000-file bundle normally
fits one immutable KV document. Tests cover that size and a separate
1,001-manifest pagination check that resumes across invocations. These are
local checks, not a production throughput benchmark.

Source reads use at most four concurrent primary transactions per drain.
Each bounded app snapshot, manifest, or source page uses
`REPEATABLE READ, READ ONLY` through `withPgTransaction`. Its data is
materialized, the transaction commits, and the checked-out client is released
before KV/R2 I/O. Claim and acknowledgement operations use a separate control
connection. Manifest-size estimation and row loading share one source snapshot
so a concurrent upload cannot invalidate the estimate. These internal
publication reads do not change the plugin request path or the global
Hyperdrive cache configuration.

Each drain has a 20-second budget and shares an 800-operation allowance across
all accounted KV and R2 operations, including pointer reads, conditional write
retries, listings, and garbage collection. At most four apps run concurrently,
with at most 48 pending rows claimed per app. A claim receives one generation;
repeated jobs for the same logical key are deduplicated within that claim.
Enqueue also deduplicates each logical key within its producer transaction,
using a transaction ID and fixed-width key hash. A 5,000-file upload can touch
the same version repeatedly through row triggers without queuing thousands of
copies. Separate producer transactions always retain separate invalidations,
including while an earlier change is leased. They do not conflict on this
transaction-scoped unique index.
Each new claim uses a fresh generation and fresh source snapshots. Empty
claims blocked only by cooldown/lease return a bounded retry delay; the drain
can reclaim within its remaining 20-second budget instead of waiting solely
for the periodic tick. A full job is included ahead of ordinary backlog rows,
and a full job in backoff blocks an implicit restart, including repairs of
previously completed apps. Ordinary version/device keys and bounded app
snapshots still publish, so forced overrides do not wait for that cursor's
backoff. ACK settles those ordinary jobs without changing the cursor or
claiming full completion. ACK collapses full continuations only when the
lease held full work or supplies a continuation; an unrelated acknowledgement
preserves a cursor in backoff. It persists progress atomically under a live
lease, preserving newer explicit reset requests. Explicit repair clears the
old `full_synced_at` marker, and an older ACK cannot restore it while another
full job or archived full failure remains.
Full sync pages bundle names and device keys by indexed cursors, in pages of
48, then resumes manifest publication with its own cursor. Cleanup lists at
most 48 logical pointer keys per page so four apps share the same provider
allowance. Manifest cursor batches contain at most two IDs, but one shared
manifest gate per drain spans both materialization and publication. Only one
manifest document at a time can occupy that gate across all apps in the drain.
Successful, failed, and deferred settlements enforce a per-app cooldown so
another invocation cannot immediately overwrite the same key. Failed work
gets at most five leases, then retains its exact key in the repair archive.
Capacity continuation does not spend the provider failure budget.
A pending full cursor in backoff or an archived full failure blocks implicit
full-scan restarts and app-manifest continuations from ordinary changes.
App jobs still publish a current app
snapshot, including channel/plan changes and deletion tombstones, and individual
version, device and manifest jobs still publish their keys. The app snapshot
does not claim newly served manifests were prepared; missing dependencies use
replicas. No history or served-manifest scan starts implicitly from this path.
The existing cursor or archive remains; an archived full failure requires an
explicit operator repair.

R2 metadata includes a content digest that excludes the snapshot's `built_at`.
Unchanged refreshes still write an immutable value and advance the generation
fence: skipping that fence could let a delayed writer replace current state.
Only redundant purges are skipped. Retries and explicit full resets request a
conservative purge even if the content digest is unchanged: a previous attempt
may have advanced a pointer without committing its purge. Changed full-sync
pages also purge the isolated KV namespace, without purging DB/control/snippet
entries or scheduling the existing replica-lag repeat ladder.

The immutable keys avoid repeatedly overwriting one KV key, while the pointer
comparison enforces publication order. The per-app cooldown remains in place.
The five-attempt queue retry ceiling is separate from the five conditional
pointer-write attempts within one publication. Neither limit is a progress
budget for large apps; resumable continuations handle unfinished work.

Larger override sets require an additional document lookup per device. Account
for R2 pointer operations, immutable KV writes and storage, KV reads, and replica
fallbacks when projecting cost. This implementation has no Bloom filter.
Measure Cache API miss rates and provider operations before forecasting savings
or removing database infrastructure.

## Garbage collection and database restore

The writer uses remaining drain capacity for resumable immutable-KV cleanup.
Its cursor and two-minute lease live in `plugin_state_sync_state`. Completed
passes run daily; partial pages resume through the existing sync tick, without
a new cron job. If a deadline interrupts a page, that page is replayed.

A candidate must be at least 24 hours old, have valid identity metadata, and
match its derived immutable key. A strong R2 read must prove that a newer pointer,
or a same-generation deletion pointer, has superseded it. Current values, keys
with missing or older pointers, and invalid metadata are retained. Pointer
objects and their deletion markers are not removed by this KV cleanup; they
also preserve the generation ordering fence.

Full repair still advances an existing tombstone's generation. A paused
writer can outlive its two-minute lease: an older deletion at generation 1
must not permit a delayed generation-2 live write after generation-3 cleanup.
Skipping the tombstone refresh or deleting the pointer after a time grace
period would reopen that race. Pointer tombstones therefore have no age-based
expiry in this design.

Pointer writes store generation metadata atomically with their JSON body.
Cleanup requests that metadata in the strong R2 listing and reuses the listed
generation and ETag for its first conditional write. This removes one Class B
GET per key when metadata is available, including tombstones. Legacy or invalid
metadata uses a GET; an ETag conflict rereads the pointer before retrying, with
the existing five-attempt ceiling. No generation fence is weakened.

Full cleanup has linear cost in all historical pointer keys, including deleted
ones. For H absent keys with current metadata it needs H pointer PUTs plus the
paged listings; conflicts and legacy keys add reads. Every invocation remains
within the shared 800-operation budget, but storage grows with historical key
cardinality. Measure that growth and estimate repair costs before large full
resyncs. Normal daily reconciliation refreshes app documents and does not scan
fully synced apps' version/device history. The history scan is for initial
backfill, explicit full repair, or deleted-app cleanup. Safe permanent
compaction requires a separate namespace or coordinator design that can fence
every delayed publisher.

R2 can outlive a PostgreSQL restore. Restoring an older sequence while retaining
newer R2 pointers makes valid restored writes look obsolete. Before restoring,
turn off plugin KV reads and the Vault sync switch, stop all old writer and GC
invocations, and verify none can resume against the retained buckets. Keep
replicas available during recovery.

For retained buckets, inspect pointer generations with bounded pagination and
advance the restored publication sequence beyond the greatest surviving
generation before restarting writers. Do not reset the sequence or infer its
safe value from the restored database alone. Alternatively, provision a fresh
KV namespace and pointer bucket together and update every matching binding.
Keep reads off until a full backfill, queue/GC checks, purge checks, and response
parity checks pass. Re-enabling the old writer before this audit can acknowledge
work without replacing higher-generation pointers.

## Progressive rollout

1. Verify matching namespace and pointer-bucket bindings. Deploy the snippet's
   KV learning guard first, then the migration and API/plugin workers with
   `PLUGIN_STATE_KV=off`. Verify the API understands the isolated purge scope
   before enabling the writer. Before enabling any writer work,
   establish primary-load, replica-QPS/result-bytes, purge-rate/queue-depth and
   existing edge/snippet-hit baselines and stop conditions. Do not change
   public API or CLI permissions.
2. Enable the Vault sync switch. Run `public.plugin_state_sync_tick()` through
   internal operations to begin or resume automatic backfill. Watch those
   baseline metrics while the writer runs. The read percentage does not limit
   synchronization/backfill or garbage-collection work. An off deployment still
   adds statement triggers and configuration checks; do not describe it as an
   unmeasured zero-cost change.
3. Verify that every live app has `full_synced_at`, backfill has finished, due
   work drains, no leases are stuck, and the failed-work archive is empty.
   Check pointer publication and immutable-KV reads together, including missing
   dependencies, explicit deletion markers, and manifests marked for replicas.
   Exercise a real bundle publish and channel setting change. Verify sync and
   cache purge success logs.
4. Enable a small timing sample and `PLUGIN_STATE_KV=0.1%` for one existing
   regional worker, using an explicit environment target. Leave authoritative
   and strict modes false and replicas available.
   Compare status, errors, p50/p95/p99 request duration, KV fallbacks, and release
   propagation with the DB cohort in the same region and time window. Include
   pointer-cache misses, cold immutable keys, R2 operation counts, and contention
   failures. Measure apps above 500 forced overrides separately, including
   devices without published per-device pointers. Do not reuse mutable-publication
   benchmark results for this gate.
5. Raise the share only when both request and change-propagation measurements
   pass. Repeat across regions. Stable sampling keeps each device in one cohort
   across endpoints. At each share increase, compare snippet on-prem, plan-block
   and edge-answer hit rates, app-status/read-cache hit rates, and Worker
   invocations per incoming device request with the regional baseline. KV
   responses cannot refill those shared caches; only DB-served responses,
   including fallbacks, can. As the DB share shrinks, shared entries can expire
   without replacement, sending more traffic to Workers. Observe a window that
   includes their TTL expiry and measure provider operations, CPU, latency and
   total cost with the resulting Worker traffic. Stop or roll back an increase
   if the latency or cost gates fail. Complete state coverage alone does not
   qualify a region for `on`; the cache and Worker gates must also pass.
6. Treat removing placement or database infrastructure as a separate measured
   rollout. The current PR keeps both available for rollback.

Set `PLUGIN_STATE_KV=off` on every enabled regional Worker to stop new KV
sessions once the setting has applied. This affects new requests, not in-flight
ones. Existing CDN and app-status caches keep their TTL behavior. KV responses
must not have populated shared DB/snippet caches; when upgrading from an older
experimental revision that could do so, purge those affected caches as part of
rollback. Keep the writer running while investigating a read-path problem.

### Writer pause and recovery

Turn KV reads off in **every enabled region before** disabling the Vault writer
switch. While that switch is off, source changes are intentionally not queued.
Daily app-document reconciliation does not reconstruct all version-name,
per-device or manifest keys, including deletion markers. Do not turn reads back
on merely because the writer restarted or the visible queue is empty.

An untracked source gap requires a **fresh KV namespace and fresh pointer
bucket** before reads resume. A full repair in the old namespace is not enough:
a hard-deleted historical manifest may no longer have a source row or queued
reference from which its old pointer can be discovered. Its stale KV value
could otherwise remain readable indefinitely.

With reads still off, stop old writer invocations and bind every API/plugin
Worker consistently to the new namespace/bucket pair. Drain old requests and
purge or let all old plugin-state Cache API entries expire before reads resume.
Keep old resources quarantined until recovery is verified. Re-enable sync,
explicitly enqueue a full repair with
`public.enqueue_plugin_state_full_sync(NULL)`, and wait for its full cursors
and pending work to drain. The enqueue clears earlier `full_synced_at` markers;
verify that every live app receives a new completion marker and that no full
failure remains archived. An empty queue alone does not prove completion.
Include deleted-app bookkeeping in the repair.
Fresh missing historical manifest keys correctly use replicas rather than
requiring an unbounded scan of all historical manifest files.

Verify live and deleted versions, forced-override removals and manifest
changes made during the pause, plus cache purges and the failed-work archive,
before restarting a small read cohort. Budget recovery from historical key
count and measured throughput; it can be expensive. An explicitly recorded
failed key can be repaired in place when there was no untracked gap, but that
does not justify reusing the old namespace after an unknown set of changes.

The reader cannot detect every semantically stale but valid document. A
swallowed enqueue error can miss work just as a writer pause can. An exhausted
or missing publication is an incident: disable affected KV reads and repair
from the source. Do not assume that daily app refresh or a successful unrelated
publication repaired non-app dependencies. Failed archive entries require an
explicit repair; do not reset poison-job retry budgets automatically each day.

Source snapshots use fresh, bounded internal repeatable-read transactions on
the primary, after which provider I/O runs with the transaction released. This
is background publication, not a device request or a request-path Hyperdrive
cache bypass. Gate primary load before increasing writer/backfill work.

Timing logs have `message=plugin_state_request_timing`, the path, method,
response source, status, Cloudflare colo, duration in milliseconds, and sampling
basis points. Sampled requests also record `r2_pointer_reads`,
`r2_pointer_ms`, `r2_pointer_timeouts`, `kv_value_reads`, `kv_value_ms`, and
`kv_value_timeouts`.
The durations and operation counts are per-request totals for each provider;
cache hits contribute zero provider operations. Gate rollout on R2 time,
timeout rate, and Class B operation counts separately from KV latency and reads,
including cold documents and replica fallbacks. Keep the KV value `cacheTtl`
at 30 seconds until negative-lookup caching and propagation are verified.
These logs measure Worker wall time, not network RTT. `X-Plugin-State`
identifies KV, misses, errors, and fallbacks; requests rejected before state
selection need not carry it.

## Verification and benchmark

Run formatting/lint before validation:

```sh
bun run lint:backend
bun run typecheck:backend
bun run check:plugin-runtime
bun run check:plugin-worker-size
```

Start this worktree's local services and enable strict KV reads:

```sh
bun run supabase:start
PLUGIN_STATE_KV=on PLUGIN_STATE_KV_AUTHORITATIVE=true PLUGIN_STATE_KV_STRICT=true \
  ./scripts/start-cloudflare-workers.sh
```

In another terminal:

```sh
bun run supabase:with-env -- bun run test:cloudflare:plugin:kv
USE_CLOUDFLARE_WORKERS=true PLUGIN_STATE_BENCH_OUTPUT=.context/plugin-state-benchmark.json \
  bun run supabase:with-env -- bun scripts/benchmark-plugin-state.ts
```

The existing plugin suite runs against both modes in separate CI jobs. The KV
setup drains committed changes before ordinary assertions and rejects reported
fallbacks. Dedicated differential tests explicitly select each local path and
assert identical status and JSON. The local override header is ignored outside
local worker environments.

Legacy channel-list SQL has no ordering contract. A no-op SQL update can move
a heap row without changing any channel settings; this can change list order
without requiring a semantic state publication. Snapshots keep the source scan
order at publication, rather than introducing alphabetical ordering. Exact
array comparisons refresh the test fixture after those no-op setup writes.
The only response value excluded from equality is an absolute retry timestamp,
which is validated against each request's clock interval and retry duration.

The benchmark uses isolated invented fixtures. It reports sample counts and
latency distributions for existing/new bundle checks, channels, stats, and
manifest sizes. The cache-tag-purge scenario is reported separately from warm
reads; it removes tagged entries only. DB caches that are intentionally
untagged, including the original v1 manifest-size maps, keep their normal TTL.
Before creating any fixture, it checks `public.plugin_state_sync_enabled()`.
A fresh local database must have the Vault secret
`CAPGO_PLUGIN_STATE_SYNC_ENABLED` enabled first, either through local Vault
setup or the strict KV test setup shown above. Otherwise the standalone
benchmark stops with a prerequisite error instead of timing unsynchronized
state. It does not modify or restore the switch implicitly.
Local KV itself remains warm. Propagation probes bypass the setup's automatic
drain and measure from database commit while the writer runs asynchronously.
The benchmark must pass response parity and KV-source assertions before its
timings can be used.

Complete DB manifest-size maps retain their existing untagged v1 Cache API
path and day-long TTL. KV-filled maps use a separate path, the isolated
plugin-state app tag and a 30-second TTL. A warm DB map request needs neither
a database lookup nor a KV document read. Selecting a small KV cohort does not
make DB/control map entries globally purgeable.

The worker size baseline was refreshed earlier in this feature. The historical
unchanged branch base measured 474.43 KiB, gzip 141.80 KiB. The current immutable
KV/R2 plugin Worker dry build measures 501.97 KiB, gzip 149.98 KiB, and passes
the size check. Runtime document validation uses dependency-free predicates to
avoid adding a schema interpreter to the plugin worker.

Production validation still needs paired regional probes for existing bundles,
new uploads and manifests, channel publishes, forced overrides, self-assignment,
deletion, rollouts, and plan changes. Capture their commit times and the first
matching response in each region. No global latency or savings claim is proven
by this local test.

The November 10, 2026 immutable-KV/R2 local comparison and raw report are in
[plugin-state-kv-results.md](plugin-state-kv-results.md). Most request types were
faster in that fixture, while warm manifest-size maps were essentially unchanged.
The one observed new bundle became visible later through KV/R2. The report
retains both November 6 raw files separately and lists the unmeasured regional,
replica-fallback, timeout, and historical-storage cost gates that must pass
before increasing rollout.
