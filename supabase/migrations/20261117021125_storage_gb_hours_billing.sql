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

-- Rows are keyed by the org and the billing cycle they belong to:
-- * owner_org: a deleted app ID recreated by another org within 35 days (or a
--   transferred app) must not rewrite the hours the former org already used.
-- * cycle_start: with a non-midnight anchor, the UTC day of the cycle boundary
--   holds hours of two cycles. Each cycle keeps its own row, so refreshing the
--   new cycle never overwrites the completed cycle's part.
-- Existing rows only ever held the current cycle of their org at write time,
-- so cycle_start = date keeps them in the right cycle for the billing filter
-- (cycle_start within [start_date, end_date)).
ALTER TABLE public.daily_storage_hourly ADD COLUMN IF NOT EXISTS cycle_start date;
UPDATE public.daily_storage_hourly SET cycle_start = date WHERE cycle_start IS NULL;
ALTER TABLE public.daily_storage_hourly ALTER COLUMN cycle_start SET NOT NULL;
-- * segment_start: when the accruing ownership segment of the app began inside
--   the cycle (the cycle start, the app creation, or a transfer to the org).
--   A deleted app ID recreated by the same org within the cycle accrues in a
--   new segment, so refreshing it never replaces the earlier incarnation's
--   hours. Existing rows get '-infinity' (legacy), which the next refresh of
--   the org's cycle replaces with its recalculated segment.
ALTER TABLE public.daily_storage_hourly
ADD COLUMN IF NOT EXISTS segment_start timestamptz NOT NULL DEFAULT '-infinity';
ALTER TABLE public.daily_storage_hourly DROP CONSTRAINT IF EXISTS daily_storage_hourly_pkey;
ALTER TABLE public.daily_storage_hourly
ADD CONSTRAINT daily_storage_hourly_pkey PRIMARY KEY (app_id, owner_org, cycle_start, date, segment_start);

COMMENT ON COLUMN public.daily_storage_hourly.cycle_start IS
'UTC date of the start of the billing cycle these hours belong to.';

COMMENT ON COLUMN public.daily_storage_hourly.segment_start IS
'Start of the ownership segment that accrued these hours (cycle start, app '
'creation or transfer); -infinity for whole-day legacy rows.';

COMMENT ON TABLE public.daily_storage_hourly IS
'Storage usage in byte-hours per app and UTC day (GB-hours x 2^30), written by '
'cron_stat_app from version_meta. Only source of storage billing: see '
'get_org_storage_billable_bytes. Rows of deleted apps are kept until '
'delete_old_deleted_apps purges them.';

-- ---------------------------------------------------------------------------
-- 2. Billable storage of an org for a period
-- ---------------------------------------------------------------------------
-- Callers pass the period as dates, like every other get_total_metrics metric.
-- A row counts when its day is in [start_date, end_date] and its cycle started
-- in [start_date, end_date): get_total_metrics(org) passes
-- (cycle_start::date, cycle_end::date), which keeps the current cycle's part of
-- the boundary days and skips the previous and next cycles' parts. The hours
-- are (end_date - start_date) x 24 (at least 24), the exact cycle length since
-- both anchors share the time of day.
CREATE OR REPLACE FUNCTION public.get_org_storage_billable_bytes(
    p_org_id uuid, p_start_date date, p_end_date date
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
      / (GREATEST(p_end_date - p_start_date, 1) * 24)::double precision
    ),
    0
  )::bigint
  FROM public.daily_storage_hourly dsh
  WHERE dsh.owner_org = p_org_id
    AND dsh.date BETWEEN p_start_date AND p_end_date
    AND dsh.cycle_start >= p_start_date
    AND dsh.cycle_start < GREATEST(p_end_date, p_start_date + 1)
$$;

ALTER FUNCTION public.get_org_storage_billable_bytes(uuid, date, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_org_storage_billable_bytes(uuid, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_org_storage_billable_bytes(uuid, date, date) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_storage_billable_bytes(uuid, date, date) TO service_role;

COMMENT ON FUNCTION public.get_org_storage_billable_bytes(uuid, date, date) IS
'Average bytes stored by the org over the billing period starting on '
'start_date: byte-hours of its cycles started in [start_date, end_date), on '
'days in [start_date, end_date], divided by (end_date - start_date) x 24. '
'This is the storage value compared with plans.storage and priced by the '
'credit tiers.';

-- ---------------------------------------------------------------------------
-- 2b. Atomic refresh of one app's rows for one org and one cycle
-- ---------------------------------------------------------------------------
-- cron_stat_app calls this with the rows it calculated from version_meta.
-- One statement, so billing reads never see the cycle between the delete and
-- the upsert. Only rows of p_owner_org and of its segment p_segment_start,
-- whose cycle_start is in [p_cycle_start_day, p_cycle_end_day) and whose day
-- is in [p_cycle_start_day, p_end_exclusive_day), are replaced: hours of
-- another owner or of an earlier incarnation of the app ID, and the other
-- cycles' parts of a boundary day, stay. Legacy rows of the org's cycle
-- (-infinity, written before this migration) are always replaced: the old
-- refresh overwrote every row of the app ID in the cycle, so they only hold
-- the current app's hours, which the refresh recalculates. A whole-cycle
-- refresh (p_replace_legacy: the segment starts at the cycle start) also
-- replaces a whole-cycle segment whose anchor time moved.
-- p_written_at is taken by the caller before it reads version_meta: a row
-- written by a refresh that started later is never deleted or overwritten,
-- whatever order the refreshes finish in.
-- Latest refresh of each app/org/cycle/segment. replace_app_storage_hourly only
-- runs when its refresh started after the recorded one, so a refresh finishing
-- late can neither overwrite a newer result nor re-insert a day a newer refresh
-- removed. Internal: no client access.
CREATE TABLE IF NOT EXISTS public.daily_storage_hourly_refreshes (
    app_id character varying NOT NULL,
    owner_org uuid NOT NULL,
    cycle_start date NOT NULL,
    segment_start timestamptz NOT NULL,
    written_at timestamptz NOT NULL,
    PRIMARY KEY (app_id, owner_org, cycle_start, segment_start)
);

ALTER TABLE public.daily_storage_hourly_refreshes OWNER TO postgres;
ALTER TABLE public.daily_storage_hourly_refreshes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_storage_hourly_refreshes FROM PUBLIC, anon, authenticated;
CREATE POLICY "Deny all direct access"
ON public.daily_storage_hourly_refreshes
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
GRANT ALL ON TABLE public.daily_storage_hourly_refreshes TO service_role;

COMMENT ON TABLE public.daily_storage_hourly_refreshes IS
'Start time of the latest storage refresh applied per app, org, cycle and '
'segment. Guards replace_app_storage_hourly against refreshes finishing out '
'of order. Purged with old deleted apps by delete_old_deleted_apps.';

CREATE OR REPLACE FUNCTION public.replace_app_storage_hourly(
    p_app_id character varying,
    p_owner_org uuid,
    p_cycle_start_day date,
    p_cycle_end_day date,
    p_end_exclusive_day date,
    p_segment_start timestamptz,
    p_replace_legacy boolean,
    p_rows jsonb,
    p_written_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  -- Advance the watermark, or stop: a refresh that started later already
  -- replaced this cycle and segment. The row lock serializes concurrent ones.
  INSERT INTO public.daily_storage_hourly_refreshes AS refresh (app_id, owner_org, cycle_start, segment_start, written_at)
  VALUES (p_app_id, p_owner_org, p_cycle_start_day, p_segment_start, p_written_at)
  ON CONFLICT (app_id, owner_org, cycle_start, segment_start) DO UPDATE
    SET written_at = EXCLUDED.written_at
    WHERE refresh.written_at <= EXCLUDED.written_at;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  WITH new_rows AS (
    SELECT r.cycle_start, r.date, r.storage_byte_hours
    FROM pg_catalog.jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb))
      AS r(cycle_start date, date date, storage_byte_hours double precision)
  ),
  removed AS (
    DELETE FROM public.daily_storage_hourly dsh
    WHERE dsh.app_id = p_app_id
      AND dsh.owner_org = p_owner_org
      AND dsh.cycle_start >= p_cycle_start_day
      AND dsh.cycle_start < GREATEST(p_cycle_end_day, p_cycle_start_day + 1)
      AND dsh.date >= p_cycle_start_day
      AND dsh.date < p_end_exclusive_day
      AND (
        dsh.segment_start = p_segment_start
        OR dsh.segment_start = '-infinity'::timestamptz
        OR (p_replace_legacy AND dsh.segment_start < p_segment_start)
      )
      AND dsh.updated_at <= p_written_at
      AND NOT EXISTS (
        SELECT 1 FROM new_rows
        WHERE new_rows.cycle_start = dsh.cycle_start
          AND new_rows.date = dsh.date
          AND dsh.segment_start = p_segment_start
      )
  )
  INSERT INTO public.daily_storage_hourly (app_id, owner_org, cycle_start, date, segment_start, storage_byte_hours, updated_at)
  SELECT p_app_id, p_owner_org, new_rows.cycle_start, new_rows.date, p_segment_start, new_rows.storage_byte_hours, p_written_at
  FROM new_rows
  ON CONFLICT (app_id, owner_org, cycle_start, date, segment_start) DO UPDATE SET
    storage_byte_hours = EXCLUDED.storage_byte_hours,
    updated_at = EXCLUDED.updated_at
  WHERE public.daily_storage_hourly.updated_at <= EXCLUDED.updated_at;
END;
$$;

ALTER FUNCTION public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, boolean, jsonb, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, boolean, jsonb, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, boolean, jsonb, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, boolean, jsonb, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- 2c. Cycle storage usage for the console
-- ---------------------------------------------------------------------------
-- The usage page shows GB-hours used vs included. It reads them here, with the
-- same rows and hours as billing, instead of summing the calendar-day chart
-- series (which also holds the previous cycle's part of a boundary day).
CREATE OR REPLACE FUNCTION public.get_org_storage_usage(orgid uuid)
RETURNS TABLE(storage_byte_hours double precision, cycle_hours double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_start_date date;
  v_end_date date;
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_org_read_billing(),
      get_org_storage_usage.orgid,
      NULL::character varying,
      NULL::bigint
    )
  THEN
    RETURN;
  END IF;

  SELECT (cycle.cycle_start AT TIME ZONE 'UTC')::date, (cycle.cycle_end AT TIME ZONE 'UTC')::date
  INTO v_start_date, v_end_date
  FROM public.get_org_billing_cycle(get_org_storage_usage.orgid) AS cycle;

  IF v_start_date IS NULL OR v_end_date IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(SUM(dsh.storage_byte_hours), 0)::double precision,
    (GREATEST(v_end_date - v_start_date, 1) * 24)::double precision
  FROM public.daily_storage_hourly dsh
  WHERE dsh.owner_org = get_org_storage_usage.orgid
    AND dsh.date BETWEEN v_start_date AND v_end_date
    AND dsh.cycle_start >= v_start_date
    AND dsh.cycle_start < GREATEST(v_end_date, v_start_date + 1);
END;
$$;

ALTER FUNCTION public.get_org_storage_usage(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_org_storage_usage(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_org_storage_usage(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_org_storage_usage(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2d. Keep refreshing apps that store bundles without other activity
-- ---------------------------------------------------------------------------
-- Byte-hours only exist once cron_stat_app wrote them. stats_jobs queued only
-- apps with recent uploads, MAU, device usage or bandwidth, so an app that
-- keeps bundles but has no other activity stopped accruing billed hours. Such
-- apps of billable orgs (active subscription or usage credits) are queued too,
-- at most once a day: while they store a bundle, and once more after a bundle
-- event (such as the last bundle's removal) newer than their last refresh, so
-- the hours up to that removal are recorded.
CREATE OR REPLACE FUNCTION public.process_cron_stats_jobs()
RETURNS void
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  app_record RECORD;
  -- stat_app_queue drains up to 50/min; release 30/min to keep headroom.
  v_per_minute CONSTANT integer := 30;
  v_index integer := 0;
BEGIN
  FOR app_record IN (
    WITH active_apps AS (
      SELECT DISTINCT av.app_id
      FROM public.app_versions av
      WHERE av.created_at >= pg_catalog.now() - INTERVAL '30 days'

      UNION

      SELECT DISTINCT dm.app_id
      FROM public.daily_mau dm
      WHERE dm.date >= pg_catalog.now() - INTERVAL '30 days' AND dm.mau > 0

      UNION

      SELECT DISTINCT du.app_id
      FROM public.device_usage du
      WHERE du.timestamp >= pg_catalog.now() - INTERVAL '30 days'

      UNION

      SELECT DISTINCT bu.app_id
      FROM public.bandwidth_usage bu
      WHERE bu.timestamp >= pg_catalog.now() - INTERVAL '30 days'

      UNION

      SELECT a.app_id
      FROM public.apps a
      INNER JOIN public.orgs o ON o.id = a.owner_org
      LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
      LEFT JOIN public.app_stats_refresh_state s ON s.app_id = a.app_id
      WHERE (si.status = 'succeeded' OR o.has_usage_credits)
        AND (s.stats_updated_at IS NULL
          OR s.stats_updated_at < pg_catalog.timezone('UTC', pg_catalog.now()) - INTERVAL '20 hours')
        AND (
          EXISTS (
            SELECT 1
            FROM public.app_versions stored
            WHERE stored.app_id = a.app_id
              AND stored.deleted = false
          )
          OR EXISTS (
            SELECT 1
            FROM public.version_meta event
            WHERE event.app_id = a.app_id
              AND (s.stats_updated_at IS NULL OR event.timestamp > s.stats_updated_at)
          )
        )
    )
    SELECT DISTINCT
      active_apps.app_id,
      a.owner_org
    FROM active_apps
    INNER JOIN public.apps a ON a.app_id = active_apps.app_id
  )
  LOOP
    IF public.queue_cron_stat_app_for_app(
      app_record.app_id,
      app_record.owner_org,
      (v_index / v_per_minute) * 60
    ) THEN
      v_index := v_index + 1;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2e. Close bundle lifetimes when an app is deleted
-- ---------------------------------------------------------------------------
-- Byte-hours are rebuilt from version_meta (a positive event when a bundle is
-- stored, a negative one when it is removed). Deleting an app through the API
-- removes app_versions_meta before app_versions, so the version delete path
-- cannot emit the negative events and the bundles stay "stored": a recreated
-- app ID would be billed for them. Close every still-open lifetime of the app
-- at the deletion (the transaction time, like version_meta's default). This
-- also records when the app was deleted: on_app_delete finalizes the deleted
-- app's hours up to its latest closing event, whatever the queue delay.
CREATE OR REPLACE FUNCTION public.close_app_storage_lifetimes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.version_meta (app_id, version_id, size)
  SELECT added.app_id, added.version_id, -added.size
  FROM public.version_meta added
  WHERE added.app_id = OLD.app_id
    AND added.size > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.version_meta removed
      WHERE removed.app_id = added.app_id
        AND removed.version_id = added.version_id
        AND removed.size < 0
    )
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.close_app_storage_lifetimes() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_app_storage_lifetimes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_app_storage_lifetimes() FROM anon, authenticated;

DROP TRIGGER IF EXISTS close_app_storage_lifetimes ON public.apps;
CREATE TRIGGER close_app_storage_lifetimes
AFTER DELETE ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.close_app_storage_lifetimes();

-- Same for one bundle hard-deleted on its own (cron_clear_versions removes a
-- bundle whose R2 object is gone): the app_versions_meta cascade removes its
-- size before on_version_delete runs, so that path cannot close it either.
CREATE OR REPLACE FUNCTION public.close_version_storage_lifetime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.version_meta (app_id, version_id, size)
  SELECT added.app_id, added.version_id, -added.size
  FROM public.version_meta added
  WHERE added.app_id = OLD.app_id
    AND added.version_id = OLD.id
    AND added.size > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.version_meta removed
      WHERE removed.app_id = added.app_id
        AND removed.version_id = added.version_id
        AND removed.size < 0
    )
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.close_version_storage_lifetime() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_version_storage_lifetime() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_version_storage_lifetime() FROM anon, authenticated;

DROP TRIGGER IF EXISTS close_version_storage_lifetime ON public.app_versions;
CREATE TRIGGER close_version_storage_lifetime
AFTER DELETE ON public.app_versions
FOR EACH ROW EXECUTE FUNCTION public.close_version_storage_lifetime();

-- ---------------------------------------------------------------------------
-- 2f. Trigger messages carry when the change happened
-- ---------------------------------------------------------------------------
-- on_app_delete finalizes a deleted app's storage hours up to the deletion.
-- The queue can run it much later, after the app ID was recreated, so the
-- deletion time must come from the event itself. Additive payload field:
-- handlers that do not read it are unchanged.
CREATE OR REPLACE FUNCTION "public"."trigger_http_queue_post_to_function"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  payload jsonb;
  record_payload jsonb;
  old_record_payload jsonb;
  function_type text;
BEGIN
  function_type := CASE
    WHEN NULLIF(TG_ARGV[1], '') IS NULL THEN 'cloudflare'
    WHEN pg_catalog.lower(TG_ARGV[1]) = 'supabase' THEN 'cloudflare'
    ELSE TG_ARGV[1]
  END;

  record_payload := pg_catalog.to_jsonb(NEW);
  old_record_payload := pg_catalog.to_jsonb(OLD);

  -- app_versions fat columns can be multi-MB. Never enqueue them; handlers reload when needed.
  IF TG_TABLE_NAME = 'app_versions' THEN
    IF record_payload IS NOT NULL THEN
      record_payload := record_payload - 'manifest' - 'native_packages';
    END IF;
    IF old_record_payload IS NOT NULL THEN
      old_record_payload := old_record_payload - 'manifest' - 'native_packages';
    END IF;

    -- Skip queue fan-out only for dual-storage reclaim: non-null manifest -> NULL.
    -- native_packages is stripped from payloads, so compare it explicitly.
    IF TG_OP = 'UPDATE'
      AND OLD.manifest IS NOT NULL
      AND NEW.manifest IS NULL
      AND NEW.native_packages IS NOT DISTINCT FROM OLD.native_packages
      AND (record_payload - 'updated_at') IS NOT DISTINCT FROM (old_record_payload - 'updated_at')
    THEN
      RETURN NEW;
    END IF;
  END IF;

  payload := pg_catalog.jsonb_build_object(
    'function_name', TG_ARGV[0],
    'function_type', function_type,
    'payload', pg_catalog.jsonb_build_object(
      'old_record', old_record_payload,
      'record', record_payload,
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'occurred_at', pg_catalog.clock_timestamp()
    )
  );

  IF TG_ARGV[0] IS NOT NULL THEN
    PERFORM "pgmq"."send"(TG_ARGV[0], payload);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."trigger_http_queue_post_to_function"() OWNER TO "postgres";

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
        -- A cycle boundary day has one row per cycle: the day is their sum.
        SELECT dsh.app_id, dsh.date, pg_catalog.round(SUM(dsh.storage_byte_hours))::bigint AS storage
        FROM public.daily_storage_hourly dsh
        WHERE dsh.owner_org = p_org_id
          AND dsh.app_id IN (SELECT all_apps.app_id FROM all_apps)
          AND dsh.date BETWEEN p_start_date AND p_end_date
        GROUP BY dsh.app_id, dsh.date
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

  DELETE FROM public.daily_storage_hourly_refreshes refresh
  WHERE refresh.app_id = ANY (v_purged_app_ids)
    AND NOT EXISTS (SELECT 1 FROM public.apps a WHERE a.app_id = refresh.app_id)
    AND NOT EXISTS (SELECT 1 FROM public.deleted_apps da WHERE da.app_id = refresh.app_id);
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
