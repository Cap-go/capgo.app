# Manifest size lookup before / after

Local Postgres 17.11. Not production.

Seed: 80 versions of `com.bench.size` and 400 versions of `com.bench.noise`, 2000 identical hashes per version (960,000 manifest rows). Same hash is repeated on every version so `idx_manifest_file_hash` is not selective.

Before uses the old `OR` join and `idx_manifest_app_version_id` plus `idx_manifest_file_hash`. After uses the split lookup and `idx_manifest_app_version_id_file_hash (app_version_id, file_hash) INCLUDE (file_size)`. `idx_manifest_file_hash` stays.

Timings are the median of 5 hot-cache client round trips after one warmup. `jit` is off. `statement_timeout` is 120s.

| Scenario | Before median | After median | Before rows | After rows |
| --- | ---: | ---: | ---: | ---: |
| fallback version id, 2000 hashes | 165.7 ms | 5 ms | 2000 | 2000 |
| fallback version id, 100 hashes | 8.6 ms | 0.5 ms | 100 | 100 |
| fallback version name, 2000 hashes | 165.2 ms | 4.5 ms | 2000 | 2000 |
| per-file version id, 2000 hashes | 165.2 ms | 4.5 ms | 2000 | 2000 |
| no version, 2000 hashes | 12751 ms | no query | 160000 | 0 |

## Plans

### before — fallback version id, 2000 hashes

->  Nested Loop  (cost=5.19..2556.04 rows=17 width=48) (actual time=0.252..313.311 rows=2000 loops=1)

```
GroupAggregate  (cost=2556.39..2556.73 rows=17 width=48) (actual time=314.072..314.337 rows=2000 loops=1)
  Group Key: request_files.file_hash, app_versions.id
  Buffers: shared hit=46002
  ->  Sort  (cost=2556.39..2556.43 rows=17 width=48) (actual time=314.067..314.111 rows=2000 loops=1)
        Sort Key: request_files.file_hash, app_versions.id
        Sort Method: quicksort  Memory: 141kB
        Buffers: shared hit=46002
        ->  Nested Loop  (cost=5.19..2556.04 rows=17 width=48) (actual time=0.252..313.311 rows=2000 loops=1)
              Join Filter: (manifest.file_hash = request_files.file_hash)
              Rows Removed by Join Filter: 3998000
              Buffers: shared hit=46002
              ->  Nested Loop  (cost=4.77..150.97 rows=17 width=40) (actual time=0.246..9.374 rows=2000 loops=1)
                    Join Filter: (((request_files.version_id IS NOT NULL) AND (app_versions.id = request_files.version_id)) OR ((request_files.version_id IS NULL) AND (app_versions.id = '1'::bigint)))
                    Rows Removed by Join Filter: 158000
                    Buffers: shared hit=2
                    ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.237..0.410 rows=2000 loops=1)
                          Filter: (file_hash IS NOT NULL)
                    ->  Materialize  (cost=4.77..10.17 rows=80 width=8) (actual time=0.000..0.002 rows=80 loops=2000)
                          Buffers: shared hit=2
                          ->  Bitmap Heap Scan on app_versions  (cost=4.77..9.77 rows=80 width=8) (actual time=0.006..0.010 rows=80 loops=1)
                                Recheck Cond: (app_id = 'com.bench.size'::text)
                                Filter: (NOT deleted)
                                Heap Blocks: exact=1
                                Buffers: shared hit=2
                                ->  Bitmap Index Scan on idx_app_id_app_versions  (cost=0.00..4.75 rows=80 width=0) (actual time=0.003..0.003 rows=80 loops=1)
                                      Index Cond: (app_id = 'com.bench.size'::text)
                                      Buffers: shared hit=1
              ->  Index Scan using idx_manifest_app_version_id on manifest  (cost=0.42..116.47 rows=2000 width=25) (actual time=0.001..0.082 rows=2000 loops=2000)
                    Index Cond: (app_version_id = app_versions.id)
                    Buffers: shared hit=46000
Planning:
  Buffers: shared hit=14
Planning Time: 0.192 ms
Execution Time: 314.423 ms
```

### before — fallback version id, 100 hashes

->  Nested Loop  (cost=5.19..2556.04 rows=17 width=48) (actual time=0.028..15.711 rows=100 loops=1)

```
GroupAggregate  (cost=2556.39..2556.73 rows=17 width=48) (actual time=15.743..15.759 rows=100 loops=1)
  Group Key: request_files.file_hash, app_versions.id
  Buffers: shared hit=2302
  ->  Sort  (cost=2556.39..2556.43 rows=17 width=48) (actual time=15.742..15.745 rows=100 loops=1)
        Sort Key: request_files.file_hash, app_versions.id
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=2302
        ->  Nested Loop  (cost=5.19..2556.04 rows=17 width=48) (actual time=0.028..15.711 rows=100 loops=1)
              Join Filter: (manifest.file_hash = request_files.file_hash)
              Rows Removed by Join Filter: 199900
              Buffers: shared hit=2302
              ->  Nested Loop  (cost=4.77..150.97 rows=17 width=40) (actual time=0.022..0.486 rows=100 loops=1)
                    Join Filter: (((request_files.version_id IS NOT NULL) AND (app_versions.id = request_files.version_id)) OR ((request_files.version_id IS NULL) AND (app_versions.id = '1'::bigint)))
                    Rows Removed by Join Filter: 7900
                    Buffers: shared hit=2
                    ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.015..0.023 rows=100 loops=1)
                          Filter: (file_hash IS NOT NULL)
                    ->  Materialize  (cost=4.77..10.17 rows=80 width=8) (actual time=0.000..0.002 rows=80 loops=100)
                          Buffers: shared hit=2
                          ->  Bitmap Heap Scan on app_versions  (cost=4.77..9.77 rows=80 width=8) (actual time=0.004..0.007 rows=80 loops=1)
                                Recheck Cond: (app_id = 'com.bench.size'::text)
                                Filter: (NOT deleted)
                                Heap Blocks: exact=1
                                Buffers: shared hit=2
                                ->  Bitmap Index Scan on idx_app_id_app_versions  (cost=0.00..4.75 rows=80 width=0) (actual time=0.001..0.002 rows=80 loops=1)
                                      Index Cond: (app_id = 'com.bench.size'::text)
                                      Buffers: shared hit=1
              ->  Index Scan using idx_manifest_app_version_id on manifest  (cost=0.42..116.47 rows=2000 width=25) (actual time=0.001..0.083 rows=2000 loops=100)
                    Index Cond: (app_version_id = app_versions.id)
                    Buffers: shared hit=2300
Planning:
  Buffers: shared hit=14
Planning Time: 0.126 ms
Execution Time: 15.790 ms
```

### before — fallback version name, 2000 hashes

->  Nested Loop  (cost=5.19..2556.04 rows=17 width=48) (actual time=0.260..312.901 rows=2000 loops=1)

```
GroupAggregate  (cost=2556.39..2556.73 rows=17 width=48) (actual time=313.639..313.914 rows=2000 loops=1)
  Group Key: request_files.file_hash, app_versions.id
  Buffers: shared hit=46002
  ->  Sort  (cost=2556.39..2556.43 rows=17 width=48) (actual time=313.635..313.680 rows=2000 loops=1)
        Sort Key: request_files.file_hash, app_versions.id
        Sort Method: quicksort  Memory: 141kB
        Buffers: shared hit=46002
        ->  Nested Loop  (cost=5.19..2556.04 rows=17 width=48) (actual time=0.260..312.901 rows=2000 loops=1)
              Join Filter: (manifest.file_hash = request_files.file_hash)
              Rows Removed by Join Filter: 3998000
              Buffers: shared hit=46002
              ->  Nested Loop  (cost=4.77..150.97 rows=17 width=40) (actual time=0.254..9.946 rows=2000 loops=1)
                    Join Filter: (((request_files.version_id IS NOT NULL) AND (app_versions.id = request_files.version_id)) OR ((request_files.version_id IS NULL) AND (app_versions.name = '1'::text)))
                    Rows Removed by Join Filter: 158000
                    Buffers: shared hit=2
                    ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.242..0.397 rows=2000 loops=1)
                          Filter: (file_hash IS NOT NULL)
                    ->  Materialize  (cost=4.77..10.17 rows=80 width=11) (actual time=0.000..0.002 rows=80 loops=2000)
                          Buffers: shared hit=2
                          ->  Bitmap Heap Scan on app_versions  (cost=4.77..9.77 rows=80 width=11) (actual time=0.008..0.012 rows=80 loops=1)
                                Recheck Cond: (app_id = 'com.bench.size'::text)
                                Filter: (NOT deleted)
                                Heap Blocks: exact=1
                                Buffers: shared hit=2
                                ->  Bitmap Index Scan on idx_app_id_app_versions  (cost=0.00..4.75 rows=80 width=0) (actual time=0.004..0.004 rows=80 loops=1)
                                      Index Cond: (app_id = 'com.bench.size'::text)
                                      Buffers: shared hit=1
              ->  Index Scan using idx_manifest_app_version_id on manifest  (cost=0.42..116.47 rows=2000 width=25) (actual time=0.001..0.081 rows=2000 loops=2000)
                    Index Cond: (app_version_id = app_versions.id)
                    Buffers: shared hit=46000
Planning:
  Buffers: shared hit=14
Planning Time: 0.210 ms
Execution Time: 314.009 ms
```

### before — per-file version id, 2000 hashes

->  Nested Loop  (cost=0.70..8275.75 rows=57 width=48) (actual time=0.278..312.968 rows=2000 loops=1)

```
GroupAggregate  (cost=8277.41..8278.55 rows=57 width=48) (actual time=313.753..314.020 rows=2000 loops=1)
  Group Key: request_files.file_hash, app_versions.id
  Buffers: shared hit=46007
  ->  Sort  (cost=8277.41..8277.55 rows=57 width=48) (actual time=313.748..313.790 rows=2000 loops=1)
        Sort Key: request_files.file_hash, app_versions.id
        Sort Method: quicksort  Memory: 141kB
        Buffers: shared hit=46007
        ->  Nested Loop  (cost=0.70..8275.75 rows=57 width=48) (actual time=0.278..312.968 rows=2000 loops=1)
              Join Filter: (manifest.file_hash = request_files.file_hash)
              Rows Removed by Join Filter: 3998000
              Buffers: shared hit=46007
              ->  Nested Loop  (cost=0.28..211.68 rows=57 width=40) (actual time=0.272..10.262 rows=2000 loops=1)
                    Join Filter: (((request_files.version_id IS NOT NULL) AND (app_versions.id = request_files.version_id)) OR (request_files.version_id IS NULL))
                    Rows Removed by Join Filter: 158000
                    Buffers: shared hit=7
                    ->  Index Scan using app_versions_pkey on app_versions  (cost=0.27..31.67 rows=80 width=8) (actual time=0.005..0.035 rows=80 loops=1)
                          Filter: ((NOT deleted) AND (app_id = 'com.bench.size'::text))
                          Rows Removed by Filter: 400
                          Buffers: shared hit=7
                    ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.003..0.062 rows=2000 loops=80)
                          Filter: (file_hash IS NOT NULL)
              ->  Index Scan using idx_manifest_app_version_id on manifest  (cost=0.42..116.47 rows=2000 width=25) (actual time=0.001..0.081 rows=2000 loops=2000)
                    Index Cond: (app_version_id = app_versions.id)
                    Buffers: shared hit=46000
Planning:
  Buffers: shared hit=14
Planning Time: 0.174 ms
Execution Time: 314.111 ms
```

### before — no version, 2000 hashes

->  Nested Loop  (cost=0.70..8275.75 rows=57 width=48) (actual time=0.274..24501.270 rows=160000 loops=1)

```
GroupAggregate  (cost=8277.41..8278.55 rows=57 width=48) (actual time=24584.193..24604.666 rows=160000 loops=1)
  Group Key: request_files.file_hash, app_versions.id
  Buffers: shared hit=3898007
  ->  Sort  (cost=8277.41..8277.55 rows=57 width=48) (actual time=24584.186..24587.946 rows=160000 loops=1)
        Sort Key: request_files.file_hash, app_versions.id
        Sort Method: quicksort  Memory: 13583kB
        Buffers: shared hit=3898007
        ->  Nested Loop  (cost=0.70..8275.75 rows=57 width=48) (actual time=0.274..24501.270 rows=160000 loops=1)
              Join Filter: (manifest.file_hash = request_files.file_hash)
              Rows Removed by Join Filter: 319840000
              Buffers: shared hit=3898007
              ->  Nested Loop  (cost=0.28..211.68 rows=57 width=40) (actual time=0.266..29.543 rows=160000 loops=1)
                    Join Filter: (((request_files.version_id IS NOT NULL) AND (app_versions.id = request_files.version_id)) OR (request_files.version_id IS NULL))
                    Buffers: shared hit=7
                    ->  Index Scan using app_versions_pkey on app_versions  (cost=0.27..31.67 rows=80 width=8) (actual time=0.007..0.175 rows=80 loops=1)
                          Filter: ((NOT deleted) AND (app_id = 'com.bench.size'::text))
                          Rows Removed by Filter: 400
                          Buffers: shared hit=7
                    ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.003..0.168 rows=2000 loops=80)
                          Filter: (file_hash IS NOT NULL)
              ->  Index Scan using idx_manifest_app_version_id on manifest  (cost=0.42..116.47 rows=2000 width=25) (actual time=0.001..0.082 rows=2000 loops=160000)
                    Index Cond: (app_version_id = app_versions.id)
                    Buffers: shared hit=3898000
Planning:
  Buffers: shared hit=14
Planning Time: 0.223 ms
Execution Time: 24608.058 ms
```

### after — fallback version id, 2000 hashes

->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.218..0.286 rows=2000 loops=1)

```
GroupAggregate  (cost=17.27..17.29 rows=1 width=48) (actual time=3.927..4.191 rows=2000 loops=1)
  Group Key: r.file_hash
  Buffers: shared hit=12001
  CTE requested
    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=40) (actual time=0.491..0.593 rows=2000 loops=1)
          Group Key: request_files.file_hash, request_files.version_id
          Batches: 1  Memory Usage: 257kB
          ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.218..0.286 rows=2000 loops=1)
                Filter: (file_hash IS NOT NULL)
  ->  Sort  (cost=14.77..14.77 rows=1 width=48) (actual time=3.926..3.969 rows=2000 loops=1)
        Sort Key: r.file_hash
        Sort Method: quicksort  Memory: 141kB
        Buffers: shared hit=12001
        ->  Nested Loop  (cost=0.70..14.76 rows=1 width=48) (actual time=0.503..3.211 rows=2000 loops=1)
              Buffers: shared hit=12001
              ->  Nested Loop  (cost=0.42..6.45 rows=1 width=48) (actual time=0.499..2.374 rows=2000 loops=1)
                    Buffers: shared hit=6001
                    ->  CTE Scan on requested r  (cost=0.00..2.00 rows=1 width=32) (actual time=0.491..0.770 rows=2000 loops=1)
                          Filter: (version_id IS NULL)
                    ->  Index Only Scan using idx_manifest_app_version_id_file_hash on manifest m  (cost=0.42..4.44 rows=1 width=25) (actual time=0.001..0.001 rows=1 loops=2000)
                          Index Cond: ((app_version_id = '1'::bigint) AND (file_hash = r.file_hash))
                          Heap Fetches: 0
                          Buffers: shared hit=6001
              ->  Index Scan using app_versions_pkey on app_versions av  (cost=0.27..8.29 rows=1 width=8) (actual time=0.000..0.000 rows=1 loops=2000)
                    Index Cond: (id = '1'::bigint)
                    Filter: ((NOT deleted) AND (app_id = 'com.bench.size'::text))
                    Buffers: shared hit=6000
Planning Time: 0.081 ms
Execution Time: 4.275 ms
```

### after — fallback version id, 100 hashes

->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.012..0.017 rows=100 loops=1)

```
GroupAggregate  (cost=17.27..17.29 rows=1 width=48) (actual time=0.181..0.195 rows=100 loops=1)
  Group Key: r.file_hash
  Buffers: shared hit=601
  CTE requested
    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=40) (actual time=0.025..0.029 rows=100 loops=1)
          Group Key: request_files.file_hash, request_files.version_id
          Batches: 1  Memory Usage: 24kB
          ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.012..0.017 rows=100 loops=1)
                Filter: (file_hash IS NOT NULL)
  ->  Sort  (cost=14.77..14.77 rows=1 width=48) (actual time=0.181..0.183 rows=100 loops=1)
        Sort Key: r.file_hash
        Sort Method: quicksort  Memory: 28kB
        Buffers: shared hit=601
        ->  Nested Loop  (cost=0.70..14.76 rows=1 width=48) (actual time=0.033..0.159 rows=100 loops=1)
              Buffers: shared hit=601
              ->  Nested Loop  (cost=0.42..6.45 rows=1 width=48) (actual time=0.030..0.115 rows=100 loops=1)
                    Buffers: shared hit=301
                    ->  CTE Scan on requested r  (cost=0.00..2.00 rows=1 width=32) (actual time=0.025..0.039 rows=100 loops=1)
                          Filter: (version_id IS NULL)
                    ->  Index Only Scan using idx_manifest_app_version_id_file_hash on manifest m  (cost=0.42..4.44 rows=1 width=25) (actual time=0.001..0.001 rows=1 loops=100)
                          Index Cond: ((app_version_id = '1'::bigint) AND (file_hash = r.file_hash))
                          Heap Fetches: 0
                          Buffers: shared hit=301
              ->  Index Scan using app_versions_pkey on app_versions av  (cost=0.27..8.29 rows=1 width=8) (actual time=0.000..0.000 rows=1 loops=100)
                    Index Cond: (id = '1'::bigint)
                    Filter: ((NOT deleted) AND (app_id = 'com.bench.size'::text))
                    Buffers: shared hit=300
Planning Time: 0.043 ms
Execution Time: 0.218 ms
```

### after — fallback version name, 2000 hashes

->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.210..0.282 rows=2000 loops=1)

```
GroupAggregate  (cost=17.27..17.29 rows=1 width=48) (actual time=3.176..3.452 rows=2000 loops=1)
  Group Key: r.file_hash, av.id
  Buffers: shared hit=6004
  CTE requested
    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=40) (actual time=0.500..0.608 rows=2000 loops=1)
          Group Key: request_files.file_hash, request_files.version_id
          Batches: 1  Memory Usage: 257kB
          ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.210..0.282 rows=2000 loops=1)
                Filter: (file_hash IS NOT NULL)
  ->  Sort  (cost=14.77..14.77 rows=1 width=48) (actual time=3.174..3.218 rows=2000 loops=1)
        Sort Key: r.file_hash, av.id
        Sort Method: quicksort  Memory: 141kB
        Buffers: shared hit=6004
        ->  Nested Loop  (cost=0.70..14.76 rows=1 width=48) (actual time=0.511..2.460 rows=2000 loops=1)
              Buffers: shared hit=6004
              ->  Index Scan using idx_app_id_name_app_versions on app_versions av  (cost=0.27..8.29 rows=1 width=8) (actual time=0.005..0.006 rows=1 loops=1)
                    Index Cond: ((app_id = 'com.bench.size'::text) AND (name = '1'::text))
                    Filter: (NOT deleted)
                    Buffers: shared hit=3
              ->  Nested Loop  (cost=0.42..6.45 rows=1 width=48) (actual time=0.505..2.361 rows=2000 loops=1)
                    Buffers: shared hit=6001
                    ->  CTE Scan on requested r  (cost=0.00..2.00 rows=1 width=32) (actual time=0.500..0.789 rows=2000 loops=1)
                          Filter: (version_id IS NULL)
                    ->  Index Only Scan using idx_manifest_app_version_id_file_hash on manifest m  (cost=0.42..4.44 rows=1 width=25) (actual time=0.001..0.001 rows=1 loops=2000)
                          Index Cond: ((app_version_id = av.id) AND (file_hash = r.file_hash))
                          Heap Fetches: 0
                          Buffers: shared hit=6001
Planning:
  Buffers: shared hit=14
Planning Time: 0.161 ms
Execution Time: 3.564 ms
```

### after — per-file version id, 2000 hashes

->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.265..0.336 rows=2000 loops=1)

```
GroupAggregate  (cost=91.66..92.00 rows=17 width=48) (actual time=3.213..3.487 rows=2000 loops=1)
  Group Key: r.file_hash, av.id
  Buffers: shared hit=6003
  CTE requested
    ->  HashAggregate  (cost=1.50..2.50 rows=100 width=40) (actual time=0.551..0.658 rows=2000 loops=1)
          Group Key: request_files.file_hash, request_files.version_id
          Batches: 1  Memory Usage: 385kB
          ->  Function Scan on jsonb_to_recordset request_files  (cost=0.00..1.00 rows=100 width=40) (actual time=0.265..0.336 rows=2000 loops=1)
                Filter: (file_hash IS NOT NULL)
  ->  Sort  (cost=89.15..89.20 rows=17 width=48) (actual time=3.211..3.259 rows=2000 loops=1)
        Sort Key: r.file_hash, av.id
        Sort Method: quicksort  Memory: 141kB
        Buffers: shared hit=6003
        ->  Nested Loop  (cost=11.19..88.81 rows=17 width=48) (actual time=0.573..2.553 rows=2000 loops=1)
              Join Filter: (av.id = m.app_version_id)
              Buffers: shared hit=6003
              ->  Hash Join  (cost=10.77..13.03 rows=17 width=48) (actual time=0.567..0.996 rows=2000 loops=1)
                    Hash Cond: (r.version_id = av.id)
                    Buffers: shared hit=2
                    ->  CTE Scan on requested r  (cost=0.00..2.00 rows=100 width=40) (actual time=0.552..0.851 rows=2000 loops=1)
                          Filter: (version_id IS NOT NULL)
                    ->  Hash  (cost=9.77..9.77 rows=80 width=8) (actual time=0.013..0.013 rows=80 loops=1)
                          Buckets: 1024  Batches: 1  Memory Usage: 12kB
                          Buffers: shared hit=2
                          ->  Bitmap Heap Scan on app_versions av  (cost=4.77..9.77 rows=80 width=8) (actual time=0.005..0.008 rows=80 loops=1)
                                Recheck Cond: (app_id = 'com.bench.size'::text)
                                Filter: (NOT deleted)
                                Heap Blocks: exact=1
                                Buffers: shared hit=2
                                ->  Bitmap Index Scan on idx_app_id_app_versions  (cost=0.00..4.75 rows=80 width=0) (actual time=0.002..0.002 rows=80 loops=1)
                                      Index Cond: (app_id = 'com.bench.size'::text)
                                      Buffers: shared hit=1
              ->  Index Only Scan using idx_manifest_app_version_id_file_hash on manifest m  (cost=0.42..4.44 rows=1 width=25) (actual time=0.001..0.001 rows=1 loops=2000)
                    Index Cond: ((app_version_id = r.version_id) AND (file_hash = r.file_hash))
                    Heap Fetches: 0
                    Buffers: shared hit=6001
Planning:
  Buffers: shared hit=14
Planning Time: 0.166 ms
Execution Time: 3.603 ms
```

### after — no version, 2000 hashes

no query

handler returns size_unknown and does not query

## Settings

```
jit=off
server_version=17.11
shared_buffers=512 MiB
work_mem=32 MiB
```

