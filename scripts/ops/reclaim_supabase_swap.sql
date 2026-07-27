-- Capgo-EU Phase A reclaim — safe for Supabase SQL Editor.
-- Paste this whole file into SQL Editor and run.
--
-- Prerequisites (deploy first, or this script fails the preflight):
--   - 20260722082019_fix_supabase_swap_memory
--   - 20260722154010_app_versions_manifest_present_idx
--
-- Re-run until Notices show deleted/updated = 0 (functions always raise a notice).
-- VACUUM is NOT here: SQL Editor wraps work in a transaction and rejects VACUUM.
-- Optional later via psql: scripts/ops/reclaim_supabase_swap_vacuum.sql

SET lock_timeout = '5s';
SET statement_timeout = '180s';

-- ---------------------------------------------------------------------------
-- 0) Preflight + baseline sizes
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.null_migrated_app_version_manifests()') IS NULL
     OR to_regprocedure('public.cleanup_net_http_response()') IS NULL THEN
    RAISE EXCEPTION
      'Missing reclaim functions. Deploy migration 20260722082019_fix_supabase_swap_memory first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS idx
    JOIN pg_catalog.pg_namespace AS ns ON ns.oid = idx.relnamespace
    JOIN pg_catalog.pg_index AS i ON i.indexrelid = idx.oid
    WHERE ns.nspname = 'public'
      AND idx.relname = 'app_versions_manifest_present_idx'
      AND i.indrelid = 'public.app_versions'::pg_catalog.regclass
      AND i.indisvalid
  ) THEN
    RAISE EXCEPTION
      'Missing or invalid app_versions_manifest_present_idx. Deploy migration 20260722154010 first.';
  END IF;
END
$$;

SELECT pg_size_pretty(pg_database_size(current_database())::bigint) AS db_size;

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

-- ---------------------------------------------------------------------------
-- 1) Truncate pg_net response bloat (biggest immediate win)
-- ---------------------------------------------------------------------------
TRUNCATE TABLE net._http_response;

-- ---------------------------------------------------------------------------
-- 2) Purge pgmq archives/stuck messages (batched; re-run until notice = 0)
-- ---------------------------------------------------------------------------
SELECT public.cleanup_queue_messages();

-- ---------------------------------------------------------------------------
-- 3) Null fully migrated app_versions.manifest arrays (re-run until notice = 0)
-- ---------------------------------------------------------------------------
SELECT public.null_migrated_app_version_manifests();

-- ---------------------------------------------------------------------------
-- 4) Trim audit_logs older than 30 days (re-run until notice = 0)
-- ---------------------------------------------------------------------------
SELECT public.cleanup_old_audit_logs();

-- ---------------------------------------------------------------------------
-- 5) Final sizes
-- ---------------------------------------------------------------------------
SELECT pg_size_pretty(pg_database_size(current_database())::bigint) AS db_size_after;

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
