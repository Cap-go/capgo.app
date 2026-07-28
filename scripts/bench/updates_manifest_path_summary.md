# Updates manifest path load test (local Postgres)

Hypothesis: deferring manifest out of the channel `json_agg` query must not destroy the **new-version** path (devices that actually get files). Up-to-date wins are secondary.

## How to reproduce

```bash
# one-time: local Postgres for this bench
docker run -d --name capgo-manifest-bench-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=manifest_bench -p 55432:5432 postgres:17-alpine

bun run bench:updates-manifest-path
```

Script: `scripts/bench_updates_manifest_path.ts`

## What was measured

Production-shaped SQL (same join/`json_agg` / indexed `app_version_id` lookup as plugin_runtime):

| Path | Up-to-date | New version |
|------|------------|-------------|
| OLD | channel + LEFT JOIN manifest + `json_agg` | same (always pays) |
| NEW | channel only | channel light + `SELECT … FROM manifest WHERE app_version_id = ?` |

Load: concurrency 50, 800 requests, warmup 20. Seed: N files/version × 41 versions so `idx_manifest_app_version_id` is selective.

## Results (5k files/version, 205k manifest rows)

| Scenario | Path | p50 | p95 | p99 | QPS |
|----------|------|-----|-----|-----|-----|
| up_to_date | OLD json_agg | 122.1 ms | 217.1 ms | 417.5 ms | 360 |
| up_to_date | NEW light | 3.1 ms | 8.4 ms | 11.4 ms | 13802 |
| new_version | OLD json_agg | 117.9 ms | 224.2 ms | 273.3 ms | 383 |
| new_version | NEW light+index | 111.7 ms | 147.7 ms | 222.7 ms | 425 |

Gates: **PASS**

- new_version p95: **−34.1%** (−76.5 ms) vs OLD
- up_to_date p95: **−96.1%** vs OLD

EXPLAIN confirmed Index Scan on `idx_manifest_app_version_id` for the deferred fetch.

## Results (500 files/version)

| Scenario | Path | p95 | Delta |
|----------|------|-----|-------|
| new_version | OLD → NEW | 45.6 → 23.0 ms | **−49.5%** |
| up_to_date | OLD → NEW | 73.5 → 5.5 ms | **−92.5%** |

## Conclusion

Under concurrent load against a selective index, the deferred path does **not** destroy new-version latency; it is faster than channel-level `json_agg` while making up-to-date ~20× cheaper. App code also starts the indexed fetch immediately after the up-to-date check and overlaps it with signed URL work.

Artifacts: `updates_manifest_path_results.json`, `updates_manifest_path_results_500.json`.
