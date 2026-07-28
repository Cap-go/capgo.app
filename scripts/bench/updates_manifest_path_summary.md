# Updates manifest path load test (local Postgres)

Hypothesis: deferring manifest out of the channel `json_agg` query must not
make the **new-version** path slower. Up-to-date wins are secondary.

## How to reproduce

```bash
# one-time: local Postgres for this bench (dedicated port + db name)
docker run -d --name capgo-manifest-bench-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=manifest_bench -p 55432:5432 postgres:17-alpine

bun run bench:updates-manifest-path
```

Script: `scripts/bench_updates_manifest_path.ts`

Safety: the script **ignores `DATABASE_URL`** and only allows
`127.0.0.1|localhost:55432/manifest_bench` (or
`MANIFEST_BENCH_DATABASE_URL` / `--database-url` with the same shape). Setup
runs `DROP SCHEMA public CASCADE`.

## What was measured

Production-shaped SQL (same join/`json_agg` / indexed `app_version_id` lookup as plugin_runtime):

| Path | Up-to-date | New version |
|------|------------|-------------|
| OLD | channel + LEFT JOIN manifest + `json_agg` | same (always pays) |
| NEW | channel only | channel light + `SELECT … FROM manifest WHERE app_version_id = ?` |

Load: concurrency 50, 800 requests, warmup 20. Seed: N files/version × 41 versions so `idx_manifest_app_version_id` is selective.

## PASS gate (strict)

Fails unless:

1. NEW `new_version` p95 is **not slower** than OLD beyond noise (`max(10ms, 5% of OLD p95)`)
2. NEW `new_version` p99 is not slower than OLD beyond `max(15% of OLD, 25ms)`
3. NEW `up_to_date` p95 improves by **≥ 50%**

## Results (5k files/version, 205k manifest rows) — re-run on this branch

| Scenario | Path | p50 | p95 | p99 | QPS |
|----------|------|-----|-----|-----|-----|
| up_to_date | OLD json_agg | 74.7 ms | 302.3 ms | 516.0 ms | 459 |
| up_to_date | NEW light | 1.3 ms | 3.2 ms | 5.6 ms | 29553 |
| new_version | OLD json_agg | 104.2 ms | 207.9 ms | 300.4 ms | 448 |
| new_version | NEW light+index | 63.6 ms | **116.0 ms** | **128.1 ms** | 673 |

Gates: **PASS**

- new_version p95: **−44.2%** (−92.0 ms) vs OLD
- up_to_date p95: **−98.9%** vs OLD

EXPLAIN confirmed Index Scan on `idx_manifest_app_version_id` for the deferred fetch.

## App-code overlap note

`requestManifestEntriesPostgres` returns `manifestQuery.execute()` (a real
Promise). Drizzle builders are thenables and would re-run SQL on every
`await`/`catch` — that double-fire bug was fixed before reopening this PR.

Manifest fetch starts **only after auto-update gates pass**, then overlaps
signed URL generation (non-DB). Hyperdrive uses one `pg.Client` per request, so
overlapping two DB queries would not buy parallelism.

## Conclusion

Under concurrent load against a selective index, the deferred path is **faster**
than channel-level `json_agg` on the new-version path, and makes up-to-date
~100× cheaper. App code starts the indexed fetch immediately after the
up-to-date check and overlaps it with signed URL work.

Artifacts: `updates_manifest_path_results.json`, `updates_manifest_path_results_500.json`.
