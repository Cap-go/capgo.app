# Plugin state in Workers KV

The plugin worker can answer `/updates`, `/updates/manifest_size`, `/stats`, and
all `/channel_self` methods from precomputed state. The deprecated `/plugin/*`
aliases use the same handlers. Snapshot readers reuse the existing response
logic. Stats collection and device channel writes retain their existing sinks.

The database remains the source of truth. Statement triggers enqueue changed
apps, bundle names, manifests, and device overrides. The API worker reads the
primary on this write path, publishes their KV documents, and purges the app's
Cache API entries. Plugin requests never rebuild state from the primary.

## Consistency and latency

Cache API reads are local to each Cloudflare location. KV serves cache misses.
Popular documents can reuse a parsed copy in isolate memory after checking the
Cache API revision. There is no extra SQL query for a successful KV request.

KV is eventually consistent. Cloudflare documents that updates and negative
lookups can remain stale for **60 seconds or more** in other locations. A
`cacheTtl` of 30 seconds is a cache setting, not a global propagation guarantee.
The Cache API TTL is bounded to avoid keeping an old KV refill for hours. The
existing purge pipeline also schedules repeated purges.

Publishing the app document after its dependencies does not make KV updates
atomic across keys or locations. Missing dependencies and read failures must
fall back to the existing replica path. Authoritative mode distinguishes a
genuinely absent app from an unavailable or malformed store.

Authoritative app mode does not make missing manifest keys authoritative.
Backfill publishes channel-referenced manifests; historical and unpublished
bundles may still exist only in the database. Their manifest-size requests
fall back to the replica rather than returning zero sizes. Retain replica
fallback until those remaining dependencies have a separate serving path.

Do not infer worldwide latency or release visibility from local workerd. Keep
all regional replicas and Worker placement until production measurements prove
that both request latency and time to observe changes meet the existing
behavior in every region. This change does not consolidate or remove replicas.

References: [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/),
[KV limits](https://developers.cloudflare.com/kv/platform/limits/).

## Controls

| Setting | Scope | Default and purpose |
| --- | --- | --- |
| `CAPGO_PLUGIN_STATE_SYNC_ENABLED` | Vault | Disabled. Set to `true` to enqueue changes and run backfill. |
| `PLUGIN_STATE_KV` | Plugin Worker runtime | Off. Accepts `off`, `on`, or a percentage such as `1%`. Sampling is stable by app and device across endpoints. |
| `PLUGIN_STATE_KV_AUTHORITATIVE` | Plugin Worker runtime | False. Leave false during backfill so absent apps use replicas. Enable only after verifying complete coverage. |
| `PLUGIN_STATE_KV_STRICT` | Plugin Worker runtime | False. Tests enable it to reject database reads that escape a KV session. |
| `PLUGIN_STATE_TIMING` | Plugin Worker runtime | Off. Accepts the same percentage syntax and samples both response paths. |

The `PLUGIN_STATE` namespace binding must match between API and plugin workers
in each environment. Binding a namespace alone does not enable plugin reads.
The sync endpoint requires the existing internal API secret.

## Sync limits and SQL execution model

All new SQL functions use an empty search path and qualified object names.
Internal RPCs are restricted to `service_role`; the migration changes no
published CLI RPC or existing grant. No new function runs in plugin-request
RLS or per-device SQL reads.

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
bundle's manifest with indexed version lookup. A 5,000-file bundle is one KV
document. Current tests cover that size and a separate 1,001-manifest sync
that resumes across invocations. These are local checks, not a production
throughput benchmark.

Each drain has a 20-second budget and shares an 800-operation KV allowance,
leaving room below the platform's 1,000-operation invocation limit. At most
four apps run concurrently, with 128 claimed jobs per app. Full sync pages
bundle names and device keys by indexed cursors, then resumes manifest
publication with its own cursor. Manifest loads run two at a time per app.
Successful, failed, and deferred settlements enforce a per-app cooldown so
another invocation cannot immediately overwrite the same key. Failed work
gets at most five leases, then retains its exact key in the repair archive.
Capacity continuation does not spend the provider failure budget.

Apps with at most 500 forced overrides inline them in the app document.
Larger override sets require an additional KV lookup per device. Account for
those reads when projecting cost; this implementation has no Bloom filter.
Measure actual Cache API miss rates and KV reads before forecasting savings
or removing database infrastructure.

## Progressive rollout

1. Deploy the migration and workers with `PLUGIN_STATE_KV=off`. Enable the
   Vault sync switch. Run `public.plugin_state_sync_tick()` through internal
   operations to begin or resume the automatic backfill. Do not change public
   API or CLI permissions.
2. Verify that every live app has `full_synced_at`, backfill has finished, due
   work drains, no leases are stuck, and the failed-work archive is empty.
   Exercise a real bundle publish and channel setting change. Verify sync and
   cache purge success logs.
3. Enable a small timing sample and `PLUGIN_STATE_KV=1%` for one existing
   regional worker. Leave authoritative mode false and replicas available.
   Compare status, errors, p50/p95/p99 request duration, KV fallbacks, and release
   propagation with the DB cohort in the same region and time window.
4. Raise the share only when both request and change-propagation measurements
   pass. Repeat across regions. Stable sampling keeps each device in one cohort
   across endpoints. Raise to `on` only after coverage is complete.
5. Treat removing placement or database infrastructure as a separate measured
   rollout. The current PR keeps both available for rollback.

Set `PLUGIN_STATE_KV=off` to stop new KV sessions immediately. Existing CDN and
app-status caches keep their existing TTL behavior. Keep the writer running
while investigating a read-path problem. Turn the Vault switch off separately
if the problem is in the writer.

Timing logs have `message=plugin_state_request_timing`, the path, method,
response source, status, Cloudflare colo, duration in milliseconds, and sampling
basis points. They measure Worker wall time, not network RTT. `X-Plugin-State`
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
manifest sizes. Cache API eviction is reported separately from warm reads.
Local KV itself remains warm. Propagation probes bypass the setup's automatic
drain and measure from database commit while the writer runs asynchronously.
The benchmark must pass response parity and KV-source assertions before its
timings can be used.

Complete manifest-size maps retain their existing Cache API fast path. New
version-2 entries carry purge tags; old untagged entries are not reused. A
warm request needs neither a database lookup nor a KV document read. Maps
filled by the KV path expire after 30 seconds.

The worker size baseline is intentionally refreshed for this feature. A dry
run of the unchanged branch base measured 474.43 KiB, gzip 141.80 KiB. The
KV implementation is approximately 498 KiB, gzip 149 KiB. The older committed
baseline dated July also understated the unchanged branch base. Validation
uses dependency-free predicates to avoid adding a schema interpreter to the
plugin worker.

Production validation still needs paired regional probes for existing bundles,
new uploads and manifests, channel publishes, forced overrides, self-assignment,
deletion, rollouts, and plan changes. Capture their commit times and the first
matching response in each region. No global latency or savings claim is proven
by this local test.

The measured local comparison, including limitations and the raw report, is in
[plugin-state-kv-results.md](plugin-state-kv-results.md).
