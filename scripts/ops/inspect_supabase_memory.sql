-- Catalog-only snapshot, excluding customer data, SQL text, and parameters.
-- Keep the output private alongside a timestamped host metrics report.
BEGIN;
SET LOCAL transaction_read_only = 'on';
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '5s';

SELECT
    'captured_at' AS section,
    pg_catalog.jsonb_build_object('timestamp', pg_catalog.clock_timestamp())
        AS memory_snapshot
UNION ALL
SELECT
    'settings' AS section,
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(memory_settings))
        AS memory_snapshot
FROM (
    SELECT
        name,
        setting,
        unit,
        source
    FROM pg_catalog.pg_settings
    WHERE
        name IN (
            'shared_buffers', 'work_mem', 'hash_mem_multiplier',
            'maintenance_work_mem',
            'autovacuum_work_mem',
            'autovacuum_max_workers',
            'max_connections', 'max_worker_processes', 'max_parallel_workers',
            'max_parallel_workers_per_gather',
            'max_parallel_maintenance_workers',
            'logical_decoding_work_mem',
            'temp_buffers',
            'temp_file_limit',
            'log_temp_files'
        )
    ORDER BY name
) AS memory_settings
UNION ALL
SELECT
    'connections' AS section,
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(connections)) AS memory_snapshot
FROM (
    SELECT
        backend_type,
        state,
        wait_event_type,
        CASE
            WHEN application_name LIKE 'capgo_api-%' THEN 'capgo_api'
            WHEN application_name LIKE 'capgo_files-%' THEN 'capgo_files'
            WHEN application_name LIKE 'PostgREST%' THEN 'postgrest'
            ELSE 'other'
        END AS application,
        pg_catalog.count(*) AS connections,
        pg_catalog.max(
            pg_catalog.date_part(
                'epoch', pg_catalog.clock_timestamp() - backend_start
            )
        ) AS oldest_seconds
    FROM pg_catalog.pg_stat_activity
    GROUP BY backend_type, state, wait_event_type, application
    ORDER BY connections DESC
) AS connections
UNION ALL
SELECT
    'database_counters' AS section,
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(counters)) AS memory_snapshot
FROM (
    SELECT
        numbackends,
        temp_files,
        temp_bytes,
        deadlocks,
        stats_reset
    FROM pg_catalog.pg_stat_database
    WHERE datname = pg_catalog.current_database()
) AS counters
UNION ALL
SELECT
    'query_counters' AS section,
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(queries)) AS memory_snapshot
FROM (
    -- Fingerprints only: the underlying SQL text may contain customer data.
    SELECT
        queryid::text,
        calls,
        total_exec_time,
        temp_blks_read,
        temp_blks_written
    FROM extensions.pg_stat_statements
    WHERE
        dbid = (
            SELECT db.oid FROM pg_catalog.pg_database AS db
            WHERE db.datname = pg_catalog.current_database()
        ) AND calls > 0
    ORDER BY temp_blks_written DESC, total_exec_time DESC
    LIMIT 20
) AS queries
UNION ALL
SELECT
    'query_stats_interval' AS section,
    pg_catalog.to_jsonb(info) AS memory_snapshot
FROM extensions.pg_stat_statements_info AS info
UNION ALL
SELECT
    'shared_allocations' AS section,
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(allocations)) AS memory_snapshot
FROM (
    SELECT
        name,
        allocated_size
    FROM pg_catalog.pg_shmem_allocations
    ORDER BY allocated_size DESC
    LIMIT 15
) AS allocations
UNION ALL
SELECT
    'current_session_contexts' AS section,
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(contexts)) AS memory_snapshot
FROM (
    -- This view covers only this connection.
    -- Other backends and OS commitments require separate evidence.
    SELECT
        name,
        pg_catalog.sum(total_bytes) AS total_bytes,
        pg_catalog.sum(used_bytes) AS used_bytes
    FROM pg_catalog.pg_backend_memory_contexts
    GROUP BY name
    ORDER BY total_bytes DESC
    LIMIT 15
) AS contexts;

COMMIT;
