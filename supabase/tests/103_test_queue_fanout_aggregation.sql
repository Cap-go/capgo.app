-- Queue fan-out: channel_device_counts is queued once per app per statement
-- and applied with one UPDATE per batch; stats emails are queued once per org
-- and only for apps the cron_email handler would report on.
BEGIN;

SELECT set_config('request.jwt.claim.role', 'service_role', true);

SELECT plan(20);

-- Seed messages (and anything committed earlier) are not part of this test.
SELECT public.process_channel_device_counts_queue(100000);

SELECT tests.create_supabase_user('fanout_user', 'fanout-user@example.com');

INSERT INTO public.users (id, email)
VALUES (tests.get_supabase_uid('fanout_user'), 'fanout-user@example.com');

CREATE TEMP TABLE fanout_orgs (name text PRIMARY KEY, org_id uuid NOT NULL);
INSERT INTO fanout_orgs VALUES
('q', gen_random_uuid()),
('r', gen_random_uuid());

INSERT INTO public.orgs (id, created_by, name, management_email)
SELECT
    org_id,
    tests.get_supabase_uid('fanout_user'),
    'Fanout ' || name,
    'fanout-' || name || '@example.com'
FROM fanout_orgs;

CREATE TEMP TABLE fanout_apps (name text PRIMARY KEY, org text NOT NULL, app_id text NOT NULL);
INSERT INTO fanout_apps
SELECT
    v.name,
    v.org,
    'com.test.fanout.' || v.name || '.' || replace(gen_random_uuid()::text, '-', '')
FROM (VALUES ('q1', 'q'), ('q2', 'q'), ('q3', 'q'), ('q4', 'q'), ('d1', 'q'), ('c1', 'q'), ('r1', 'r')) AS v (name, org);

INSERT INTO public.apps (app_id, icon_url, owner_org, name)
SELECT fa.app_id, '', fan_org.org_id, fa.name
FROM fanout_apps AS fa
INNER JOIN fanout_orgs AS fan_org ON fa.org = fan_org.name;

INSERT INTO public.app_versions (app_id, name, owner_org)
SELECT a.app_id, '1.0.0', a.owner_org
FROM public.apps AS a
INNER JOIN fanout_apps AS fa ON a.app_id = fa.app_id;

INSERT INTO public.channels (app_id, name, version, public, ios, android, owner_org, created_by)
SELECT v.app_id, 'production', v.id, false, true, true, v.owner_org, tests.get_supabase_uid('fanout_user')
FROM public.app_versions AS v
INNER JOIN fanout_apps AS fa ON v.app_id = fa.app_id
WHERE fa.name IN ('q2', 'd1', 'c1');

CREATE TEMP VIEW fanout_count_msgs AS
SELECT fa.name, m.message
FROM pgmq.q_channel_device_counts AS m
INNER JOIN fanout_apps AS fa ON m.message ->> 'app_id' = fa.app_id;

-- ---------------------------------------------------------------------------
-- channel_device_counts
-- ---------------------------------------------------------------------------

INSERT INTO public.channel_devices (channel_id, app_id, device_id, owner_org)
SELECT c.id, c.app_id, 'fanout-device-' || g, c.owner_org
FROM public.channels AS c
INNER JOIN fanout_apps AS fa ON c.app_id = fa.app_id AND fa.name = 'q2'
CROSS JOIN generate_series(1, 5) AS g;

SELECT is(
    (SELECT count(*) FROM fanout_count_msgs WHERE name = 'q2'),
    1::bigint,
    'multi-row insert queues one message for the app'
);

SELECT is(
    (SELECT (message ->> 'delta')::integer FROM fanout_count_msgs WHERE name = 'q2'),
    5,
    'insert message carries the row count as delta'
);

DELETE FROM public.channel_devices
WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'q2')
  AND device_id IN ('fanout-device-1', 'fanout-device-2');

SELECT is(
    (SELECT array_agg((message ->> 'delta')::integer ORDER BY (message ->> 'delta')::integer)
     FROM fanout_count_msgs WHERE name = 'q2'),
    ARRAY[-2, 5],
    'multi-row delete queues one negative message'
);

-- Record every apps row update so the test can check the consumer writes
-- each app once per batch, not once per message.
CREATE TEMP TABLE fanout_app_updates (app_id text NOT NULL);

CREATE FUNCTION tests.fanout_record_app_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO pg_temp.fanout_app_updates (app_id) VALUES (NEW.app_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER fanout_record_app_update
AFTER UPDATE ON public.apps
FOR EACH ROW EXECUTE FUNCTION tests.fanout_record_app_update();

SELECT is(
    public.process_channel_device_counts_queue(1000),
    2::bigint,
    'consumer reports the messages it applied'
);

DROP TRIGGER fanout_record_app_update ON public.apps;

SELECT is(
    (
        SELECT count(*)
        FROM fanout_app_updates
        WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'q2')
    ),
    1::bigint,
    'consumer updates the app row once for both messages'
);

SELECT is(
    (SELECT channel_device_count FROM public.apps WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'q2')),
    3::bigint,
    'aggregated deltas give the real override count'
);

SELECT is(
    (SELECT count(*) FROM pgmq.q_channel_device_counts),
    0::bigint,
    'consumer deletes the batch'
);

-- Legacy per-row messages queued before the migration are still applied,
-- summed per app and clamped at zero.
SELECT pgmq.send_batch('channel_device_counts', ARRAY[
    jsonb_build_object('app_id', (SELECT app_id FROM fanout_apps WHERE name = 'q3'), 'device_id', 'legacy', 'delta', 1),
    jsonb_build_object('app_id', (SELECT app_id FROM fanout_apps WHERE name = 'q3'), 'device_id', 'legacy', 'delta', 1),
    jsonb_build_object('app_id', (SELECT app_id FROM fanout_apps WHERE name = 'q4'), 'delta', -3),
    jsonb_build_object('app_id', (SELECT app_id FROM fanout_apps WHERE name = 'q2'), 'delta', 0),
    jsonb_build_object('delta', 4)
]);

SELECT is(
    public.process_channel_device_counts_queue(1000),
    3::bigint,
    'consumer skips messages without app or delta'
);

SELECT is(
    (SELECT array_agg(a.channel_device_count ORDER BY fa.name)
     FROM public.apps AS a INNER JOIN fanout_apps AS fa ON a.app_id = fa.app_id
     WHERE fa.name IN ('q2', 'q3', 'q4')),
    ARRAY[3, 2, 0]::bigint[],
    'legacy deltas are summed per app and clamped at zero'
);

-- Deleting an app cascades to its overrides without queueing anything.
INSERT INTO public.channel_devices (channel_id, app_id, device_id, owner_org)
SELECT c.id, c.app_id, 'fanout-cascade-' || g, c.owner_org
FROM public.channels AS c
INNER JOIN fanout_apps AS fa ON c.app_id = fa.app_id AND fa.name = 'd1'
CROSS JOIN generate_series(1, 50) AS g;

SELECT public.process_channel_device_counts_queue(1000);

DELETE FROM public.apps WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'd1');

SELECT is(
    (SELECT count(*) FROM public.channel_devices WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'd1')),
    0::bigint,
    'app delete cascades to channel_devices'
);

SELECT is(
    (SELECT count(*) FROM fanout_count_msgs WHERE name = 'd1'),
    0::bigint,
    'cascade from an app delete queues no counter message'
);

-- Deleting a channel (app kept) still decrements the counter.
DELETE FROM public.channels WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'q2');

SELECT is(
    (SELECT (message ->> 'delta')::integer FROM fanout_count_msgs WHERE name = 'q2'),
    -3,
    'channel delete cascade queues one message per app'
);

SELECT public.process_channel_device_counts_queue(1000);

SELECT is(
    (SELECT channel_device_count FROM public.apps WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'q2')),
    0::bigint,
    'counter returns to zero after the channel delete'
);

-- ---------------------------------------------------------------------------
-- cleanup_old_channel_devices: recount only rewrites apps that are wrong
-- ---------------------------------------------------------------------------

-- Only the dedicated fanout fixtures are touched; shared seed apps are left alone.
UPDATE public.apps AS a
SET channel_device_count = (SELECT count(*) FROM public.channel_devices AS cd WHERE cd.app_id = a.app_id)
WHERE a.app_id IN (SELECT app_id FROM fanout_apps);

INSERT INTO public.channel_devices (channel_id, app_id, device_id, owner_org, is_self_set, created_at, updated_at)
SELECT c.id, c.app_id, 'fanout-stale-self-set', c.owner_org, true, now() - interval '100 days', now() - interval '100 days'
FROM public.channels AS c
INNER JOIN fanout_apps AS fa ON c.app_id = fa.app_id AND fa.name = 'c1';

UPDATE public.apps SET channel_device_count = 999
WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'c1');

CREATE TEMP TABLE fanout_ctids AS
SELECT a.app_id, a.ctid AS row_ctid
FROM public.apps AS a
INNER JOIN fanout_apps AS fa ON a.app_id = fa.app_id
WHERE fa.name <> 'c1';

SELECT public.cleanup_old_channel_devices();

SELECT is(
    (SELECT channel_device_count FROM public.apps WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'c1')),
    0::bigint,
    'cleanup recount fixes the drifted counter'
);

SELECT is(
    (SELECT count(*) FROM public.apps AS a INNER JOIN fanout_ctids AS t ON a.app_id = t.app_id WHERE a.ctid <> t.row_ctid),
    0::bigint,
    'cleanup recount leaves apps with a correct counter untouched'
);

SELECT ok(
    EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.channel_devices'::regclass
          AND tgname IN ('channel_device_count_enqueue', 'channel_device_count_enqueue_delete')
        GROUP BY tgrelid
        HAVING count(*) = 2 AND bool_and(tgenabled = 'O')
    ),
    'cleanup re-enables both counter triggers'
);

-- ---------------------------------------------------------------------------
-- Stats emails
-- ---------------------------------------------------------------------------

-- q1: installs this week; q2: failures this week; q3: update checks only;
-- q4: installs only today and 8 days ago (outside the 7 completed days).
INSERT INTO public.daily_version (date, app_id, version_name, install, fail, get)
SELECT v.d, fa.app_id, '1.0.0', v.install, v.fail, v.get
FROM (VALUES
    ('q1', current_date - 3, 4, 0, 10),
    ('q2', current_date - 1, 0, 2, 10),
    ('q3', current_date - 2, 0, 0, 500),
    ('q4', current_date, 7, 0, 10),
    ('q4', current_date - 8, 7, 0, 10),
    ('r1', current_date - 2, 0, 0, 0)
) AS v (name, d, install, fail, get)
INNER JOIN fanout_apps AS fa ON v.name = fa.name;

SELECT public.process_stats_email_weekly();

SELECT is(
    (SELECT array_agg(m.message -> 'payload' ->> 'orgId')
     FROM pgmq.q_cron_email AS m
     WHERE m.message -> 'payload' ->> 'type' = 'weekly_install_stats'
       AND m.message -> 'payload' ->> 'orgId' IN (SELECT org_id::text FROM fanout_orgs)),
    ARRAY[(SELECT org_id::text FROM fanout_orgs WHERE name = 'q')],
    'weekly queues one message per org with activity'
);

SELECT is(
    (SELECT m.message -> 'payload' -> 'appIds'
     FROM pgmq.q_cron_email AS m
     WHERE m.message -> 'payload' ->> 'type' = 'weekly_install_stats'
       AND m.message -> 'payload' ->> 'orgId' = (SELECT org_id::text FROM fanout_orgs WHERE name = 'q')),
    (SELECT jsonb_agg(app_id ORDER BY app_id) FROM fanout_apps WHERE name IN ('q1', 'q2')),
    'weekly message carries only apps with installs or failures in the window'
);

-- Monthly: q1 created a bundle last month, q3 published last month, q4 only
-- created a bundle this month.
UPDATE public.app_versions
SET created_at = date_trunc('month', now()) - interval '10 days'
WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'q1');

INSERT INTO public.channels (app_id, name, version, public, ios, android, owner_org, created_by)
SELECT v.app_id, 'production', v.id, false, true, true, v.owner_org, tests.get_supabase_uid('fanout_user')
FROM public.app_versions AS v
WHERE v.app_id = (SELECT app_id FROM fanout_apps WHERE name = 'q3');

INSERT INTO public.deploy_history (channel_id, app_id, version_id, deployed_at, owner_org, created_by)
SELECT c.id, c.app_id, c.version, date_trunc('month', now()) - interval '1 second', c.owner_org, tests.get_supabase_uid('fanout_user')
FROM public.channels AS c
WHERE c.app_id = (SELECT app_id FROM fanout_apps WHERE name = 'q3');

-- Channel creation may record its own deploy; keep only last month's row.
DELETE FROM public.deploy_history
WHERE app_id = (SELECT app_id FROM fanout_apps WHERE name = 'q3')
  AND deployed_at >= date_trunc('month', now());

SELECT public.process_stats_email_monthly();

SELECT is(
    (SELECT jsonb_agg(m.message -> 'payload' -> 'appIds')
     FROM pgmq.q_cron_email AS m
     WHERE m.message -> 'payload' ->> 'type' = 'monthly_create_stats'
       AND m.message -> 'payload' ->> 'orgId' IN (SELECT org_id::text FROM fanout_orgs)),
    jsonb_build_array((SELECT jsonb_agg(app_id ORDER BY app_id) FROM fanout_apps WHERE name IN ('q1', 'q3'))),
    'monthly queues one message per org with only apps that created or published last month'
);

SELECT is(
    (SELECT m.message -> 'payload' ->> 'email'
     FROM pgmq.q_cron_email AS m
     WHERE m.message -> 'payload' ->> 'type' = 'monthly_create_stats'
       AND m.message -> 'payload' ->> 'orgId' = (SELECT org_id::text FROM fanout_orgs WHERE name = 'q')),
    'fanout-q@example.com',
    'monthly message keeps the org management email'
);

SELECT * FROM finish();

ROLLBACK;
