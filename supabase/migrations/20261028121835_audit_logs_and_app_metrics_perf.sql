-- 1. audit_logs_allowed_orgs() feeds the audit_logs SELECT RLS. It ran
--    rbac_check_permission_request() against every row of public.orgs, and being
--    VOLATILE it was evaluated again for each audit_logs reference, so the console
--    audit log page (count + page) took over 4 seconds in production.
--    An org-level permission can only come from an org-scope role binding (direct,
--    or through a group of that org for users), and rbac_org_ids_for_permission()
--    runs the same rbac_check_permission_direct() check over exactly those
--    candidate orgs, for JWT users and API keys alike.

CREATE OR REPLACE FUNCTION public.audit_logs_allowed_orgs()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT public.rbac_org_ids_for_permission(public.rbac_perm_org_read_audit())
$$;

-- 2. seed_get_app_metrics_caches() rebuilds the per-org get_app_metrics cache.
--    generate_series() is estimated at 1000 rows, so the planner expected 500k
--    app x day rows and merge-joined whole daily_* index ranges with no date
--    filter (190k daily_version and 126k daily_mau rows for a 500-app org, about
--    750 ms per cache miss). Each daily table is now filtered to the org apps and
--    the requested range before the join, and daily_version is summed per
--    app/day first. daily_mau, daily_storage, daily_bandwidth and daily_build_time
--    are unique on (app_id, date), so the output is unchanged. The unused
--    deleted_metrics join only added a grouping key that was constant per
--    app/day, so it is dropped.

CREATE OR REPLACE FUNCTION public.seed_get_app_metrics_caches(p_org_id uuid, p_start_date date, p_end_date date)
RETURNS public.app_metrics_cache
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    metrics_json jsonb;
    cache_record public.app_metrics_cache%ROWTYPE;
BEGIN
    WITH DateSeries AS (
        SELECT generate_series(p_start_date, p_end_date, '1 day'::interval)::date AS date
    ),
    all_apps AS MATERIALIZED (
        SELECT apps.app_id, apps.owner_org
        FROM public.apps
        WHERE apps.owner_org = p_org_id
        UNION
        SELECT deleted_apps.app_id, deleted_apps.owner_org
        FROM public.deleted_apps
        WHERE deleted_apps.owner_org = p_org_id
    ),
    mau AS (
        SELECT dm.app_id, dm.date, dm.mau
        FROM public.daily_mau dm
        WHERE dm.app_id IN (SELECT all_apps.app_id FROM all_apps)
          AND dm.date BETWEEN p_start_date AND p_end_date
    ),
    storage AS (
        SELECT dst.app_id, dst.date, dst.storage
        FROM public.daily_storage dst
        WHERE dst.app_id IN (SELECT all_apps.app_id FROM all_apps)
          AND dst.date BETWEEN p_start_date AND p_end_date
    ),
    bandwidth AS (
        SELECT db.app_id, db.date, db.bandwidth
        FROM public.daily_bandwidth db
        WHERE db.app_id IN (SELECT all_apps.app_id FROM all_apps)
          AND db.date BETWEEN p_start_date AND p_end_date
    ),
    build_time AS (
        SELECT dbt.app_id, dbt.date, dbt.build_time_unit
        FROM public.daily_build_time dbt
        WHERE dbt.app_id IN (SELECT all_apps.app_id FROM all_apps)
          AND dbt.date BETWEEN p_start_date AND p_end_date
    ),
    versions AS (
        SELECT
            dv.app_id,
            dv.date,
            SUM(dv.get)::bigint AS get,
            SUM(dv.fail)::bigint AS fail,
            SUM(dv.install)::bigint AS install,
            SUM(dv.uninstall)::bigint AS uninstall
        FROM public.daily_version dv
        WHERE dv.app_id IN (SELECT all_apps.app_id FROM all_apps)
          AND dv.date BETWEEN p_start_date AND p_end_date
        GROUP BY dv.app_id, dv.date
    ),
    metrics AS (
        SELECT
            aa.app_id,
            ds.date::date,
            COALESCE(dm.mau, 0) AS mau,
            COALESCE(dst.storage, 0) AS storage,
            COALESCE(db.bandwidth, 0) AS bandwidth,
            COALESCE(dbt.build_time_unit, 0) AS build_time_unit,
            COALESCE(dv.get, 0) AS get,
            COALESCE(dv.fail, 0) AS fail,
            COALESCE(dv.install, 0) AS install,
            COALESCE(dv.uninstall, 0) AS uninstall
        FROM
            all_apps aa
        CROSS JOIN
            DateSeries ds
        LEFT JOIN
            mau dm ON aa.app_id = dm.app_id AND ds.date = dm.date
        LEFT JOIN
            storage dst ON aa.app_id = dst.app_id AND ds.date = dst.date
        LEFT JOIN
            bandwidth db ON aa.app_id = db.app_id AND ds.date = db.date
        LEFT JOIN
            build_time dbt ON aa.app_id = dbt.app_id AND ds.date = dbt.date
        LEFT JOIN
            versions dv ON aa.app_id = dv.app_id AND ds.date = dv.date
    )
    SELECT COALESCE(
        jsonb_agg(row_to_json(metrics) ORDER BY metrics.app_id, metrics.date),
        '[]'::jsonb
    )
    INTO metrics_json
    FROM metrics;

    INSERT INTO public.app_metrics_cache (org_id, start_date, end_date, response, cached_at)
    VALUES (p_org_id, p_start_date, p_end_date, metrics_json, clock_timestamp())
    ON CONFLICT (org_id) DO UPDATE
        SET start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            response = EXCLUDED.response,
            cached_at = EXCLUDED.cached_at
    RETURNING * INTO cache_record;

    RETURN cache_record;
END;
$$;
