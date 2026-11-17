BEGIN;

SELECT plan(16);

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
