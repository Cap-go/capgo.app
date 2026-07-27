-- Optional Capgo-EU reclaim VACUUM — psql only (NOT SQL Editor).
-- Run after scripts/ops/reclaim_supabase_swap.sql when deleted/updated notices are 0.
--
-- Example:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ops/reclaim_supabase_swap_vacuum.sql

VACUUM (VERBOSE) pgmq.a_on_version_update;
VACUUM (VERBOSE) pgmq.a_on_manifest_create;
VACUUM (VERBOSE) pgmq.a_webhook_dispatcher;
VACUUM (VERBOSE) pgmq.a_on_channel_update;
VACUUM (VERBOSE) pgmq.q_on_version_update;
VACUUM (VERBOSE) pgmq.q_on_manifest_create;
VACUUM (VERBOSE) pgmq.q_webhook_dispatcher;
VACUUM (VERBOSE) pgmq.q_on_channel_update;

VACUUM (ANALYZE, VERBOSE) public.app_versions;
-- Optional TOAST compaction after dual-storage nulling is done:
-- VACUUM (FULL, VERBOSE) public.app_versions;

VACUUM (ANALYZE, VERBOSE) public.audit_logs;
-- Optional TOAST compaction after audit trim is done:
-- VACUUM (FULL, VERBOSE) public.audit_logs;
