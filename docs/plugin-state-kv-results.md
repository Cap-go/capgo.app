# Local immutable KV and R2 comparison

Measured 2026-11-06T21:24:44.239Z using local workerd and this worktree's local PostgreSQL. This run uses immutable Workers KV values selected by conditional R2 pointers, with Cache API in front.

The measured KV/R2 reads are faster for this local fixture. New bundle visibility took longer on the KV/R2 path in the single publication observation below. These results do not establish worldwide latency, equal release freshness, or production cost savings. Keep rollout off until regional measurements pass both request-latency and change-visibility gates.

## Warm request latency

Each row has **100 requests per path**. DB and KV/R2 requests alternate order, use matching device inputs, and run serially. Worker and database startup are excluded. Cache API, local KV/R2, and database buffers are warm. Manifest-size maps retain a shared Cache API fast path, so their warm DB cohort does not necessarily execute SQL.

| Scenario | DB p50 | KV/R2 p50 | DB p95 | KV/R2 p95 |
| --- | ---: | ---: | ---: | ---: |
| Existing bundle, up to date | 16.30 ms | 6.99 ms | 24.91 ms | 10.45 ms |
| New bundle available | 14.13 ms | 6.31 ms | 21.51 ms | 10.16 ms |
| Channel list | 12.30 ms | 4.65 ms | 21.65 ms | 8.60 ms |
| Current channel | 14.18 ms | 5.95 ms | 21.98 ms | 10.12 ms |
| Stats | 10.68 ms | 3.38 ms | 17.49 ms | 5.89 ms |
| Stats batch | 13.03 ms | 4.70 ms | 21.31 ms | 8.41 ms |
| Manifest sizes | 1.49 ms | 1.44 ms | 4.11 ms | 2.58 ms |

## Cache API evicted request latency

Each row has **10 requests per path**, with Cache API eviction before each cohort request. Local KV/R2 service state and database buffers remain warm. This is not a cold global KV or production R2 test. Document cache misses on the new path read the R2 pointer before the selected immutable KV value.

| Scenario | DB p50 | KV/R2 p50 | DB p95 | KV/R2 p95 |
| --- | ---: | ---: | ---: | ---: |
| Existing bundle, up to date | 12.13 ms | 5.06 ms | 15.21 ms | 7.38 ms |
| New bundle available | 11.35 ms | 6.15 ms | 20.71 ms | 8.10 ms |
| Channel list | 14.70 ms | 6.82 ms | 25.34 ms | 9.53 ms |
| Current channel | 11.56 ms | 5.96 ms | 16.60 ms | 6.78 ms |
| Stats | 12.35 ms | 5.38 ms | 36.52 ms | 9.61 ms |
| Stats batch | 12.04 ms | 6.29 ms | 16.63 ms | 10.23 ms |
| Manifest sizes | 7.97 ms | 4.25 ms | 10.90 ms | 8.47 ms |

## New bundle visibility

New bundle metadata and manifest are pending sync. The timer starts at channel-promotion COMMIT, after upload preparation. Both paths are polled while an independently invoked writer drain and local tag purge run in flight; polling does not wait for writer completion.

| Path | First matching response | Poll requests |
| --- | ---: | ---: |
| DB | 30.04 ms | 1 |
| KV/R2 | 113.30 ms | 4 |

This is **one observation per path**, with 25 ms polling intervals plus request time. It excludes upload preparation and internet transfer and does not model cross-region replication, KV propagation, or production R2 latency. KV/R2 visibility was later in this observation. Do not treat faster warm reads as proof that a new bundle reaches users equally quickly.

## Channel surfing

Single operations on independent, fresh devices per mode. Both devices follow the same SET/read/DELETE/read lifecycle, so both SETs perform their first assignment. The first mode alternates by plugin generation. These are observations, not latency distributions.

| Operation | DB | KV/R2 |
| --- | ---: | ---: |
| 7.0.0 SET beta | 23.74 ms | 11.09 ms |
| 7.0.0 GET current after SET | 13.36 ms | 5.66 ms |
| 7.0.0 DELETE override | 12.26 ms | 5.37 ms |
| 7.0.0 GET current after DELETE | 11.78 ms | 7.68 ms |
| 7.34.0 SET beta | 11.96 ms | 5.48 ms |
| 7.34.0 GET current after SET | 10.60 ms | 4.69 ms |
| 7.34.0 DELETE override | 11.27 ms | 4.96 ms |
| 7.34.0 GET current after DELETE | 12.35 ms | 5.33 ms |

## Validation

Local checks for the current implementation:

- DB plugin suite: 132 passed, 146 intentionally skipped Cloudflare-inapplicable cases.
- Strict KV plugin suite: 155 passed, 146 intentionally skipped cases. KV mode rejects escaped SQL reads.
- PostgreSQL queue and grant contracts: 14 passed.
- Focused unit checks: 121 passed.
- Backend lint/typecheck, plugin isolation, production API Worker dry build, and plugin size check passed.
- Plugin Worker dry build: 499.84 KiB, gzip 149.26 KiB.

Every measured pair checks HTTP status and parsed JSON. The absolute retry timestamp is validated against each request's clock interval and retry duration before comparing the remaining fields. KV/R2 responses must carry the KV source marker; DB responses must not carry one. Ordinary successful plugin tests also assert KV provenance. Legacy channel lists have unspecified SQL order; exact fixture comparisons republish state after setup writes.

The independent stats-sink unit test verifies both batch events reach the analytics writers. HTTP response parity alone is not evidence of sink writes.

## Remaining rollout gates

The benchmark fixture has fewer than 500 forced overrides and manifests that fit the publication limits. It does not measure devices without published per-device pointers on apps above the inline-override threshold. Those devices intentionally fall back to replicas. Manifests marked for `worker_memory_limit` or `kv_value_limit` also retain replica reads. Measure these cohorts' latency, fallback rate, and R2/KV/database operations separately before estimating savings.

Production validation still needs paired probes in every region for existing bundles, new bundles/manifests, channel changes, forced overrides, self-assignment, deletions, rollouts, and plan changes. Capture commit time and first matching response as well as request distributions. Strong pointer consistency does not remove Cache API staleness or delayed KV-value visibility. Keep placement and replicas available until those measurements justify a separate change.

[Current raw measurements](benchmarks/plugin-state-local-2026-11-06-r2.json) · [Rollout procedure](plugin-state-kv.md) · [Previous mutable-publication raw measurements](benchmarks/plugin-state-local-2026-11-06.json)
