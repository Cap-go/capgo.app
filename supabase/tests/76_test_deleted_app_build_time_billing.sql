BEGIN;

SELECT plan(14);

-- Seeded demo org and user.
CREATE TEMP TABLE deleted_build_ctx (
    baseline_build_time bigint,
    baseline_org_build_time_unit bigint
) ON COMMIT DROP;

INSERT INTO deleted_build_ctx (
    baseline_build_time, baseline_org_build_time_unit
)
SELECT
    (
        SELECT metrics.build_time_unit
        FROM public.calculate_org_metrics_cache_entry(
            '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
            current_date,
            current_date
        ) AS metrics
    ) AS baseline_build_time,
    (
        SELECT bt.total_build_time_unit
        FROM public.get_org_build_time_unit(
            '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
            current_date,
            current_date
        ) AS bt
    ) AS baseline_org_build_time_unit;

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'daily_build_time_app_id_fkey'
        ),
        'daily_build_time has no FK to apps, like daily_mau and daily_bandwidth'
    );

INSERT INTO public.apps (owner_org, app_id, icon_url, name, user_id)
VALUES (
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.deleted.buildtime',
    '',
    'Deleted Build Time App',
    '6aa76066-55ef-4238-ade6-0b32334a4097'
);

INSERT INTO public.build_logs (
    org_id,
    user_id,
    build_id,
    platform,
    billable_seconds,
    build_time_unit,
    app_id
)
VALUES (
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    'deleted-app-build-1',
    'ios',
    600,
    600,
    'com.test.deleted.buildtime'
);

SELECT
    is(
        (
            SELECT metrics.build_time_unit
            FROM public.calculate_org_metrics_cache_entry(
                '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
                current_date,
                current_date
            ) AS metrics
        ),
        (SELECT ctx.baseline_build_time + 600 FROM deleted_build_ctx AS ctx),
        'build time of a live app is counted in the org cycle total'
    );

-- Delete the app, then record it like the on_app_delete trigger does.
DELETE FROM public.apps
WHERE app_id = 'com.test.deleted.buildtime';

INSERT INTO public.deleted_apps (app_id, owner_org)
VALUES (
    'com.test.deleted.buildtime',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
);

SELECT
    is(
        (
            SELECT bl.app_id
            FROM public.build_logs AS bl
            WHERE bl.build_id = 'deleted-app-build-1'
        ),
        NULL,
        'build_logs.app_id is detached (SET NULL) when the app is deleted'
    );

SELECT
    is(
        (
            SELECT dbt.build_time_unit
            FROM public.daily_build_time AS dbt
            WHERE
                dbt.app_id = 'com.test.deleted.buildtime'
                AND dbt.date = (now() AT TIME ZONE 'UTC')::date
        ),
        600::bigint,
        'daily_build_time row survives app deletion with its build seconds'
    );

SELECT
    is(
        (
            SELECT metrics.build_time_unit
            FROM public.calculate_org_metrics_cache_entry(
                '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
                current_date,
                current_date
            ) AS metrics
        ),
        (SELECT ctx.baseline_build_time + 600 FROM deleted_build_ctx AS ctx),
        'build time of a deleted app is still counted in the org cycle total'
    );

SELECT
    is(
        (
            SELECT bt.total_build_time_unit
            FROM public.get_org_build_time_unit(
                '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
                current_date,
                current_date
            ) AS bt
        ),
        (
            SELECT ctx.baseline_org_build_time_unit + 600
            FROM deleted_build_ctx AS ctx
        ),
        'get_org_build_time_unit includes deleted apps'
    );

-- MAU and bandwidth of the deleted app, purged with build time after retention.
INSERT INTO public.daily_mau (app_id, date, mau)
VALUES ('com.test.deleted.buildtime', current_date, 10);

INSERT INTO public.daily_bandwidth (app_id, date, bandwidth)
VALUES ('com.test.deleted.buildtime', current_date, 1024);

-- Keep case 1: an expired tombstone whose app_id is live again.
INSERT INTO public.apps (owner_org, app_id, icon_url, name, user_id)
VALUES (
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    'com.test.deleted.relive',
    '',
    'Recreated App',
    '6aa76066-55ef-4238-ade6-0b32334a4097'
);

INSERT INTO public.deleted_apps (app_id, owner_org, deleted_at)
VALUES (
    'com.test.deleted.relive',
    '34a8c55d-2d0f-4652-a43f-684c7a9403ac',
    now() - interval '36 days'
);

-- Keep case 2: an expired tombstone plus a recent one for the same app_id.
INSERT INTO public.deleted_apps (app_id, owner_org, deleted_at)
VALUES
(
    'com.test.deleted.twice',
    '34a8c55d-2d0f-4652-a43f-684c7a9403ac',
    now() - interval '36 days'
),
(
    'com.test.deleted.twice',
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now()
);

INSERT INTO public.daily_build_time (app_id, date, build_time_unit, build_count)
VALUES
('com.test.deleted.relive', current_date, 120, 1),
('com.test.deleted.twice', current_date, 120, 1);

INSERT INTO public.daily_mau (app_id, date, mau)
VALUES
('com.test.deleted.relive', current_date, 5),
('com.test.deleted.twice', current_date, 5);

INSERT INTO public.daily_bandwidth (app_id, date, bandwidth)
VALUES
('com.test.deleted.relive', current_date, 512),
('com.test.deleted.twice', current_date, 512);

-- Inside the 35-day retention window the cleanup keeps the usage rows.
SELECT public.delete_old_deleted_apps();

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM public.daily_build_time AS dbt
            WHERE dbt.app_id = 'com.test.deleted.buildtime'
        ),
        'delete_old_deleted_apps keeps build time inside the retention window'
    );

UPDATE public.deleted_apps
SET deleted_at = now() - interval '36 days'
WHERE app_id = 'com.test.deleted.buildtime';

SELECT public.delete_old_deleted_apps();

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM public.daily_build_time AS dbt
            WHERE dbt.app_id = 'com.test.deleted.buildtime'
        ),
        'delete_old_deleted_apps purges build time after the retention window'
    );

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM public.daily_mau AS dm
            WHERE dm.app_id = 'com.test.deleted.buildtime'
        )
        AND NOT EXISTS (
            SELECT 1
            FROM public.daily_bandwidth AS db
            WHERE db.app_id = 'com.test.deleted.buildtime'
        ),
        'delete_old_deleted_apps purges MAU and bandwidth after retention'
    );

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM public.deleted_apps AS da
            WHERE
                da.app_id = 'com.test.deleted.relive'
        ),
        'delete_old_deleted_apps purges the expired tombstone of a live app'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM (
                SELECT dbt.app_id FROM public.daily_build_time AS dbt
                UNION ALL
                SELECT dm.app_id FROM public.daily_mau AS dm
                UNION ALL
                SELECT db.app_id FROM public.daily_bandwidth AS db
            ) AS usage_rows
            WHERE usage_rows.app_id = 'com.test.deleted.relive'
        ),
        3::bigint,
        'delete_old_deleted_apps keeps usage of an app_id that is live again'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM public.deleted_apps AS da
            WHERE da.app_id = 'com.test.deleted.twice'
        ),
        1::bigint,
        'delete_old_deleted_apps purges only the expired tombstone'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM (
                SELECT dbt.app_id FROM public.daily_build_time AS dbt
                UNION ALL
                SELECT dm.app_id FROM public.daily_mau AS dm
                UNION ALL
                SELECT db.app_id FROM public.daily_bandwidth AS db
            ) AS usage_rows
            WHERE usage_rows.app_id = 'com.test.deleted.twice'
        ),
        3::bigint,
        'delete_old_deleted_apps keeps usage kept by a recent tombstone'
    );

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM public.deleted_apps AS da
            WHERE da.app_id = 'com.test.deleted.buildtime'
        ),
        'delete_old_deleted_apps purges the deleted_apps row'
    );

SELECT *
FROM
    finish();

ROLLBACK;
