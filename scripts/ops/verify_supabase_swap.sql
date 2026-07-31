-- Capgo-EU post-reclaim verification — safe for Supabase SQL Editor.
-- Paste into SQL Editor and run (no psql meta-commands).

SELECT pg_size_pretty(pg_database_size(current_database())::bigint) AS db_size;

SELECT
  name,
  setting,
  unit
FROM pg_settings
WHERE name IN ('shared_buffers', 'work_mem', 'max_connections');

SELECT
  relname,
  n_live_tup,
  pg_size_pretty(pg_total_relation_size(format('%I.%I', schemaname, relname)::regclass)::bigint) AS total
FROM pg_stat_user_tables
WHERE (schemaname, relname) IN (
  ('net', '_http_response'),
  ('public', 'audit_logs'),
  ('public', 'app_versions'),
  ('public', 'manifest'),
  ('pgmq', 'a_on_version_update'),
  ('pgmq', 'a_on_manifest_create'),
  ('pgmq', 'a_webhook_dispatcher'),
  ('pgmq', 'a_on_channel_update')
)
ORDER BY pg_total_relation_size(format('%I.%I', schemaname, relname)::regclass) DESC;

-- Sample first 1000 non-null manifests; a zero does not prove global completion.
SELECT count(*) AS eligible_dual_storage_sample
FROM (
  SELECT sample.id
  FROM (
    SELECT av.id, av.manifest
    FROM public.app_versions AS av
    WHERE av.manifest IS NOT NULL
    ORDER BY av.id
    LIMIT 1000
  ) AS sample
  WHERE NOT EXISTS (
      SELECT 1
      FROM unnest(sample.manifest) AS entry(file_name, s3_path, file_hash)
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.manifest AS m
        WHERE m.app_version_id = sample.id
          AND m.s3_path = entry.s3_path
          AND m.file_hash = entry.file_hash
      )
    )
) AS eligible;

SELECT count(*)::bigint AS non_null_manifest_versions
FROM public.app_versions
WHERE manifest IS NOT NULL;

SELECT
  name,
  enabled,
  hour_interval,
  run_at_hour,
  run_at_minute,
  target,
  description,
  updated_at
FROM public.cron_tasks
WHERE name IN (
  'cleanup_queue_messages',
  'cleanup_net_http_response',
  'cleanup_old_audit_logs',
  'null_migrated_app_version_manifests'
)
ORDER BY name;

SELECT indexname,
       (
         SELECT i.indisvalid
         FROM pg_catalog.pg_class AS idx
         JOIN pg_catalog.pg_namespace AS ns ON ns.oid = idx.relnamespace
         JOIN pg_catalog.pg_index AS i ON i.indexrelid = idx.oid
         WHERE ns.nspname = 'public'
           AND idx.relname = 'app_versions_manifest_present_idx'
       ) AS indisvalid
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'app_versions_manifest_present_idx';

SELECT EXISTS (
  SELECT 1
  FROM public.audit_logs
  WHERE created_at < now() - interval '30 days'
  LIMIT 1
) AS has_audit_logs_older_than_30d;

-- Fixed Capgo-EU queue set (no psql \gexec).
SELECT 'a_on_manifest_create' AS queue_name,
       EXISTS (
         SELECT 1 FROM pgmq.a_on_manifest_create
         WHERE archived_at < now() - interval '2 days' LIMIT 1
       ) AS has_rows_older_than_2d
UNION ALL SELECT 'a_on_version_update',
       EXISTS (
         SELECT 1 FROM pgmq.a_on_version_update
         WHERE archived_at < now() - interval '2 days' LIMIT 1
       )
UNION ALL SELECT 'a_webhook_dispatcher',
       EXISTS (
         SELECT 1 FROM pgmq.a_webhook_dispatcher
         WHERE archived_at < now() - interval '2 days' LIMIT 1
       )
UNION ALL SELECT 'a_on_channel_update',
       EXISTS (
         SELECT 1 FROM pgmq.a_on_channel_update
         WHERE archived_at < now() - interval '2 days' LIMIT 1
       );

SELECT 'q_on_manifest_create' AS queue_name,
       EXISTS (
         SELECT 1 FROM pgmq.q_on_manifest_create WHERE read_ct > 5 LIMIT 1
       ) AS has_stuck_read_ct_gt_5
UNION ALL SELECT 'q_on_version_update',
       EXISTS (
         SELECT 1 FROM pgmq.q_on_version_update WHERE read_ct > 5 LIMIT 1
       )
UNION ALL SELECT 'q_webhook_dispatcher',
       EXISTS (
         SELECT 1 FROM pgmq.q_webhook_dispatcher WHERE read_ct > 5 LIMIT 1
       )
UNION ALL SELECT 'q_on_channel_update',
       EXISTS (
         SELECT 1 FROM pgmq.q_on_channel_update WHERE read_ct > 5 LIMIT 1
       );

SELECT
  'index hit rate' AS name,
  ROUND((sum(idx_blks_hit)::numeric / nullif(sum(idx_blks_hit + idx_blks_read), 0) * 100), 2) AS ratio
FROM pg_statio_user_indexes
UNION ALL
SELECT
  'table hit rate',
  ROUND((sum(heap_blks_hit)::numeric / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0) * 100), 2)
FROM pg_statio_user_tables;
