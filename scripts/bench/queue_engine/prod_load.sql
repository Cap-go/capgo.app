-- Read-only queries used to derive the benchmark load model from production.
-- Run with: bunx supabase db query --project-ref <prod-ref> --linked -f prod_load.sql
-- (Each statement only reads catalog/statistics views or samples a few recent rows.)

-- 1. Per-queue lifetime counters since the last restart. Divide n_tup_ins by uptime for msg/s;
--    n_tup_upd / n_tup_ins gives reads + cf_ids rewrites per message.
select
  now() - pg_postmaster_start_time() as uptime,
  relname,
  n_tup_ins,
  n_tup_upd,
  n_tup_del,
  n_dead_tup,
  autovacuum_count,
  pg_total_relation_size(relid) as bytes
from pg_stat_user_tables
where schemaname = 'pgmq'
order by n_tup_ins desc;

-- 2. Share of all database row writes that come from pgmq.
select
  (select sum(n_tup_ins + n_tup_upd + n_tup_del) from pg_stat_user_tables where schemaname = 'pgmq') as pgmq_writes,
  (select sum(n_tup_ins + n_tup_upd + n_tup_del) from pg_stat_user_tables) as all_writes,
  (select sum(autovacuum_count) from pg_stat_user_tables where schemaname = 'pgmq') as pgmq_autovacuums;

-- 3. Consumer-side statement cost.
select
  left(regexp_replace(query, '\s+', ' ', 'g'), 110) as query,
  calls,
  total_exec_time,
  mean_exec_time,
  rows,
  wal_bytes
from pg_stat_statements
where query ilike '%pgmq.%'
order by total_exec_time desc
limit 10;

-- 4. Manifest burst size: manifest rows (= on_manifest_create messages) per recent bundle.
with v as (
  select id from public.app_versions
  where created_at > now() - interval '3 days' and deleted = false
  order by id desc limit 400
)
select
  percentile_cont(array[0.5, 0.9, 0.99]) within group (order by n) as pct,
  avg(n)::int as avg_n,
  max(n) as max_n
from (select v.id, (select count(*) from public.manifest as m where m.app_version_id = v.id) as n from v) as s
where n > 0;
