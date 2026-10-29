# Bundle-list index benchmark

Verdict: faster on this local, warm-cache workload. The median batch average for a full active-bundle HTTP page fell from **2.25 ms to 1.30 ms** (42.5% lower), over nine alternating batches of ten requests per side. The ranges do not overlap. These are local measurements, not a forecast of production latency.

## Reproduce

Run against a seeded local Supabase stack:

```sh
bun scripts/supabase-worktree.ts with-env bun scripts/bench/bundle_list.mjs
```

The script rejects non-loopback database and API URLs. It creates two isolated copies of `app_versions`, copies the existing indexes (excluding the candidate) plus the actual SELECT/MFA policies, then adds the migration index only to the second copy. Public `security_invoker` views allow real PostgREST requests under the same policies. No customer data is required.

The benchmark removes its synthetic schemas, public views, API key, apps, and
organizations on success, SQL failure, `SIGINT`, or `SIGTERM`. Signal handlers
abort HTTP requests and let any in-flight SQL finish before the same cleanup
runs; the SQL statement timeout is 120 seconds. Interrupted runs exit with 130
(`SIGINT`) or 143 (`SIGTERM`). Cleanup rolls back failed setup before resetting
the database role and always closes the connection. A cleanup failure is reported
without replacing the original benchmark error.

## Workload and verification

- 300,000 full bundle rows per side, across 3,002 app IDs. The target is an older app with 6,000 bundles, of which 4,800 are active. The target holds 2% of rows, close to the largest app fraction in the production statistics used to size this test.
- Every page returns all columns as JSON, ordered newest first, with a 50-row limit. Cases cover active bundles, deleted bundles, and an active page at offset 1,000.
- SQL uses the supplied query shape with all four parameters, under a valid organization API key. Both forced custom and forced generic prepared plans are measured.
- HTTP measures the complete request and JSON response through local PostgREST, including RLS. Nine timed batches per side, ten requests per batch, plus one unreported warmup batch. Side order reverses between rounds.
- Every checked response has the expected IDs and is identical between sides. **Zero errors across 120 SQL pages and 600 HTTP pages**, including warmups. Additional controls confirm unauthenticated and invalid-key calls return no rows and an authenticated user retains access.
- The automated regression tests additionally exercise real `app_versions` HTTP paging, both prepared-plan modes, and cross-organization denial.

## HTTP results

Times are per-request averages within a batch; the table gives the median and min–max across nine batches. These are not individual-request p50 values.

| Page | Before, ms | After, ms | Before range | After range |
| --- | ---: | ---: | ---: | ---: |
| active | 2.253 | 1.295 | 2.135–2.691 | 1.252–1.356 |
| deleted | 1.869 | 1.251 | 1.834–1.980 | 1.186–1.345 |
| offset_1000 | 2.370 | 1.384 | 2.294–2.429 | 1.354–1.482 |

## Prepared SQL results

Nine timed executions per side, with alternating order and one unreported warmup. Times include the database round trip and complete JSON rows.

| Plan and page | Before median, ms | After median, ms | Before range | After range |
| --- | ---: | ---: | ---: | ---: |
| force_custom_plan:active | 5.224 | 1.682 | 5.042–8.673 | 1.631–2.020 |
| force_custom_plan:deleted | 5.267 | 1.900 | 4.887–8.055 | 1.430–3.809 |
| force_custom_plan:offset_1000 | 5.347 | 1.702 | 5.120–5.994 | 1.642–2.146 |
| force_generic_plan:active | 1.731 | 0.822 | 1.616–1.876 | 0.714–0.897 |
| force_generic_plan:deleted | 1.295 | 0.740 | 1.254–1.461 | 0.714–0.788 |
| force_generic_plan:offset_1000 | 1.780 | 0.846 | 1.728–2.014 | 0.773–1.063 |

## Limiter and plans

`EXPLAIN (ANALYZE, BUFFERS)` runs separately, outside the timed samples. The raw results contain every plan.

- Before, the custom plan walks the creation-time index for an older app. The active first-page index scan touches about 2,150 shared buffers; the candidate reads about 37 with both `app_id` and `deleted` as index conditions.
- Before, the generic plan loads 6,000 app candidates, filters to 4,800 active bundles, and sorts them to produce the first page. After, an ordered index scan produces 50 rows without a sort.
- The generic first-page sort used 126 KiB; the offset-1,000 sort used 2,214 KiB. The candidate removes these sort nodes. This demonstrates removal of those query sort allocations; **it does not establish a reduction in host `Committed_AS` or resolve the separate memory warning**.
- A partial `deleted = false` index cannot in general serve a generic plan whose deletion state is a parameter. Keeping the boolean in the full index supports both values.

## Environment and tradeoffs

- PostgreSQL 17.6; 18 logical CPUs; starting load averages [2.70458984375, 3.2001953125, 3.658203125]. No other validation jobs ran during the measurements.
- Both sides use identical settings and warm caches. `work_mem` is set to the production 16 MiB budget; the complete local settings are recorded in the JSON. Hardware, buffer sizing, and network distance differ from production.
- The added index occupies 17,899,520 bytes (17.07 MiB) for 300,000 rows. Local creation took 151.0 ms. It adds storage, cache, WAL, and write-maintenance costs. No existing indexes are removed.
- The migration uses a five-second lock-acquisition timeout. A normal index build blocks writes while building; the local build duration is not a production guarantee. Follow the production prebuild procedure below before merging into the automatic release flow.
- This change leaves RLS, RPCs, permissions, queue behavior, API responses, and CLI contracts intact. It addresses the bundle-list statement in the sample; cron and manifest costs remain separate investigation targets.

Raw runs and plans: [bundle_list_results.json](bundle_list_results.json).

## Production rollout

An authorized database operator must prebuild this index concurrently **before
merging/deploying this migration to production**. The release workflow applies
migrations automatically; it does not enforce a maintenance window. This PR does
not run the production prebuild.

1. Inspect any existing index with the following query. A valid, ready index with
   exactly the expected table and columns can be reused. If it is invalid, drop
   only that invalid index with `DROP INDEX CONCURRENTLY
   public.idx_app_versions_app_deleted_created_at;` outside a transaction before
   retrying the build. Do not treat a same-name index as proof of a completed build.

   ```sql
   SELECT i.indisvalid, i.indisready, pg_catalog.pg_get_indexdef(i.indexrelid)
   FROM pg_catalog.pg_index AS i
   WHERE i.indexrelid = pg_catalog.to_regclass('public.idx_app_versions_app_deleted_created_at');
   ```

2. Run the following as a standalone statement, outside a transaction, when the
   expected valid index is absent:

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_app_versions_app_deleted_created_at
   ON public.app_versions (app_id, deleted, created_at DESC);
   ```

3. Repeat the inspection query. Proceed with deployment only when `indisvalid`
   and `indisready` are both true and the definition matches. A failed concurrent
   build can leave an invalid index that `IF NOT EXISTS` would skip; remove the
   invalid index concurrently and retry before deployment.

The migration uses `CREATE INDEX IF NOT EXISTS` to reuse the prebuilt index. Its
five-second lock timeout still bounds lock acquisition. Without the prebuild, it
performs a regular write-blocking build; this fallback is intended for small local
and CI databases. The prepared-plan regression tests disable sequential scans
only to assert that this specific index is usable with both boolean values and
both plan modes; the production-like benchmark above measures natural plans.
