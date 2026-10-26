-- Capgo queue model, derived from prod pg_stat_user_tables (pgmq schema, 59.4 days uptime, 2026-10-26).
-- msg_per_s_1x = n_tup_ins / uptime_s. fail_p reproduces prod reads/message. edits = consumer rewrites
-- the message once per read (queue_consumer.ts mass_edit_queue_messages_cf_ids).
drop schema if exists bench cascade;
create schema bench;
create table bench.queues(
  name text primary key, msg_per_s_1x float8, burst_mean int, payload_bytes int,
  fail_p float8, edits bool, batch int);
insert into bench.queues values
  ('on_manifest_create',          3.2034, 784, 1600, 0.003, false, 950),
  ('on_channel_update',           0.17602,  1, 2600, 0.01,  true,  100),
  ('webhook_dispatcher',          0.17602,  1, 1500, 0.01,  true,  100),
  ('cron_stat_app',               0.11927,  1,  420, 0.14,  true,   10),
  ('channel_device_counts',       0.10142,  1,  200, 0.0,   false, 1000),
  ('on_version_update',           0.09850,  1, 1900, 0.33,  true,   40),
  ('cron_sync_sub',               0.09623,  1,  420, 0.17,  true,   10),
  ('cron_stat_org',               0.09259,  1,  420, 0.07,  true,  100),
  ('on_version_create',           0.02609,  1, 1000, 0.01,  true,  100),
  ('cron_onboarding_refresh_apps',0.01878,  1,  420, 0.06,  true,    4),
  ('other',                       0.03931,  1,  800, 0.01,  true,  100);
create table bench.payloads(name text primary key, body jsonb);
insert into bench.payloads
select name, jsonb_build_object('function_name', name, 'function_type', 'cloudflare',
  'payload', jsonb_build_object('type','UPDATE','table','x','schema','public',
     'record', jsonb_build_object('pad', repeat(md5(name), greatest(1,(payload_bytes-160)/32)))))
from bench.queues;

create function bench.send_pgmq(q text, k int default 1) returns void language plpgsql as $$
declare p jsonb := (select body from bench.payloads where name = q);
begin for i in 1..k loop perform pgmq.send(q, p); end loop; end $$;

create function bench.send_pgque(q text, k int default 1) returns void language plpgsql as $$
declare p jsonb := (select body from bench.payloads where name = q);
begin for i in 1..k loop perform pgque.send(q, p); end loop; end $$;

-- Today's Capgo consumer: read (UPDATE vt/read_ct) -> commit -> cf_ids rewrite (UPDATE) -> commit
-- -> delete successes -> commit. Failed messages stay and are re-read after vt.
create procedure bench.consume_pgmq(max_iters int default 1000) language plpgsql as $$
declare r record; ids bigint[]; ok bigint[]; it int;
begin
  for r in select * from bench.queues order by name loop
    it := 0;
    loop
      select array_agg(msg_id) into ids from pgmq.read(r.name, 5, r.batch);
      commit;
      exit when ids is null;
      if r.edits then
        execute format('update pgmq.q_%I set message = jsonb_set(message, ''{cf_ids}'', coalesce(message->''cf_ids'', ''[]''::jsonb) || to_jsonb(gen_random_uuid()::text)) where msg_id = any($1)', r.name) using ids;
        commit;
      end if;
      select array_agg(x) into ok from unnest(ids) x where random() >= r.fail_p;
      if ok is not null then perform pgmq.delete(r.name, ok); end if;
      commit;
      it := it + 1;
      exit when it >= max_iters or array_length(ids, 1) < r.batch;
    end loop;
  end loop;
end $$;

-- Same consumer on pgque: next_batch -> fetch events -> commit -> nack failures (retry in 5s,
-- DLQ after 5) + ack -> commit. Loops until no tick window is ready. Events are immutable, so the
-- cf_ids rewrite has no equivalent (it would move to logs).
create procedure bench.consume_pgque(max_iters int default 1000) language plpgsql as $$
declare r record; msgs pgque.message[]; m pgque.message; bid bigint; it int;
begin
  for r in select * from bench.queues order by name loop
    it := 0;
    loop
      bid := pgque.next_batch(r.name, 'capgo');
      exit when bid is null;
      select array_agg(row(e.ev_id, bid, e.ev_type, e.ev_data, e.ev_retry, e.ev_time,
                           e.ev_extra1, e.ev_extra2, e.ev_extra3, e.ev_extra4)::pgque.message)
        into msgs from pgque.get_batch_events(bid) e;
      commit;
      if msgs is not null then
        foreach m in array msgs loop
          if random() < r.fail_p then perform pgque.nack(bid, m, interval '5 seconds'); end if;
        end loop;
      end if;
      perform pgque.ack(bid);
      commit;
      it := it + 1;
      exit when it >= max_iters;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Surrounding pipeline. Both engines get the same jobs at prod cadence so the
-- comparison covers the whole queue system, not only send/read/ack.
-- ---------------------------------------------------------------------------

-- Dispatcher: process_function_queue, run by process_all_cron_tasks every 10 s.
-- Today: count(*) of q_<name> (including messages still invisible after a
-- failure), then one pg_net request per batch_size, capped at 10.
create function bench.dispatch_pgmq() returns integer language plpgsql as $$
declare r record; n bigint; calls int := 0; k int;
begin
  for r in select * from bench.queues order by name loop
    execute format('select count(*) from pgmq.%I', 'q_' || r.name) into n;
    if n > 0 then
      for k in 1..least(ceil(n / r.batch::float8)::int, 10) loop
        perform net.http_post(url := 'http://127.0.0.1:9/functions/v1/triggers/queue_consumer/sync',
          body := jsonb_build_object('queue_name', r.name, 'batch_size', r.batch),
          headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 1000);
        calls := calls + 1;
      end loop;
    end if;
  end loop;
  return calls;
end $$;

-- pgque: only ticked, unconsumed events count. One Worker call drains whole
-- batches up to the 10k subrequest budget.
create function bench.dispatch_pgque() returns integer language plpgsql as $$
declare r record; n bigint; calls int := 0; k int;
begin
  for r in select * from bench.queues order by name loop
    select coalesce(max(pending_events), 0) into n from pgque.get_consumer_info(r.name, 'capgo');
    if n > 0 then
      for k in 1..least(ceil(n / 10000.0)::int, 10) loop
        perform net.http_post(url := 'http://127.0.0.1:9/functions/v1/triggers/queue_consumer/sync',
          body := jsonb_build_object('queue_name', r.name),
          headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 1000);
        calls := calls + 1;
      end loop;
    end if;
  end loop;
  return calls;
end $$;

-- Health: the queries /queue_health runs for every queue (prod calls each one
-- about every 24 s).
create function bench.health_pgmq() returns void language plpgsql as $$
declare q text; x record;
begin
  for q in select queue_name from pgmq.list_queues() order by queue_name loop
    perform to_regclass('pgmq.q_' || q) is not null, to_regclass('pgmq.a_' || q) is not null;
    execute format($f$
      select count(*)::bigint, count(*) filter (where read_ct = 0)::bigint,
        count(*) filter (where read_ct = 0 and vt <= now() and enqueued_at < now() - interval '300 seconds')::bigint,
        count(*) filter (where read_ct > 5)::bigint, max(read_ct)::bigint,
        extract(epoch from (now() - min(enqueued_at) filter (where vt <= now())))::numeric
      from pgmq.%I $f$, 'q_' || q) into x;
    execute format($f$
      select count(*)::bigint, count(*) filter (where archived_at < now() - interval '86400 seconds')::bigint,
        count(*) filter (where archived_at >= now() - interval '3600 seconds')::bigint,
        extract(epoch from (now() - min(archived_at)))::numeric
      from pgmq.%I $f$, 'a_' || q) into x;
  end loop;
end $$;

create function bench.health_pgque() returns void language plpgsql as $$
begin
  perform * from pgque.get_queue_info();
  perform * from pgque.get_consumer_info();
  perform ev_queue, count(*), min(ev_retry_after) from pgque.retry_queue group by 1;
  perform dl_queue_id, count(*), min(dl_time) from pgque.dead_letter group by 1;
end $$;

-- Hourly cleanup: cleanup_queue_messages (archive older than 2 days, poison
-- read_ct > 5) vs pgque dead-letter purge. pgque.maint() covers rotation.
create function bench.cleanup_pgmq() returns void language plpgsql as $$
declare q text;
begin
  for q in select queue_name from pgmq.list_queues() order by queue_name loop
    execute format('delete from pgmq.%I where ctid in (select ctid from pgmq.%I where archived_at < now() - interval ''2 days'' limit 5000)', 'a_' || q, 'a_' || q);
    execute format('delete from pgmq.%I where ctid in (select ctid from pgmq.%I where read_ct > 5 limit 5000)', 'q_' || q, 'q_' || q);
  end loop;
end $$;

create function bench.cleanup_pgque() returns void language plpgsql as $$
declare q text;
begin
  for q in select queue_name from pgque.queue order by queue_name loop
    perform pgque.dlq_purge(q, interval '2 days');
  end loop;
end $$;
