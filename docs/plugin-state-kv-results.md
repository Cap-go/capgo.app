# Local plugin state comparison

Measured 2026-11-06T19:24:37.324Z using local workerd and this worktree's local PostgreSQL.

This is a local implementation comparison, not a worldwide latency or KV propagation test. Each warm row has 100 requests per path. Each Cache API evicted row has 10 requests per path, with eviction before **each** cohort request. Worker and database startup are excluded. KV service caches and database buffers remain warm.

| Scenario | DB warm p50 | KV warm p50 | DB warm p95 | KV warm p95 | DB evicted p50 | KV evicted p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Existing bundle, up to date | 14.35 ms | 6.89 ms | 21.09 ms | 11.22 ms | 15.15 ms | 6.48 ms |
| New bundle available | 17.89 ms | 7.42 ms | 22.58 ms | 11.21 ms | 13.54 ms | 5.41 ms |
| Channel list | 13.74 ms | 5.08 ms | 20.26 ms | 8.75 ms | 11.98 ms | 4.91 ms |
| Current channel | 13.32 ms | 5.48 ms | 20.02 ms | 9.99 ms | 13.98 ms | 7.21 ms |
| Stats | 11.71 ms | 3.61 ms | 16.88 ms | 6.09 ms | 11.41 ms | 4.33 ms |
| Stats batch | 14.75 ms | 5.09 ms | 24.88 ms | 8.91 ms | 12.17 ms | 4.99 ms |
| Manifest sizes | 1.69 ms | 1.62 ms | 3.60 ms | 3.47 ms | 8.00 ms | 3.68 ms |

## New bundle visibility

New bundle metadata and manifest pending sync; timer starts at channel-promotion COMMIT, after upload preparation.

One observation: DB 27.2 ms, KV 82.8 ms. Polling interval is 25 ms plus request time. The writer and local tag purge run asynchronously while both paths are polled. This excludes upload preparation and internet transfer, and does not model cross-region replication or KV propagation.

The KV path adds asynchronous publication work. This local result does **not** demonstrate equal release propagation. Keep rollout off until paired production-region measurements pass both request-latency and freshness gates.

## Channel surfing

Single operations on independent, fresh devices per mode. Both devices follow the same SET/read/DELETE/read lifecycle. These are observations, not latency distributions.

| Operation | DB | KV |
| --- | ---: | ---: |
| 7.0.0 SET beta | 19.54 ms | 6.86 ms |
| 7.0.0 GET current after SET | 12.66 ms | 10.19 ms |
| 7.0.0 DELETE override | 12.47 ms | 5.31 ms |
| 7.0.0 GET current after DELETE | 12.55 ms | 4.92 ms |
| 7.34.0 SET beta | 13.30 ms | 5.86 ms |
| 7.34.0 GET current after SET | 11.46 ms | 5.19 ms |
| 7.34.0 DELETE override | 11.08 ms | 4.78 ms |
| 7.34.0 GET current after DELETE | 11.56 ms | 5.26 ms |

## Validation

- DB plugin suite: 132 passed, 146 intentionally skipped Cloudflare-inapplicable cases.
- Strict KV plugin suite: 146 passed, 146 intentionally skipped cases. KV mode rejects escaped SQL reads.
- Focused unit checks: 96 passed. Existing channel, rollout and stats compatibility unit checks: 71 passed.
- PostgreSQL queue and grant contracts: 5 passed, also included in the strict suite.
- Backend lint/typecheck, plugin isolation, API Worker dry build and plugin size check passed.

Every measured pair checks status and parsed JSON. The absolute retry timestamp is checked against each request clock interval before comparing the remaining fields. Legacy channel lists have unspecified SQL order; exact fixture comparisons republish state after setup writes.

[Raw measurements](benchmarks/plugin-state-local-2026-11-06.json) · [Rollout procedure](plugin-state-kv.md)
