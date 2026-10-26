-- One-row snapshot of DB-side cost counters, for engine schema :'schema'
select pg_current_wal_lsn()::text as lsn,
  (select coalesce(sum(n_tup_ins),0) from pg_stat_user_tables where schemaname = :'schema') ins,
  (select coalesce(sum(n_tup_upd),0) from pg_stat_user_tables where schemaname = :'schema') upd,
  (select coalesce(sum(n_tup_del),0) from pg_stat_user_tables where schemaname = :'schema') del,
  (select coalesce(sum(n_dead_tup),0) from pg_stat_user_tables where schemaname = :'schema') dead,
  (select coalesce(sum(autovacuum_count+vacuum_count),0) from pg_stat_user_tables where schemaname = :'schema') vacuums,
  (select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname = :'schema' and c.relkind in ('r','p')) bytes,
  (select sum(blks_hit+blks_read) from pg_stat_database where datname=current_database()) blks,
  (select sum(xact_commit) from pg_stat_database where datname=current_database()) xacts,
  -- whole pipeline: every table the queue system touches (engine, pg_cron logs, pg_net, bench)
  (select coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0) from pg_stat_all_tables where schemaname not in ('pg_catalog','information_schema','pg_toast')) all_writes,
  (select coalesce(sum(n_dead_tup),0) from pg_stat_all_tables where schemaname not in ('pg_catalog','information_schema','pg_toast')) all_dead,
  (select coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0) from pg_stat_all_tables where schemaname = 'cron') cron_writes,
  (select coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0) from pg_stat_all_tables where schemaname = 'net') net_writes,
  (select coalesce(sum(n_tup_ins),0) from pg_stat_all_tables where schemaname = 'net' and relname = 'http_request_queue') http_calls,
  (select count(*) from cron.job_run_details) cron_log_rows;
