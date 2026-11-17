BEGIN;

SELECT plan(36);

-- Storage is billed in GB-hours from daily_storage_hourly only.

CREATE TEMP TABLE gbh_ctx AS
SELECT
    '7b1d4c2e-5f60-4a71-8b92-a3c4d5e6f701'::uuid AS org_id,
    '7b1d4c2e-5f60-4a71-8b92-a3c4d5e6f702'::uuid AS other_org_id,
    'com.test.gbhours.live'::varchar AS live_app,
    'com.test.gbhours.deleted'::varchar AS deleted_app,
    DATE '2026-01-01' AS start_date,
    DATE '2026-01-11' AS end_date;

INSERT INTO public.orgs (id, created_by, name, management_email)
SELECT org_id, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid, 'GB hours billing', 'gb-hours-billing@test.local'
FROM gbh_ctx
UNION ALL
SELECT other_org_id, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid, 'GB hours other', 'gb-hours-other@test.local'
FROM gbh_ctx;

INSERT INTO public.apps (app_id, icon_url, name, owner_org, user_id)
SELECT live_app, '', 'GB hours live', org_id, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
FROM gbh_ctx
UNION ALL
SELECT deleted_app, '', 'GB hours deleted', org_id, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
FROM gbh_ctx;

-- 10 day period = 240 hours. Whole-day rows use cycle_start = date.
-- live app: 1 GiB stored for 240 hours in total, spread over two days.
-- deleted app: 0.5 GiB for 240 hours.
-- Ignored by the billing period: days out of range, the previous cycle's part
-- of the first day, the next cycle's part of the end day, and other orgs (one
-- of them on the same app ID and day, as when a deleted app ID is recreated).
INSERT INTO public.daily_storage_hourly (app_id, owner_org, cycle_start, date, storage_byte_hours)
SELECT live_app, org_id, start_date, start_date, 1073741824::double precision * 100 FROM gbh_ctx
UNION ALL
SELECT live_app, org_id, start_date + 5, start_date + 5, 1073741824::double precision * 140 FROM gbh_ctx
UNION ALL
SELECT deleted_app, org_id, start_date + 2, start_date + 2, 536870912::double precision * 240 FROM gbh_ctx
UNION ALL
SELECT live_app, org_id, start_date - 1, start_date - 1, 1073741824::double precision * 999 FROM gbh_ctx
UNION ALL
SELECT live_app, org_id, end_date + 1, end_date + 1, 1073741824::double precision * 999 FROM gbh_ctx
UNION ALL
SELECT live_app, org_id, start_date - 30, start_date, 1073741824::double precision * 999 FROM gbh_ctx
UNION ALL
SELECT live_app, org_id, end_date, end_date, 1073741824::double precision * 999 FROM gbh_ctx
UNION ALL
SELECT live_app, other_org_id, start_date, start_date, 1073741824::double precision * 999 FROM gbh_ctx
UNION ALL
SELECT 'com.test.gbhours.other', other_org_id, start_date + 1, start_date + 1, 1073741824::double precision * 999 FROM gbh_ctx;

SELECT
    is(
        (SELECT public.get_org_storage_billable_bytes(org_id, start_date, end_date) FROM gbh_ctx),
        1610612736::bigint,
        'billable storage is the byte-hours of the period divided by its hours (1.5 GiB average)'
    );

SELECT
    is(
        (SELECT public.get_org_storage_billable_bytes(org_id, start_date, start_date) FROM gbh_ctx),
        pg_catalog.ceil(1073741824::numeric * 100 / 24)::bigint,
        'a single day period divides by 24 hours'
    );

SELECT
    is(
        (SELECT public.get_org_storage_billable_bytes(org_id, start_date - 30, start_date) FROM gbh_ctx),
        pg_catalog.ceil(1073741824::numeric * 999 * 2 / (30 * 24))::bigint,
        'the previous cycle keeps its part of the boundary day'
    );

SELECT
    is(
        (SELECT public.get_org_storage_billable_bytes(other_org_id, start_date, end_date) FROM gbh_ctx),
        pg_catalog.ceil(1073741824::numeric * 999 * 2 / 240)::bigint,
        'another org using the same app ID is billed its own rows'
    );

SELECT
    is(
        (SELECT public.get_org_storage_billable_bytes(org_id, DATE '2020-01-01', DATE '2020-02-01') FROM gbh_ctx),
        0::bigint,
        'a period without byte-hours bills no storage'
    );

SELECT
    is(
        (SELECT (public.calculate_org_metrics_cache_entry(org_id, start_date, end_date)).storage FROM gbh_ctx),
        1610612736::bigint,
        'org billing metrics read storage from GB-hours'
    );

-- The bytes stored right now are not billed: a huge live bundle changes nothing.
INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
SELECT live_app, '1.0.0', org_id, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid, 'r2' FROM gbh_ctx;
INSERT INTO public.app_versions_meta (id, app_id, checksum, size)
SELECT av.id, av.app_id, 'gbhours', 1099511627776
FROM public.app_versions av, gbh_ctx
WHERE av.app_id = gbh_ctx.live_app AND av.name = '1.0.0';

SELECT
    is(
        (SELECT storage FROM public.get_total_metrics((SELECT org_id FROM gbh_ctx), (SELECT start_date FROM gbh_ctx), (SELECT end_date FROM gbh_ctx))),
        1610612736::bigint,
        'get_total_metrics ignores the bytes stored right now'
    );

-- Deleting an app keeps the hours it already used in the cycle.
INSERT INTO public.deleted_apps (app_id, owner_org)
SELECT deleted_app, org_id FROM gbh_ctx;
DELETE FROM public.apps WHERE app_id = (SELECT deleted_app FROM gbh_ctx);

SELECT
    is(
        (SELECT count(*)::integer FROM public.daily_storage_hourly WHERE app_id = (SELECT deleted_app FROM gbh_ctx)),
        1,
        'deleting an app keeps its storage byte-hours'
    );

SELECT
    is(
        (SELECT storage FROM public.get_total_metrics((SELECT org_id FROM gbh_ctx), (SELECT start_date FROM gbh_ctx), (SELECT end_date FROM gbh_ctx))),
        1610612736::bigint,
        'byte-hours of a deleted app stay billed'
    );

-- get_app_metrics().storage is the byte-hours of each app and day.
SELECT
    is(
        (
            SELECT m.storage
            FROM pg_catalog.jsonb_to_recordset(
                (SELECT (public.seed_get_app_metrics_caches(org_id, start_date, end_date)).response FROM gbh_ctx)
            ) AS m (app_id character varying, date date, storage bigint)
            WHERE m.app_id = (SELECT live_app FROM gbh_ctx) AND m.date = (SELECT start_date + 5 FROM gbh_ctx)
        ),
        (1073741824::bigint * 140),
        'per-app daily metrics return the byte-hours of the day'
    );

SELECT
    is(
        (
            SELECT sum(m.storage)::bigint
            FROM pg_catalog.jsonb_to_recordset(
                (SELECT (public.seed_get_app_metrics_caches(org_id, start_date, end_date)).response FROM gbh_ctx)
            ) AS m (app_id character varying, date date, storage bigint)
        ),
        (1073741824::bigint * 240 + 536870912::bigint * 240 + 1073741824::bigint * 999 * 2),
        'per-app daily metrics keep deleted apps, add both cycles of boundary days, skip other orgs and out of range days'
    );

-- delete_old_deleted_apps purges the hours with the deleted_apps row.
UPDATE public.deleted_apps
SET deleted_at = now() - interval '36 days'
WHERE app_id = (SELECT deleted_app FROM gbh_ctx);
SELECT public.delete_old_deleted_apps();

SELECT
    is(
        (SELECT count(*)::integer FROM public.daily_storage_hourly WHERE app_id = (SELECT deleted_app FROM gbh_ctx)),
        0,
        'delete_old_deleted_apps purges the byte-hours of apps deleted over 35 days ago'
    );

SELECT
    is(
        (SELECT count(*)::integer FROM public.daily_storage_hourly WHERE app_id = (SELECT live_app FROM gbh_ctx) AND owner_org = (SELECT org_id FROM gbh_ctx)),
        6,
        'delete_old_deleted_apps keeps the byte-hours of live apps'
    );

-- replace_app_storage_hourly: two refreshes finishing out of order.
CREATE TEMP TABLE replace_ctx AS
SELECT
    'com.test.gbhours.replace'::varchar AS app_id,
    org_id,
    other_org_id,
    DATE '2026-03-01' AS cycle_start,
    DATE '2026-04-01' AS cycle_end
FROM gbh_ctx;

-- Rows of another org and of the previous cycle on the boundary day must survive.
INSERT INTO public.daily_storage_hourly (app_id, owner_org, cycle_start, date, storage_byte_hours, updated_at)
SELECT app_id, other_org_id, cycle_start, cycle_start, 7, '2026-03-01T00:00:00Z'::timestamptz FROM replace_ctx
UNION ALL
SELECT app_id, org_id, cycle_start - 28, cycle_start, 9, '2026-03-01T00:00:00Z'::timestamptz FROM replace_ctx;

-- The newer refresh (started 10:00) finishes first: two days.
SELECT public.replace_app_storage_hourly(
    app_id, org_id, cycle_start, cycle_end, cycle_end, '2026-03-01T00:00:00Z',
    '[{"cycle_start": "2026-03-01", "date": "2026-03-01", "storage_byte_hours": 240}, {"cycle_start": "2026-03-01", "date": "2026-03-02", "storage_byte_hours": 100}]'::jsonb,
    '2026-03-02T10:00:00Z',
    false
) FROM replace_ctx;

-- The older refresh (started 09:00) finishes later with a stale first day only.
SELECT public.replace_app_storage_hourly(
    app_id, org_id, cycle_start, cycle_end, cycle_end, '2026-03-01T00:00:00Z',
    '[{"cycle_start": "2026-03-01", "date": "2026-03-01", "storage_byte_hours": 1}]'::jsonb,
    '2026-03-02T09:00:00Z',
    false
) FROM replace_ctx;

SELECT
    is(
        (
            SELECT array_agg(storage_byte_hours ORDER BY date)
            FROM public.daily_storage_hourly
            WHERE app_id = (SELECT app_id FROM replace_ctx)
              AND owner_org = (SELECT org_id FROM replace_ctx)
              AND cycle_start = (SELECT cycle_start FROM replace_ctx)
        ),
        ARRAY[240, 100]::double precision[],
        'a refresh that started earlier never overwrites or deletes rows of a later one'
    );

SELECT
    is(
        (
            SELECT array_agg(storage_byte_hours ORDER BY owner_org = (SELECT org_id FROM replace_ctx))
            FROM public.daily_storage_hourly
            WHERE app_id = (SELECT app_id FROM replace_ctx)
              AND (owner_org <> (SELECT org_id FROM replace_ctx) OR cycle_start <> (SELECT cycle_start FROM replace_ctx))
        ),
        ARRAY[7, 9]::double precision[],
        'a refresh keeps other orgs and the previous cycle part of the boundary day'
    );

-- A later refresh replaces the cycle and drops a day it no longer has.
SELECT public.replace_app_storage_hourly(
    app_id, org_id, cycle_start, cycle_end, cycle_end, '2026-03-01T00:00:00Z',
    '[{"cycle_start": "2026-03-01", "date": "2026-03-01", "storage_byte_hours": 120}]'::jsonb,
    '2026-03-02T11:00:00Z',
    false
) FROM replace_ctx;

SELECT
    is(
        (
            SELECT array_agg(storage_byte_hours ORDER BY date)
            FROM public.daily_storage_hourly
            WHERE app_id = (SELECT app_id FROM replace_ctx)
              AND owner_org = (SELECT org_id FROM replace_ctx)
              AND cycle_start = (SELECT cycle_start FROM replace_ctx)
        ),
        ARRAY[120]::double precision[],
        'a newer refresh replaces the cycle rows of its org'
    );

-- A refresh that started before the 11:00 one (which dropped March 2) finishes
-- last with March 2: the removed day is not re-inserted.
SELECT public.replace_app_storage_hourly(
    app_id, org_id, cycle_start, cycle_end, cycle_end, '2026-03-01T00:00:00Z',
    '[{"cycle_start": "2026-03-01", "date": "2026-03-01", "storage_byte_hours": 5}, {"cycle_start": "2026-03-01", "date": "2026-03-02", "storage_byte_hours": 5}]'::jsonb,
    '2026-03-02T10:30:00Z',
    false
) FROM replace_ctx;

SELECT
    is(
        (
            SELECT array_agg(storage_byte_hours ORDER BY date)
            FROM public.daily_storage_hourly
            WHERE app_id = (SELECT app_id FROM replace_ctx)
              AND owner_org = (SELECT org_id FROM replace_ctx)
              AND cycle_start = (SELECT cycle_start FROM replace_ctx)
        ),
        ARRAY[120]::double precision[],
        'an older refresh never re-inserts a day a newer refresh removed'
    );

-- The anchor time moves within the cycle's first day: the segment (when the
-- owner got the app) does not change, so the newer refresh replaces the row in
-- either direction, and a late refresh under the old anchor is refused.
SELECT public.replace_app_storage_hourly(
    'com.test.gbhours.anchor', org_id, cycle_start, cycle_end, cycle_end, '2026-01-15T00:00:00Z',
    '[{"cycle_start": "2026-03-01", "date": "2026-03-01", "storage_byte_hours": 12}]'::jsonb,
    '2026-03-02T08:00:00Z',
    false
) FROM replace_ctx;
SELECT public.replace_app_storage_hourly(
    'com.test.gbhours.anchor', org_id, cycle_start, cycle_end, cycle_end, '2026-01-15T00:00:00Z',
    '[{"cycle_start": "2026-03-01", "date": "2026-03-01", "storage_byte_hours": 24}]'::jsonb,
    '2026-03-02T11:00:00Z',
    false
) FROM replace_ctx;
SELECT public.replace_app_storage_hourly(
    'com.test.gbhours.anchor', org_id, cycle_start, cycle_end, cycle_end, '2026-01-15T00:00:00Z',
    '[{"cycle_start": "2026-03-01", "date": "2026-03-01", "storage_byte_hours": 12}]'::jsonb,
    '2026-03-02T10:00:00Z',
    false
) FROM replace_ctx;

SELECT
    is(
        (SELECT array_agg(storage_byte_hours) FROM public.daily_storage_hourly WHERE app_id = 'com.test.gbhours.anchor'),
        ARRAY[24]::double precision[],
        'a moved anchor keeps one row per segment and day, and a late refresh is refused'
    );

-- A live refresh writes nothing for an org that no longer owns the app (it
-- read the owner before a transfer): the new owner finalizes it instead.
SELECT public.replace_app_storage_hourly(
    live_app, other_org_id, DATE '2026-05-01', DATE '2026-06-01', DATE '2026-06-01', '2026-05-01T00:00:00Z',
    '[{"cycle_start": "2026-05-01", "date": "2026-05-02", "storage_byte_hours": 77}]'::jsonb,
    '2026-05-03T00:00:00Z'
) FROM gbh_ctx;
SELECT public.replace_app_storage_hourly(
    live_app, org_id, DATE '2026-05-01', DATE '2026-06-01', DATE '2026-06-01', '2026-05-01T00:00:00Z',
    '[{"cycle_start": "2026-05-01", "date": "2026-05-02", "storage_byte_hours": 88}]'::jsonb,
    '2026-05-03T00:00:00Z'
) FROM gbh_ctx;

-- A live refresh that loaded another incarnation of the app (deleted and
-- recreated by the same org mid-refresh) writes nothing either.
SELECT public.replace_app_storage_hourly(
    live_app, org_id, DATE '2026-04-01', DATE '2026-05-01', DATE '2026-05-01', '2026-04-01T00:00:00Z',
    '[{"cycle_start": "2026-04-01", "date": "2026-04-02", "storage_byte_hours": 66}]'::jsonb,
    '2026-04-03T00:00:00Z',
    true,
    gen_random_uuid()
) FROM gbh_ctx;

SELECT
    is(
        (SELECT count(*)::integer FROM public.daily_storage_hourly
         WHERE app_id = (SELECT live_app FROM gbh_ctx) AND cycle_start = DATE '2026-04-01'),
        0,
        'a live refresh of an earlier incarnation of the app writes nothing'
    );

SELECT
    is(
        (SELECT count(*)::integer FROM public.daily_storage_hourly
         WHERE app_id = (SELECT live_app FROM gbh_ctx) AND owner_org = (SELECT other_org_id FROM gbh_ctx) AND cycle_start = DATE '2026-05-01'),
        0,
        'a live refresh writes nothing once its org no longer owns the app'
    );

SELECT
    is(
        (SELECT storage_byte_hours FROM public.daily_storage_hourly
         WHERE app_id = (SELECT live_app FROM gbh_ctx) AND owner_org = (SELECT org_id FROM gbh_ctx) AND cycle_start = DATE '2026-05-01'),
        88::double precision,
        'a live refresh of the current owner writes its rows'
    );

-- A legacy row (written before the migration) of an app created mid-cycle is
-- replaced by the app's segment, not billed twice.
INSERT INTO public.daily_storage_hourly (app_id, owner_org, cycle_start, date, storage_byte_hours, updated_at)
SELECT 'com.test.gbhours.legacy', org_id, cycle_start + 3, cycle_start + 3, 50, '2026-03-04T00:00:00Z'::timestamptz FROM replace_ctx;
SELECT public.replace_app_storage_hourly(
    'com.test.gbhours.legacy', org_id, cycle_start, cycle_end, cycle_end, '2026-03-04T08:00:00Z',
    '[{"cycle_start": "2026-03-01", "date": "2026-03-04", "storage_byte_hours": 40}]'::jsonb,
    '2026-03-05T00:00:00Z',
    false
) FROM replace_ctx;

SELECT
    is(
        (SELECT array_agg(storage_byte_hours) FROM public.daily_storage_hourly WHERE app_id = 'com.test.gbhours.legacy'),
        ARRAY[40]::double precision[],
        'a refresh replaces the legacy rows of its cycle'
    );

-- The same org recreates the app ID mid-cycle: the new incarnation accrues in
-- its own segment and never replaces the earlier incarnation's hours.
SELECT public.replace_app_storage_hourly(
    app_id, org_id, cycle_start, cycle_end, cycle_end, '2026-03-02T06:00:00Z',
    '[{"cycle_start": "2026-03-01", "date": "2026-03-02", "storage_byte_hours": 18}]'::jsonb,
    '2026-03-02T12:00:00Z',
    false
) FROM replace_ctx;

SELECT
    is(
        (
            SELECT array_agg(storage_byte_hours ORDER BY date, segment_start)
            FROM public.daily_storage_hourly
            WHERE app_id = (SELECT app_id FROM replace_ctx)
              AND owner_org = (SELECT org_id FROM replace_ctx)
              AND cycle_start = (SELECT cycle_start FROM replace_ctx)
        ),
        ARRAY[120, 18]::double precision[],
        'a recreated app ID keeps the earlier incarnation''s hours of the cycle'
    );

SELECT
    ok(
        NOT has_function_privilege('authenticated', 'public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, jsonb, timestamptz, boolean, uuid)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, jsonb, timestamptz, boolean, uuid)', 'EXECUTE'),
        'replace_app_storage_hourly is not callable by clients'
    );

-- get_org_storage_usage: the console's cycle GB-hours, as billed.
CREATE TEMP TABLE usage_ctx AS
SELECT
    org_id,
    (cycle.cycle_start AT TIME ZONE 'UTC')::date AS cycle_start,
    (cycle.cycle_end AT TIME ZONE 'UTC')::date AS cycle_end
FROM gbh_ctx, public.get_org_billing_cycle(gbh_ctx.org_id) AS cycle;

INSERT INTO public.daily_storage_hourly (app_id, owner_org, cycle_start, date, storage_byte_hours)
SELECT 'com.test.gbhours.usage', org_id, cycle_start, cycle_start, 4800 FROM usage_ctx
UNION ALL
-- The previous cycle's part of the first day is not this cycle's usage.
SELECT 'com.test.gbhours.usage', org_id, cycle_start - 30, cycle_start, 999999 FROM usage_ctx;

SELECT
    is(
        (SELECT ARRAY[storage_byte_hours, cycle_hours] FROM public.get_org_storage_usage((SELECT org_id FROM usage_ctx))),
        (SELECT ARRAY[4800, (cycle_end - cycle_start) * 24]::double precision[] FROM usage_ctx),
        'get_org_storage_usage returns the cycle byte-hours and hours billing uses'
    );

-- Right after a non-midnight rollover, before the new cycle has storage, only
-- the previous cycle's part of the boundary day exists: the cycle uses nothing.
DELETE FROM public.daily_storage_hourly
WHERE app_id = 'com.test.gbhours.usage'
  AND cycle_start = (SELECT cycle_start FROM usage_ctx);

SELECT
    is(
        (SELECT storage_byte_hours FROM public.get_org_storage_usage((SELECT org_id FROM usage_ctx))),
        0::double precision,
        'get_org_storage_usage is zero when only the previous cycle has hours on the boundary day'
    );

SELECT
    ok(
        has_function_privilege('authenticated', 'public.get_org_storage_usage(uuid)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.get_org_storage_usage(uuid)', 'EXECUTE'),
        'get_org_storage_usage is callable by signed-in users only'
    );

SELECT set_config('test.gbh_org_id', (SELECT org_id::text FROM gbh_ctx), true);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub": "00000000-0000-4000-8000-0000000000aa", "role": "authenticated"}', true);
SELECT
    is(
        (SELECT count(*)::integer FROM public.get_org_storage_usage(current_setting('test.gbh_org_id')::uuid)),
        0,
        'get_org_storage_usage returns nothing without billing read access'
    );
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

-- stats_jobs keeps refreshing an app that only stores bundles, for billable orgs.
UPDATE public.orgs SET has_usage_credits = true WHERE id = (SELECT org_id FROM gbh_ctx);
UPDATE public.app_versions
SET created_at = now() - interval '90 days'
WHERE app_id = (SELECT live_app FROM gbh_ctx);
DELETE FROM pgmq.q_cron_stat_app WHERE message->'payload'->>'appId' = (SELECT live_app FROM gbh_ctx);
DELETE FROM public.app_stats_refresh_state WHERE app_id = (SELECT live_app FROM gbh_ctx);
SELECT public.process_cron_stats_jobs();

SELECT
    ok(
        EXISTS (
            SELECT 1 FROM pgmq.q_cron_stat_app
            WHERE message->'payload'->>'appId' = (SELECT live_app FROM gbh_ctx)
        ),
        'stats_jobs queues an app that stores bundles without other activity'
    );

-- Deleting an app closes its open bundle lifetimes, so a recreated app ID is
-- not billed for them; an already closed lifetime is left as is.
INSERT INTO public.apps (app_id, icon_url, name, owner_org, user_id)
SELECT 'com.test.gbhours.close', '', 'GB hours close', org_id, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid FROM gbh_ctx;
INSERT INTO public.version_meta (timestamp, app_id, version_id, size) VALUES
('2026-01-01 00:00:00', 'com.test.gbhours.close', 9100001, 500),
('2026-01-01 00:00:00', 'com.test.gbhours.close', 9100002, 700),
('2026-01-02 00:00:00', 'com.test.gbhours.close', 9100002, -700);
DELETE FROM public.apps WHERE app_id = 'com.test.gbhours.close';

SELECT
    is(
        (SELECT array_agg(size ORDER BY version_id) FROM public.version_meta WHERE app_id = 'com.test.gbhours.close' AND size < 0),
        ARRAY[-500, -700]::bigint[],
        'deleting an app closes its open bundle lifetimes'
    );

SELECT
    ok(
        (SELECT timestamp FROM public.version_meta WHERE app_id = 'com.test.gbhours.close' AND version_id = 9100001 AND size < 0)
        > TIMESTAMP '2026-01-02 00:00:00',
        'the lifetime closes at the deletion time'
    );

-- Hard-deleting one bundle closes its lifetime too.
INSERT INTO public.app_versions (id, app_id, name, owner_org, user_id, storage_provider)
SELECT 9100101, live_app, '9.9.9', org_id, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid, 'r2' FROM gbh_ctx;
INSERT INTO public.version_meta (timestamp, app_id, version_id, size)
SELECT '2026-01-03 00:00:00', live_app, 9100101, 321 FROM gbh_ctx;
DELETE FROM public.app_versions WHERE id = 9100101;

SELECT
    is(
        (SELECT size FROM public.version_meta WHERE version_id = 9100101 AND size < 0),
        -321::bigint,
        'hard-deleting a bundle closes its storage lifetime'
    );

-- stats_jobs refreshes an idle app once more after its last bundle is removed.
INSERT INTO public.apps (app_id, icon_url, name, owner_org, user_id)
SELECT 'com.test.gbhours.lastbundle', '', 'GB hours last bundle', org_id, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid FROM gbh_ctx;
-- The removal (1 day ago) happened while the last refresh was running: after
-- its storage cutoff (watermark, 2 days ago) but before it completed
-- (stats_updated_at, 21 hours ago). It must still be refreshed once more.
INSERT INTO public.app_stats_refresh_state (app_id, owner_org, stats_updated_at)
SELECT 'com.test.gbhours.lastbundle', org_id, pg_catalog.timezone('UTC', now()) - interval '21 hours' FROM gbh_ctx
ON CONFLICT (app_id) DO UPDATE SET stats_updated_at = EXCLUDED.stats_updated_at, stats_refresh_requested_at = NULL;
INSERT INTO public.daily_storage_hourly_refreshes (app_id, owner_org, cycle_start, segment_start, written_at)
SELECT 'com.test.gbhours.lastbundle', org_id, CURRENT_DATE - 10, '-infinity', now() - interval '2 days' FROM gbh_ctx;
INSERT INTO public.version_meta (timestamp, app_id, version_id, size) VALUES
(pg_catalog.timezone('UTC', now()) - interval '40 days', 'com.test.gbhours.lastbundle', 9100201, 100),
(pg_catalog.timezone('UTC', now()) - interval '1 day', 'com.test.gbhours.lastbundle', 9100201, -100);
DELETE FROM pgmq.q_cron_stat_app WHERE message->'payload'->>'appId' = 'com.test.gbhours.lastbundle';
SELECT public.process_cron_stats_jobs();

SELECT
    ok(
        EXISTS (
            SELECT 1 FROM pgmq.q_cron_stat_app
            WHERE message->'payload'->>'appId' = 'com.test.gbhours.lastbundle'
        ),
        'stats_jobs refreshes an idle app after its last bundle was removed'
    );

-- The snapshot pipeline is gone and the helper is internal.
SELECT hasnt_table('public', 'daily_storage', 'daily_storage is dropped');

SELECT
    ok(
        to_regprocedure('public.read_storage_usage(character varying, timestamp without time zone, timestamp without time zone)') IS NULL,
        'read_storage_usage is dropped'
    );

SELECT
    ok(
        NOT has_function_privilege('authenticated', 'public.get_org_storage_billable_bytes(uuid, date, date)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.get_org_storage_billable_bytes(uuid, date, date)', 'EXECUTE'),
        'get_org_storage_billable_bytes is not callable by clients'
    );

SELECT * FROM finish();

ROLLBACK;
