# Version primary-key lookup

Local Postgres on 127.0.0.1:55433, schema pk_bench, then dropped. Not production.

Seed: 2000 deleted versions and 150 live versions of `com.bench.pk`, 400 files on version 1.

Before joins `app_versions` on `app_id` plus `id`. Stats are frozen before the fat app is inserted, matching the production misestimate. After is the `LATERAL` primary-key lookup from `buildManifestSizeLookupQuery`.

Median of 5 hot runs after one warmup. jit off.

| | Median | Rows |
| --- | ---: | ---: |
| Scan every version | 1.7 ms | 400 |
| Primary-key lookup | 1.1 ms | 400 |

Local rows sit in 19 cached pages, so the clock barely moves. The plan is the difference: the scan reads every version of the app and drops 2000 deleted rows. The new query is one `app_versions_pkey` lookup (`loops=1`). On production that scan was 6.9 ms warm and 280 ms cold.

## Scan plan

Execution Time: 0.872 ms

```
GroupAggregate  (cost=13.75..13.77 rows=1 width=48) (actual time=0.766..0.823 rows=400 loops=1)
  Group Key: r.file_hash, av.id
  Buffers: shared hit=1219
  CTE requested
    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=40) (actual time=0.125..0.149 rows=400 loops=1)
          Group Key: request_files.file_hash, request_files.version_id
          Batches: 1  Memory Usage: 77kB
          ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.065..0.083 rows=400 loops=1)
                Filter: (file_hash IS NOT NULL)
  ->  Sort  (cost=11.25..11.25 rows=1 width=48) (actual time=0.764..0.772 rows=400 loops=1)
        Sort Key: r.file_hash, av.id
        Sort Method: quicksort  Memory: 42kB
        Buffers: shared hit=1219
        ->  Nested Loop  (cost=8.58..11.24 rows=1 width=48) (actual time=0.243..0.639 rows=400 loops=1)
              Join Filter: (av.id = m.app_version_id)
              Buffers: shared hit=1219
              ->  Hash Join  (cost=8.31..10.57 rows=1 width=48) (actual time=0.235..0.329 rows=400 loops=1)
                    Hash Cond: (r.version_id = av.id)
                    Buffers: shared hit=19
                    ->  CTE Scan on requested r  (cost=0.00..2.00 rows=100 width=40) (actual time=0.126..0.191 rows=400 loops=1)
                          Filter: (version_id IS NOT NULL)
                    ->  Hash  (cost=8.29..8.29 rows=1 width=8) (actual time=0.105..0.106 rows=150 loops=1)
                          Buckets: 1024  Batches: 1  Memory Usage: 14kB
                          Buffers: shared hit=19
                          ->  Index Scan using idx_app_id_app_versions on app_versions av  (cost=0.28..8.29 rows=1 width=8) (actual time=0.007..0.095 rows=150 loops=1)
                                Index Cond: (app_id = 'com.bench.pk'::text)
                                Filter: (NOT deleted)
                                Rows Removed by Filter: 2000
                                Buffers: shared hit=19
              ->  Index Only Scan using idx_manifest_app_version_id_file_hash on manifest m  (cost=0.27..0.65 rows=1 width=24) (actual time=0.001..0.001 rows=1 loops=400)
                    Index Cond: ((app_version_id = r.version_id) AND (file_hash = r.file_hash))
                    Heap Fetches: 400
                    Buffers: shared hit=1200
Planning:
  Buffers: shared hit=6
Planning Time: 0.136 ms
Execution Time: 0.872 ms
```

## Primary-key plan

->  Index Scan using app_versions_pkey on app_versions  (cost=0.28..8.29 rows=1 width=32) (actual time=0.004..0.004 rows=1 loops=1)

```
GroupAggregate  (cost=854.42..854.44 rows=1 width=48) (actual time=0.492..0.561 rows=400 loops=1)
  Group Key: r.file_hash, av.id
  Buffers: shared hit=7
  CTE requested
    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=40) (actual time=0.117..0.135 rows=400 loops=1)
          Group Key: request_files.file_hash, request_files.version_id
          Batches: 1  Memory Usage: 77kB
          ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.056..0.074 rows=400 loops=1)
                Filter: (file_hash IS NOT NULL)
  CTE allowed_versions
    ->  Nested Loop  (cost=2.53..835.00 rows=100 width=8) (actual time=0.200..0.201 rows=1 loops=1)
          Buffers: shared hit=3
          ->  HashAggregate  (cost=2.25..3.25 rows=100 width=8) (actual time=0.196..0.196 rows=1 loops=1)
                Group Key: requested.version_id
                Batches: 1  Memory Usage: 24kB
                ->  CTE Scan on requested  (cost=0.00..2.00 rows=100 width=8) (actual time=0.117..0.174 rows=400 loops=1)
                      Filter: (version_id IS NOT NULL)
          ->  Subquery Scan on av_1  (cost=0.28..8.31 rows=1 width=8) (actual time=0.004..0.005 rows=1 loops=1)
                Filter: ((NOT av_1.deleted) AND (av_1.app_id = 'com.bench.pk'::text))
                Buffers: shared hit=3
                ->  Index Scan using app_versions_pkey on app_versions  (cost=0.28..8.29 rows=1 width=32) (actual time=0.004..0.004 rows=1 loops=1)
                      Index Cond: (id = requested.version_id)
                      Buffers: shared hit=3
  ->  Sort  (cost=16.92..16.92 rows=1 width=48) (actual time=0.491..0.503 rows=400 loops=1)
        Sort Key: r.file_hash, av.id
        Sort Method: quicksort  Memory: 42kB
        Buffers: shared hit=7
        ->  Hash Join  (cost=14.52..16.91 rows=1 width=48) (actual time=0.347..0.369 rows=400 loops=1)
              Hash Cond: (av.id = r.version_id)
              Buffers: shared hit=7
              ->  CTE Scan on allowed_versions av  (cost=0.00..2.00 rows=100 width=8) (actual time=0.201..0.201 rows=1 loops=1)
                    Buffers: shared hit=3
              ->  Hash  (cost=14.51..14.51 rows=1 width=56) (actual time=0.144..0.145 rows=400 loops=1)
                    Buckets: 1024  Batches: 1  Memory Usage: 36kB
                    Buffers: shared hit=4
                    ->  Hash Join  (cost=3.50..14.51 rows=1 width=56) (actual time=0.052..0.115 rows=400 loops=1)
                          Hash Cond: ((m.app_version_id = r.version_id) AND (m.file_hash = r.file_hash))
                          Buffers: shared hit=4
                          ->  Seq Scan on manifest m  (cost=0.00..8.00 rows=400 width=24) (actual time=0.002..0.016 rows=400 loops=1)
                                Buffers: shared hit=4
                          ->  Hash  (cost=2.00..2.00 rows=100 width=40) (actual time=0.045..0.046 rows=400 loops=1)
                                Buckets: 1024  Batches: 1  Memory Usage: 30kB
                                ->  CTE Scan on requested r  (cost=0.00..2.00 rows=100 width=40) (actual time=0.000..0.019 rows=400 loops=1)
                                      Filter: (version_id IS NOT NULL)
Planning Time: 0.068 ms
Execution Time: 0.616 ms
```
