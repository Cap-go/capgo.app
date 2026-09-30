BEGIN;

SELECT plan(9);

-- Seeded demo org and user.
CREATE TEMP TABLE deleted_build_ctx (
    baseline_build_time bigint
) ON COMMIT DROP;

INSERT INTO deleted_build_ctx (baseline_build_time)
SELECT metrics.build_time_unit AS baseline_build_time
FROM public.calculate_org_metrics_cache_entry(
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
    current_date,
    current_date
) AS metrics;

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
    ok(
        (
            SELECT bt.total_build_time_unit
            FROM public.get_org_build_time_unit(
                '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
                current_date,
                current_date
            ) AS bt
        ) >= 600,
        'get_org_build_time_unit includes deleted apps'
    );

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
            FROM public.deleted_apps AS da
            WHERE da.app_id = 'com.test.deleted.buildtime'
        ),
        'delete_old_deleted_apps purges the deleted_apps row'
    );

SELECT *
FROM
    finish();

ROLLBACK;
