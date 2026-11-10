# Local immutable KV and R2 comparison

Measured 2026-11-10T04:16:20.439Z for the canary-isolation implementation committed with this report. This run uses local workerd and PostgreSQL, immutable Workers KV values selected by conditional R2 pointers, and the isolated plugin-state Cache API entries. Per-provider timing sampling was explicitly off during the benchmark.

Most measured request types were faster through KV/R2 in this local fixture. Warm manifest-size maps were essentially unchanged: p50 was 1.285 ms through KV/R2 versus 1.268 ms through the DB cohort's Cache API fast path. After tag purge, the isolated KV/R2 manifest map was slower than the untagged DB map that remained warm. New bundle visibility also took longer on the KV/R2 path in the single publication observation below. These results do not establish worldwide latency, equal release freshness, or production cost savings. Keep rollout off until regional measurements pass both request-latency and change-visibility gates.

## Warm request latency

Each row has **100 requests per path**. DB and KV/R2 requests alternate order, use matching device inputs, and run serially. Worker and database startup are excluded. Cache API, local KV/R2, and database buffers are warm. Manifest-size maps have separate DB and KV cache policies; their warm DB cohort does not necessarily execute SQL.

| Scenario | DB p50 | KV/R2 p50 | DB p95 | KV/R2 p95 |
| --- | ---: | ---: | ---: | ---: |
| Existing bundle, up to date | 12.33 ms | 3.54 ms | 15.24 ms | 4.74 ms |
| New bundle available | 12.62 ms | 3.83 ms | 14.67 ms | 4.85 ms |
| Channel list | 15.83 ms | 3.86 ms | 18.34 ms | 5.60 ms |
| Current channel | 15.17 ms | 4.36 ms | 18.19 ms | 5.68 ms |
| Stats | 11.03 ms | 2.64 ms | 16.48 ms | 4.53 ms |
| Stats batch | 16.05 ms | 3.15 ms | 20.12 ms | 4.68 ms |
| Manifest sizes | 1.27 ms | 1.28 ms | 1.61 ms | 1.83 ms |

## After cache-tag purge

Each row has **10 requests per path**. The raw nearest-rank p95 equals the maximum at this sample count, so the table labels the tail as **max**. Each comparison purges tagged entries before each cohort request, including the new isolated plugin-state tag. Untagged DB caches, including the original v1 manifest-size maps with their day-long TTL, intentionally remain warm. Local KV/R2 service state and database buffers also remain warm. This is a tagged-entry purge test, not a complete Cache API cold test or a cold global KV/R2 test.

| Scenario | DB p50 | KV/R2 p50 | DB max | KV/R2 max |
| --- | ---: | ---: | ---: | ---: |
| Existing bundle, up to date | 12.78 ms | 3.87 ms | 15.66 ms | 6.00 ms |
| New bundle available | 12.76 ms | 3.95 ms | 13.92 ms | 5.45 ms |
| Channel list | 17.32 ms | 4.71 ms | 18.63 ms | 7.25 ms |
| Current channel | 16.61 ms | 5.05 ms | 22.60 ms | 7.28 ms |
| Stats | 13.82 ms | 4.43 ms | 16.68 ms | 5.02 ms |
| Stats batch | 17.54 ms | 5.01 ms | 19.60 ms | 8.33 ms |
| Manifest sizes | 1.30 ms | 3.62 ms | 3.03 ms | 6.35 ms |

For manifest sizes, tag-purge p50 is 3.623 ms through KV/R2 versus 1.300 ms for DB. The KV map is evicted and must refill, while the untagged DB map continues serving from cache. The comparison preserves the two paths' current cache policies; it does not compare equally cold manifest maps. Document cache misses on the new path read the R2 pointer before the selected immutable KV value.

## New bundle visibility

New bundle metadata and manifest are pending sync. The timer starts at channel-promotion COMMIT, after upload preparation. Both paths are polled while a manually invoked writer drain and local tag purge run in flight; polling does not wait for writer completion. This probe does not measure the production trigger/queue wakeup path.

| Path | First matching response | Poll requests |
| --- | ---: | ---: |
| DB | 20.51 ms | 1 |
| KV/R2 | 71.84 ms | 3 |

This is **one observation per path**, with 25 ms polling intervals plus request time. It excludes upload preparation and internet transfer and does not model cross-region replication, KV propagation, or production R2 latency. KV/R2 visibility was later in this observation. Do not treat faster warm reads as proof that a new bundle reaches users equally quickly.

## Channel surfing

Single operations on independent, fresh devices per mode. Both devices follow the same SET/read/DELETE/read lifecycle, so both SETs perform their first assignment. The first mode alternates by plugin generation. These are observations, not latency distributions.

| Operation | DB | KV/R2 |
| --- | ---: | ---: |
| 7.0.0 SET beta | 23.24 ms | 5.70 ms |
| 7.0.0 GET current after SET | 18.74 ms | 3.98 ms |
| 7.0.0 DELETE override | 20.42 ms | 5.00 ms |
| 7.0.0 GET current after DELETE | 19.79 ms | 4.60 ms |
| 7.34.0 SET beta | 52.21 ms | 5.34 ms |
| 7.34.0 GET current after SET | 17.52 ms | 3.95 ms |
| 7.34.0 DELETE override | 16.72 ms | 12.04 ms |
| 7.34.0 GET current after DELETE | 16.96 ms | 4.18 ms |

## Validation

Local checks after the canary fixes:

- Strict KV plugin suite: 159 passed, 146 intentionally skipped Cloudflare-inapplicable cases. KV mode rejects escaped SQL reads.
- Fresh-schema PostgreSQL queue and grant contracts: 18 passed.
- Focused unit checks: 265 passed across 24 files.
- Internal script dry runs, backend lint/typecheck, plugin isolation, production API Worker dry build, and plugin size check passed.
- Snippet build size: 20.85 KB. Plugin Worker dry build: 501.97 KiB, gzip 149.98 KiB.
- Previously validated disabled-Vault prerequisite: the benchmark rejected startup before fixture creation, and the app count remained unchanged.
- Fresh DB-only suite with KV off: 132 passed, 146 intentionally skipped cases.

Every measured pair checks HTTP status and parsed JSON. The absolute retry timestamp is validated against each request's clock interval and retry duration before comparing the remaining fields. KV/R2 responses must carry the KV source marker; DB responses must not carry one. Ordinary successful plugin tests also assert KV provenance. Legacy channel lists have unspecified SQL order; exact fixture comparisons republish state after setup writes.

The independent stats-sink unit test verifies both batch events reach the analytics writers. HTTP response parity alone is not evidence of sink writes.

## Remaining rollout gates

These measurements include the cache-isolation and writer-liveness canary fixes in the working tree. They use local PostgreSQL, not a production replica or Hyperdrive cache. Production trigger/queue wakeup latency is unmeasured: the publication probe manually invokes the writer drain and local purge.

The 90%/99% document-cache hit scenarios in the PR body are optimistic assumptions, not forecasts. With a fixed 30-second TTL and a simple Poisson request model, 90% requires about 0.3 requests/second **per document per location**, and 99% requires about 3.3. Many app/location pairs can be much colder even when global traffic is high. Derive the hit distribution from per-location production observations, including invalidations.

GC is not free: every eligible retained value can require another pointer GET on later daily passes. As a scale illustration, 400 candidate GETs every 10 seconds would be 103.68M Class B operations per 30 days, or $37.32 at the linear $0.36/M rate before allowances and rounding. This is a workload scenario, not measured GC throughput or a bill. Count scan/list operations, deletes and storage separately. Unknown/deleted version names can intentionally fall back after pointer reads; include their traffic and the writer's effects on cache hit rates in total-cost estimates.

The benchmark fixture has fewer than 500 forced overrides and manifests that fit the publication limits. It does not measure devices without published per-device pointers on apps above the inline-override threshold. Those devices intentionally fall back to replicas. Manifests marked for `worker_memory_limit` or `kv_value_limit` also retain replica reads. Measure these cohorts' latency, fallback rate, and R2/KV/database operations separately before estimating savings.

R2 pointer lookup and JSON decoding share a 50 ms deadline, after which a request falls back to the replica. This local run does not establish the deadline's production timeout rate or the combined pointer-plus-fallback request latency. Separately sampled runtime metrics record R2 pointer time, pointer reads and timeouts, plus KV value time and reads. Measure these providers independently in each region; those samples were disabled in this benchmark and are not part of the tables above.

Cleanup reuses generation metadata and the listed ETag from a strong R2 listing for its initial conditional write, avoiding an extra pointer GET when metadata is valid. Conflicts reread the pointer and retain the five-attempt ceiling. Tombstone generation fences remain stored. Normal daily reconciliation refreshes app documents without scanning fully synced apps' version/device history; initial backfill, explicit full repair, and deleted-app cleanup still have cost proportional to historical pointer count. Measure historical storage growth and full-repair provider operations before enabling large repairs or claiming storage savings.

Valid but stale documents can outlive a missed enqueue or failed publication; the reader cannot detect every source gap from a cache TTL or an empty visible queue. The recovery procedure requires a fresh KV namespace and pointer bucket after an untracked source gap, with full repair and verification before reads resume. Source-failure recovery throughput, fresh-namespace cutover time, and recovery cost are not measured here. Exercise these incident paths before increasing rollout.

Production validation still needs paired probes in every region for existing bundles, new bundles/manifests, channel changes, forced overrides, self-assignment, deletions, rollouts, and plan changes. Capture commit time and first matching response as well as request distributions. Strong pointer consistency does not remove Cache API staleness or delayed KV-value visibility. Keep placement and replicas available until those measurements justify a separate change.


[Current canary raw measurements](benchmarks/plugin-state-local-2026-11-10-canary.json) · [Rollout procedure](plugin-state-kv.md) · [November 10 pre-isolation R2 raw measurements](benchmarks/plugin-state-local-2026-11-10-r2.json) · [November 6 R2 raw measurements](benchmarks/plugin-state-local-2026-11-06-r2.json) · [November 6 mutable-publication raw measurements](benchmarks/plugin-state-local-2026-11-06.json)
