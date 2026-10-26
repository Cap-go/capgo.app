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
