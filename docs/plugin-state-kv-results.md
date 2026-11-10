# Local immutable KV and R2 comparison

Measured 2026-11-10T01:44:38.235Z using local workerd and this worktree's local PostgreSQL. This run uses immutable Workers KV values selected by conditional R2 pointers, with Cache API in front. Per-provider timing sampling was off during the benchmark.

Most measured request types were faster through KV/R2 in this local fixture. Warm manifest-size maps were essentially unchanged: p50 was 1.342 ms through KV/R2 versus 1.325 ms through the DB cohort's shared Cache API fast path. New bundle visibility took longer on the KV/R2 path in the single publication observation below. These results do not establish worldwide latency, equal release freshness, or production cost savings. Keep rollout off until regional measurements pass both request-latency and change-visibility gates.

## Warm request latency

Each row has **100 requests per path**. DB and KV/R2 requests alternate order, use matching device inputs, and run serially. Worker and database startup are excluded. Cache API, local KV/R2, and database buffers are warm. Manifest-size maps retain a shared Cache API fast path, so their warm DB cohort does not necessarily execute SQL.

| Scenario | DB p50 | KV/R2 p50 | DB p95 | KV/R2 p95 |
| --- | ---: | ---: | ---: | ---: |
| Existing bundle, up to date | 15.11 ms | 5.13 ms | 17.75 ms | 6.53 ms |
| New bundle available | 13.67 ms | 5.07 ms | 15.64 ms | 6.88 ms |
| Channel list | 15.97 ms | 4.25 ms | 18.42 ms | 6.85 ms |
| Current channel | 15.60 ms | 4.81 ms | 17.80 ms | 6.98 ms |
| Stats | 10.28 ms | 3.17 ms | 15.48 ms | 5.19 ms |
| Stats batch | 18.13 ms | 4.33 ms | 22.21 ms | 6.54 ms |
| Manifest sizes | 1.32 ms | 1.34 ms | 1.90 ms | 1.82 ms |

## Cache API evicted request latency

Each row has **10 requests per path**, with Cache API eviction before each cohort request. Local KV/R2 service state and database buffers remain warm. This is not a cold global KV or production R2 test. Document cache misses on the new path read the R2 pointer before the selected immutable KV value.

| Scenario | DB p50 | KV/R2 p50 | DB p95 | KV/R2 p95 |
| --- | ---: | ---: | ---: | ---: |
| Existing bundle, up to date | 17.69 ms | 4.64 ms | 22.02 ms | 5.99 ms |
| New bundle available | 11.43 ms | 4.72 ms | 16.98 ms | 8.09 ms |
| Channel list | 16.93 ms | 4.98 ms | 18.93 ms | 5.18 ms |
| Current channel | 11.33 ms | 5.26 ms | 14.75 ms | 10.08 ms |
| Stats | 14.30 ms | 4.63 ms | 20.54 ms | 6.21 ms |
| Stats batch | 19.18 ms | 5.71 ms | 53.10 ms | 6.32 ms |
| Manifest sizes | 8.46 ms | 4.09 ms | 12.90 ms | 5.52 ms |

## New bundle visibility

New bundle metadata and manifest are pending sync. The timer starts at channel-promotion COMMIT, after upload preparation. Both paths are polled while an independently invoked writer drain and local tag purge run in flight; polling does not wait for writer completion.

| Path | First matching response | Poll requests |
| --- | ---: | ---: |
| DB | 25.91 ms | 1 |
| KV/R2 | 75.56 ms | 3 |

This is **one observation per path**, with 25 ms polling intervals plus request time. It excludes upload preparation and internet transfer and does not model cross-region replication, KV propagation, or production R2 latency. KV/R2 visibility was later in this observation. Do not treat faster warm reads as proof that a new bundle reaches users equally quickly.

## Channel surfing

Single operations on independent, fresh devices per mode. Both devices follow the same SET/read/DELETE/read lifecycle, so both SETs perform their first assignment. The first mode alternates by plugin generation. These are observations, not latency distributions.

| Operation | DB | KV/R2 |
| --- | ---: | ---: |
| 7.0.0 SET beta | 17.80 ms | 8.51 ms |
| 7.0.0 GET current after SET | 13.25 ms | 5.16 ms |
| 7.0.0 DELETE override | 12.43 ms | 5.42 ms |
| 7.0.0 GET current after DELETE | 12.27 ms | 4.73 ms |
| 7.34.0 SET beta | 11.27 ms | 5.07 ms |
| 7.34.0 GET current after SET | 9.31 ms | 4.65 ms |
| 7.34.0 DELETE override | 9.32 ms | 4.28 ms |
| 7.34.0 GET current after DELETE | 9.62 ms | 4.55 ms |

## Validation

Local checks for this revision:

- Strict KV plugin suite: 155 passed, 146 intentionally skipped Cloudflare-inapplicable cases. KV mode rejects escaped SQL reads.
- PostgreSQL queue and grant contracts: 14 passed.
- Focused unit checks: 135 passed.
- Backend lint/typecheck, plugin isolation, production API Worker dry build, and plugin size check passed.
- Plugin Worker dry build: 500.60 KiB, gzip 149.53 KiB.
- Disabled Vault prerequisite checked against the local database: the benchmark rejected startup before fixture creation, and the app count remained unchanged.
- DB plugin suite baseline: 132 passed, 146 intentionally skipped cases on the previously validated path. It was not rerun in this revision; this round leaves that DB path unchanged.

Every measured pair checks HTTP status and parsed JSON. The absolute retry timestamp is validated against each request's clock interval and retry duration before comparing the remaining fields. KV/R2 responses must carry the KV source marker; DB responses must not carry one. Ordinary successful plugin tests also assert KV provenance. Legacy channel lists have unspecified SQL order; exact fixture comparisons republish state after setup writes.

The independent stats-sink unit test verifies both batch events reach the analytics writers. HTTP response parity alone is not evidence of sink writes.

## Remaining rollout gates

The benchmark fixture has fewer than 500 forced overrides and manifests that fit the publication limits. It does not measure devices without published per-device pointers on apps above the inline-override threshold. Those devices intentionally fall back to replicas. Manifests marked for `worker_memory_limit` or `kv_value_limit` also retain replica reads. Measure these cohorts' latency, fallback rate, and R2/KV/database operations separately before estimating savings.

R2 pointer lookup and JSON decoding share a 50 ms deadline, after which a request falls back to the replica. This local run does not establish the deadline's production timeout rate or the combined pointer-plus-fallback request latency. Separately sampled runtime metrics record R2 pointer time, pointer reads and timeouts, plus KV value time and reads. Measure these providers independently in each region; those samples were disabled in this benchmark and are not part of the tables above.

Cleanup reuses generation metadata and the listed ETag from a strong R2 listing for its initial conditional write, avoiding an extra pointer GET when metadata is valid. Conflicts reread the pointer and retain the five-attempt ceiling. Tombstone generation fences remain stored. Normal daily reconciliation refreshes app documents without scanning fully synced apps' version/device history; initial backfill, explicit full repair, and deleted-app cleanup still have cost proportional to historical pointer count. Measure historical storage growth and full-repair provider operations before enabling large repairs or claiming storage savings.

Production validation still needs paired probes in every region for existing bundles, new bundles/manifests, channel changes, forced overrides, self-assignment, deletions, rollouts, and plan changes. Capture commit time and first matching response as well as request distributions. Strong pointer consistency does not remove Cache API staleness or delayed KV-value visibility. Keep placement and replicas available until those measurements justify a separate change.

[Current raw measurements](benchmarks/plugin-state-local-2026-11-10-r2.json) · [Rollout procedure](plugin-state-kv.md) · [November 6 R2 raw measurements](benchmarks/plugin-state-local-2026-11-06-r2.json) · [November 6 mutable-publication raw measurements](benchmarks/plugin-state-local-2026-11-06.json)
