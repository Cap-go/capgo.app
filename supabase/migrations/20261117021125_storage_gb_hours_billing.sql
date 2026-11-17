-- Storage is billed in GB-hours only.
--
-- Before: billing compared the bytes stored right now (sum of live bundle
-- sizes) with the plan storage. Deleting bundles just before the usage check
-- dropped the bill to zero, and daily_storage kept a separate per-day delta
-- series for the charts. daily_storage_hourly (byte-hours per app and UTC day,
-- written by cron_stat_app from version_meta) was a shadow metric.
--
-- After: daily_storage_hourly is the only storage source.
--   billable storage (bytes) = byte-hours used in the period / hours in the period
-- That is the average stored over the period, so a plan with S GB includes
-- S x hours-in-cycle GB-hours. The plan storage columns, the credit price tiers
-- and every caller comparing get_total_metrics().storage with plans.storage keep
-- their units (bytes), only the source changes. Byte-hours only grow during a
-- cycle, so the billable value never goes down mid cycle and overage debits
-- stay monotonic.

-- ---------------------------------------------------------------------------
-- 1. Byte-hours of deleted apps stay billable until delete_old_deleted_apps
-- ---------------------------------------------------------------------------
-- Same reason as daily_build_time in 20260930094441: an ON DELETE CASCADE to
-- apps would wipe the hours already used in the cycle when the app is deleted.
ALTER TABLE public.daily_storage_hourly
DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey;

COMMENT ON TABLE public.daily_storage_hourly IS
'Storage usage in byte-hours per app and UTC day (GB-hours x 2^30), written by '
'cron_stat_app from version_meta. Only source of storage billing: see '
'get_org_storage_billable_bytes. Rows of deleted apps are kept until '
'delete_old_deleted_apps purges them.';

-- ---------------------------------------------------------------------------
-- 2. Billable storage of an org for a period
-- ---------------------------------------------------------------------------
-- Callers pass the period as dates, like every other get_total_metrics metric
-- (rows are read with an inclusive BETWEEN). The hours divide the byte-hours:
-- by default (end_date - start_date) x 24, which is exact for the billing cycle
-- get_total_metrics(org) passes (cycle_start::date, cycle_end::date): both
-- anchors share the time of day. Callers that pass an inclusive end date
-- (cron_email: end - 1 day) give the exact cycle hours in p_hours. Rows are
-- filtered on owner_org: cron_stat_app writes the org that owned the app when
-- the hours were used, and keeps it for deleted apps.
CREATE OR REPLACE FUNCTION public.get_org_storage_billable_bytes(
    p_org_id uuid, p_start_date date, p_end_date date, p_hours double precision DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT COALESCE(
    pg_catalog.ceil(
      SUM(dsh.storage_byte_hours)
      / GREATEST(COALESCE(p_hours, (p_end_date - p_start_date) * 24), 24)::double precision
    ),
    0
  )::bigint
  FROM public.daily_storage_hourly dsh
  WHERE dsh.owner_org = p_org_id
    AND dsh.date BETWEEN p_start_date AND p_end_date
$$;

ALTER FUNCTION public.get_org_storage_billable_bytes(uuid, date, date, double precision) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_org_storage_billable_bytes(uuid, date, date, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_org_storage_billable_bytes(uuid, date, date, double precision) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_storage_billable_bytes(uuid, date, date, double precision) TO service_role;

COMMENT ON FUNCTION public.get_org_storage_billable_bytes(uuid, date, date, double precision) IS
'Average bytes stored by the org over the period: byte-hours in '
'daily_storage_hourly between start_date and end_date divided by the hours of '
'the period (p_hours, else (end_date - start_date) x 24, at least 24). This is '
'the storage value compared with plans.storage and priced by the credit tiers.';

-- ---------------------------------------------------------------------------
-- 3. Org billing metrics read storage from byte-hours
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_org_metrics_cache_entry(
    p_org_id uuid, p_start_date date, p_end_date date
)
RETURNS public.org_metrics_cache
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_mau bigint;
    v_storage bigint;
    v_bandwidth bigint;
    v_build_time bigint;
    v_get bigint;
    v_fail bigint;
    v_install bigint;
    v_uninstall bigint;
    cache_record public.org_metrics_cache%ROWTYPE;
BEGIN
    WITH app_ids AS (
        SELECT apps.app_id
        FROM public.apps
        WHERE apps.owner_org = p_org_id
        UNION
        SELECT deleted_apps.app_id
        FROM public.deleted_apps
        WHERE deleted_apps.owner_org = p_org_id
    ),
    mau AS (
        SELECT COALESCE(SUM(dm.mau), 0)::bigint AS value
        FROM public.daily_mau dm
        JOIN app_ids a ON a.app_id = dm.app_id
        WHERE dm.date BETWEEN p_start_date AND p_end_date
    ),
    bandwidth AS (
        SELECT COALESCE(SUM(db.bandwidth), 0)::bigint AS value
        FROM public.daily_bandwidth db
        JOIN app_ids a ON a.app_id = db.app_id
        WHERE db.date BETWEEN p_start_date AND p_end_date
    ),
    build_time AS (
        SELECT COALESCE(SUM(dbt.build_time_unit), 0)::bigint AS value
        FROM public.daily_build_time dbt
        JOIN app_ids a ON a.app_id = dbt.app_id
        WHERE dbt.date BETWEEN p_start_date AND p_end_date
    ),
    version_stats AS (
        SELECT
            COALESCE(SUM(dv.get), 0)::bigint AS get,
            COALESCE(SUM(dv.fail), 0)::bigint AS fail,
            COALESCE(SUM(dv.install), 0)::bigint AS install,
            COALESCE(SUM(dv.uninstall), 0)::bigint AS uninstall
        FROM public.daily_version dv
        JOIN app_ids a ON a.app_id = dv.app_id
        WHERE dv.date BETWEEN p_start_date AND p_end_date
    )
    SELECT
        mau.value,
        public.get_org_storage_billable_bytes(p_org_id, p_start_date, p_end_date),
        bandwidth.value,
        build_time.value,
        version_stats.get,
        version_stats.fail,
        version_stats.install,
        version_stats.uninstall
    INTO v_mau, v_storage, v_bandwidth, v_build_time, v_get, v_fail, v_install, v_uninstall
    FROM mau, bandwidth, build_time, version_stats;

    cache_record.org_id := p_org_id;
    cache_record.start_date := p_start_date;
    cache_record.end_date := p_end_date;
    cache_record.mau := v_mau;
    cache_record.storage := v_storage;
    cache_record.bandwidth := v_bandwidth;
    cache_record.build_time_unit := v_build_time;
    cache_record.get := v_get;
    cache_record.fail := v_fail;
    cache_record.install := v_install;
    cache_record.uninstall := v_uninstall;
    cache_record.cached_at := clock_timestamp();

    RETURN cache_record;
END;
$$;

COMMENT ON FUNCTION public.calculate_org_metrics_cache_entry(
    p_org_id uuid, p_start_date date, p_end_date date
) IS
'Org cycle usage used for billing. Intentionally unions deleted_apps '
'(kept 35 days by delete_old_deleted_apps) with live apps for MAU, '
'bandwidth and build time, and keeps deleted apps in storage byte-hours: '
'deleting and recreating an app, deleting bundles, or reusing an app_id '
'cannot reset usage inside a billing cycle. Storage is the GB-hour average '
'from get_org_storage_billable_bytes. Anti-fraud behavior, do not remove.';

-- get_total_metrics recomputes instead of reading the 5 minute cache when the
-- current transaction already wrote a table the metrics read. Storage now reads
-- daily_storage_hourly, not app_versions / app_versions_meta.
CREATE OR REPLACE FUNCTION public.get_total_metrics(org_id uuid, start_date date, end_date date)
RETURNS TABLE(mau bigint, storage bigint, bandwidth bigint, build_time_unit bigint, get bigint, fail bigint, install bigint, uninstall bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    cache_entry public.org_metrics_cache%ROWTYPE;
    cache_ttl interval := '5 minutes'::interval;
    tx_read_only boolean := COALESCE(current_setting('transaction_read_only', true), 'off') = 'on';
BEGIN
    IF start_date IS NULL OR end_date IS NULL THEN
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.orgs
        WHERE orgs.id = get_total_metrics.org_id
    ) THEN
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_xact_user_tables
        WHERE relname IN (
            'apps',
            'deleted_apps',
            'daily_mau',
            'daily_bandwidth',
            'daily_build_time',
            'daily_version',
            'daily_storage_hourly'
        )
        AND (n_tup_ins > 0 OR n_tup_upd > 0 OR n_tup_del > 0)
    ) THEN
        IF tx_read_only THEN
            RETURN QUERY
            SELECT
                metrics.mau,
                metrics.storage,
                metrics.bandwidth,
                metrics.build_time_unit,
                metrics.get,
                metrics.fail,
                metrics.install,
                metrics.uninstall
            FROM public.calculate_org_metrics_cache_entry(org_id, start_date, end_date) AS metrics;
            RETURN;
        END IF;

        cache_entry := public.seed_org_metrics_cache(get_total_metrics.org_id, start_date, end_date);

        RETURN QUERY SELECT
            cache_entry.mau,
            cache_entry.storage,
            cache_entry.bandwidth,
            cache_entry.build_time_unit,
            cache_entry.get,
            cache_entry.fail,
            cache_entry.install,
            cache_entry.uninstall;
        RETURN;
    END IF;

    SELECT * INTO cache_entry
    FROM public.org_metrics_cache
    WHERE org_metrics_cache.org_id = get_total_metrics.org_id;

    IF FOUND
        AND cache_entry.start_date = start_date
        AND cache_entry.end_date = end_date
        AND cache_entry.cached_at > clock_timestamp() - cache_ttl
    THEN
        RETURN QUERY SELECT
            cache_entry.mau,
            cache_entry.storage,
            cache_entry.bandwidth,
            cache_entry.build_time_unit,
            cache_entry.get,
            cache_entry.fail,
            cache_entry.install,
            cache_entry.uninstall;
        RETURN;
    END IF;

    IF tx_read_only THEN
        RETURN QUERY
        SELECT
            metrics.mau,
            metrics.storage,
            metrics.bandwidth,
            metrics.build_time_unit,
            metrics.get,
            metrics.fail,
            metrics.install,
            metrics.uninstall
        FROM public.calculate_org_metrics_cache_entry(org_id, start_date, end_date) AS metrics;
        RETURN;
    END IF;

    cache_entry := public.seed_org_metrics_cache(get_total_metrics.org_id, start_date, end_date);

    RETURN QUERY SELECT
        cache_entry.mau,
        cache_entry.storage,
        cache_entry.bandwidth,
        cache_entry.build_time_unit,
        cache_entry.get,
        cache_entry.fail,
        cache_entry.install,
        cache_entry.uninstall;
END;
$$;

ALTER FUNCTION public.get_total_metrics(uuid, date, date) OWNER TO postgres;

-- ---------------------------------------------------------------------------
-- 4. Per-app daily metrics: storage is the byte-hours used that day
-- ---------------------------------------------------------------------------
-- get_app_metrics().storage used to be the daily_storage delta in bytes. It is
-- now the byte-hours of the app for that day (rounded), the same value as
-- daily_storage_hourly.storage_byte_hours. The statistics endpoint turns it
-- back into stored bytes for its legacy storage field.
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
        SELECT dsh.app_id, dsh.date, pg_catalog.round(dsh.storage_byte_hours)::bigint AS storage
        FROM public.daily_storage_hourly dsh
        WHERE dsh.owner_org = p_org_id
          AND dsh.app_id IN (SELECT all_apps.app_id FROM all_apps)
          AND dsh.date BETWEEN p_start_date AND p_end_date
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

-- Cached app metrics still hold daily_storage deltas: drop them so the next
-- read rebuilds with byte-hours.
DELETE FROM public.app_metrics_cache;
DELETE FROM public.org_metrics_cache;

-- ---------------------------------------------------------------------------
-- 5. Purge byte-hours of deleted apps with their other daily usage
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_old_deleted_apps()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_purged_app_ids character varying[];
BEGIN
  WITH purged AS (
    DELETE FROM public.deleted_apps
    WHERE deleted_at < now() - interval '35 days'
    RETURNING app_id
  )
  SELECT COALESCE(array_agg(DISTINCT purged.app_id), '{}')
  INTO v_purged_app_ids
  FROM purged;

  IF cardinality(v_purged_app_ids) = 0 THEN
    RETURN;
  END IF;

  DELETE FROM public.daily_build_time dbt
  WHERE dbt.app_id = ANY (v_purged_app_ids)
    AND NOT EXISTS (SELECT 1 FROM public.apps a WHERE a.app_id = dbt.app_id)
    AND NOT EXISTS (SELECT 1 FROM public.deleted_apps da WHERE da.app_id = dbt.app_id);

  DELETE FROM public.daily_mau dm
  WHERE dm.app_id = ANY (v_purged_app_ids)
    AND NOT EXISTS (SELECT 1 FROM public.apps a WHERE a.app_id = dm.app_id)
    AND NOT EXISTS (SELECT 1 FROM public.deleted_apps da WHERE da.app_id = dm.app_id);

  DELETE FROM public.daily_bandwidth db
  WHERE db.app_id = ANY (v_purged_app_ids)
    AND NOT EXISTS (SELECT 1 FROM public.apps a WHERE a.app_id = db.app_id)
    AND NOT EXISTS (SELECT 1 FROM public.deleted_apps da WHERE da.app_id = db.app_id);

  DELETE FROM public.daily_storage_hourly dsh
  WHERE dsh.app_id = ANY (v_purged_app_ids)
    AND NOT EXISTS (SELECT 1 FROM public.apps a WHERE a.app_id = dsh.app_id)
    AND NOT EXISTS (SELECT 1 FROM public.deleted_apps da WHERE da.app_id = dsh.app_id);
END;
$$;

COMMENT ON FUNCTION public.delete_old_deleted_apps() IS
'Purges deleted_apps rows older than 35 days and the daily_build_time, '
'daily_mau, daily_bandwidth and daily_storage_hourly rows of those app_ids '
'when the app_id is not live and not retained by another deleted_apps row. '
'Until then the usage stays billable through calculate_org_metrics_cache_entry.';

-- ---------------------------------------------------------------------------
-- 6. Drop the snapshot storage pipeline
-- ---------------------------------------------------------------------------
-- daily_storage (per-day byte deltas) and read_storage_usage (its source) are
-- replaced by daily_storage_hourly. Workers of the previous deploy still call
-- them from cron_stat_app until they are replaced; those jobs fail and the
-- queue retries them on the new workers.
-- get_total_storage_size_org / get_total_app_storage_size_orgs no longer feed
-- billing, the console or the statistics API. They are kept for this release
-- because statistics workers of the previous deploy call them until replaced.
DROP FUNCTION IF EXISTS public.read_storage_usage(character varying, timestamp without time zone, timestamp without time zone);
DROP TABLE IF EXISTS public.daily_storage;
