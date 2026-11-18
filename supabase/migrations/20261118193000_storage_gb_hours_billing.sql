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
-- Atomic deploy (capgo-22.63.1): one transaction. Heavy DDL first (only
-- AccessShare on apps / app_versions), then short AccessExclusive on
-- app_versions + apps for FK drop and lifetime triggers. lock_timeout 500ms on
-- each lock acquisition (below prod deadlock_timeout 1s).
-- Writers: version_meta via upsert_version_meta and storage backfills;
-- daily_storage_hourly via replace_app_storage_hourly / cron_stat_app. While
-- this transaction holds AccessExclusive on those tables, writers stall for
-- the rest of the migration (tens of seconds at prod daily_storage_hourly size).
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Byte-hours of deleted apps stay billable until delete_old_deleted_apps
-- ---------------------------------------------------------------------------
-- Same reason as daily_build_time in 20260930094441: an ON DELETE CASCADE to
-- apps would wipe the hours already used in the cycle when the app is deleted.
DO $capgo_lock_daily_storage_hourly$
DECLARE
  attempt int;
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '500ms';
      LOCK TABLE public.daily_storage_hourly IN ACCESS EXCLUSIVE MODE;
      RETURN;
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected THEN
        IF attempt >= 60 THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(0.1);
    END;
  END LOOP;
END;
$capgo_lock_daily_storage_hourly$;

ALTER TABLE public.daily_storage_hourly ADD COLUMN IF NOT EXISTS cycle_start date;
UPDATE public.daily_storage_hourly SET cycle_start = date WHERE cycle_start IS NULL;
ALTER TABLE public.daily_storage_hourly ALTER COLUMN cycle_start SET NOT NULL;
-- * segment_start: when the accruing ownership segment of the app began (the
--   app creation or a transfer to the org; -infinity when unknown).
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
'Start of the ownership segment that accrued these hours (app creation or '
'transfer to the org); -infinity when unknown and for legacy rows.';

COMMENT ON TABLE public.daily_storage_hourly IS
'Storage usage in byte-hours per app and UTC day (GB-hours x 2^30), written by '
'cron_stat_app from version_meta. Only source of storage billing: see '
'get_org_storage_billable_bytes. Rows of deleted apps are kept until '
'delete_old_deleted_apps purges them.';

-- Drop before the long version_meta phase and before the final apps lock wait,
-- so concurrent app deletes do not CASCADE-block on this FK while the
-- migration retries LOCK TABLE public.app_versions, public.apps.
ALTER TABLE public.daily_storage_hourly
DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey;

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
-- the upsert. Only rows of p_owner_org and of its ownership segment
-- p_segment_start (when that owner got the app: creation or transfer), whose
-- cycle_start is in [p_cycle_start_day, p_cycle_end_day) and whose day is in
-- [p_cycle_start_day, p_end_exclusive_day), are replaced: hours of another
-- owner or of an earlier incarnation of the app ID, and the other cycles'
-- parts of a boundary day, stay. The segment does not depend on the cycle, so
-- an anchor that moves within the cycle's first day (either way) keeps the
-- same rows and watermark. Legacy rows of the org's cycle (-infinity, written
-- before this migration) are always replaced: the old refresh overwrote every
-- row of the app ID in the cycle, so they only hold the current app's hours,
-- which the refresh recalculates.
-- p_written_at is taken by the caller before it reads version_meta: a row
-- written by a refresh that started later is never deleted or overwritten,
-- whatever order the refreshes finish in.
-- Latest refresh of each app/org/cycle/segment. replace_app_storage_hourly only
-- runs when its refresh started after the recorded one, so a refresh finishing
-- late can neither overwrite a newer result nor re-insert a day a newer refresh
-- removed. The segment key is the ownership segment's start (not the cycle's),
-- so every refresh of a segment shares its watermark even when the anchor
-- time moves within the cycle's first day. Internal: no client access.
CREATE TABLE IF NOT EXISTS public.daily_storage_hourly_refreshes (
    app_id character varying NOT NULL,
    owner_org uuid NOT NULL,
    cycle_start date NOT NULL,
    segment_start timestamptz NOT NULL,
    -- When the refresh started (orders refreshes).
    written_at timestamptz NOT NULL,
    -- How far its calculation went (finalization checks: a backfill with an
    -- earlier end does not count as covering what came after).
    calculated_until timestamptz NOT NULL,
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
    p_rows jsonb,
    p_written_at timestamptz,
    p_require_current_owner boolean DEFAULT true,
    p_app_uuid uuid DEFAULT NULL,
    p_calculated_until timestamptz DEFAULT NULL,
    p_transfer_count integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  -- A live refresh only writes while its org still owns the app: it may have
  -- read the owner before a transfer and calculated past it. The share lock
  -- keeps a transfer from committing in between. When the owner changed it
  -- writes nothing (and leaves the watermark), so the new owner's refresh
  -- finalizes the former owner up to the transfer. The former-owner and
  -- deletion finalizers write rows clipped on purpose and skip this check.
  -- p_app_uuid (apps.id when the refresh loaded the app) also binds it to that
  -- incarnation: an app deleted and recreated by the same org mid-refresh is
  -- another row, so the stale refresh writes nothing. p_transfer_count (the
  -- transfer_history length it loaded) binds it to that ownership segment: a
  -- transfer recorded since, even to the same org, starts a new segment.
  IF p_require_current_owner THEN
    PERFORM 1
    FROM public.apps
    WHERE apps.app_id = p_app_id
      AND apps.owner_org = p_owner_org
      AND (p_app_uuid IS NULL OR apps.id = p_app_uuid)
      AND (p_transfer_count IS NULL OR COALESCE(pg_catalog.array_length(apps.transfer_history, 1), 0) = p_transfer_count)
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN;
    END IF;
  END IF;

  -- Advance the watermark, or stop: a refresh that started later already
  -- replaced this cycle and segment. The row lock serializes concurrent ones.
  INSERT INTO public.daily_storage_hourly_refreshes AS refresh (app_id, owner_org, cycle_start, segment_start, written_at, calculated_until)
  VALUES (
    p_app_id,
    p_owner_org,
    p_cycle_start_day,
    p_segment_start,
    p_written_at,
    COALESCE(p_calculated_until, p_written_at)
  )
  ON CONFLICT (app_id, owner_org, cycle_start, segment_start) DO UPDATE
    SET written_at = EXCLUDED.written_at,
        calculated_until = EXCLUDED.calculated_until
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

ALTER FUNCTION public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, jsonb, timestamptz, boolean, uuid, timestamptz, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, jsonb, timestamptz, boolean, uuid, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, jsonb, timestamptz, boolean, uuid, timestamptz, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_app_storage_hourly(character varying, uuid, date, date, date, timestamptz, jsonb, timestamptz, boolean, uuid, timestamptz, integer) TO service_role;

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
-- event (such as the last bundle's removal) newer than their last storage
-- refresh's cutoff, so the hours up to that removal are recorded.
-- When each storage event was written, separately from when it happened
-- (timestamp): a removal recorded late is dated at the deletion, before the
-- last refresh's cutoff, yet that refresh never saw it. stats_jobs compares
-- this with the cutoff. A stable default: added without a table rewrite;
-- existing rows get the migration time (one more refresh of their apps).
DO $capgo_lock_version_meta$
DECLARE
  attempt int;
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '500ms';
      LOCK TABLE public.version_meta IN ACCESS EXCLUSIVE MODE;
      RETURN;
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected THEN
        IF attempt >= 60 THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(0.1);
    END;
  END LOOP;
END;
$capgo_lock_version_meta$;

ALTER TABLE public.version_meta
ADD COLUMN IF NOT EXISTS recorded_at timestamp NOT NULL DEFAULT pg_catalog.timezone('UTC', pg_catalog.now());

-- Future rows take the insert time, not the transaction start (closer to the
-- commit). Set after the column is added: a volatile default there would
-- rewrite the table.
ALTER TABLE public.version_meta
ALTER COLUMN recorded_at SET DEFAULT pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());

COMMENT ON COLUMN public.version_meta.recorded_at IS
'When the event was written (UTC). timestamp is when it happened: a late removal is dated at the deletion. Storage refreshes are re-queued for events recorded after (or up to 1 hour before) their cutoff.';

-- A bundle can be stored, deleted and restored (within the restore window):
-- each stored interval is a lifetime, numbered from 0, with at most one upload
-- (positive) and one removal (negative) event. A restored bundle starts a new
-- lifetime at the restore, so the deleted interval is not billed and the
-- restored one is. Existing rows are lifetime 0 (a constant default: no
-- rewrite). The one-event-per-bundle unique indexes become per lifetime.
ALTER TABLE public.version_meta
ADD COLUMN IF NOT EXISTS lifetime integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.version_meta.lifetime IS
'Stored interval of the bundle, from 0: a restored bundle starts the next one. At most one upload (size > 0) and one removal (size < 0) event per lifetime.';

CREATE UNIQUE INDEX IF NOT EXISTS unique_app_version_lifetime_positive
ON public.version_meta USING btree (app_id, version_id, lifetime) WHERE (size > 0);
CREATE UNIQUE INDEX IF NOT EXISTS unique_app_version_lifetime_negative
ON public.version_meta USING btree (app_id, version_id, lifetime) WHERE (size < 0);
DROP INDEX IF EXISTS public.unique_app_version_positive;
DROP INDEX IF EXISTS public.unique_app_version_negative;

CREATE OR REPLACE FUNCTION public.process_cron_stats_jobs()
RETURNS void
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  -- stat_app_queue drains up to 30/min; release 25/min to keep headroom.
  v_per_minute CONSTANT integer := 25;
  v_now_utc timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  v_refresh_ttl CONSTANT interval := INTERVAL '5 minutes';
  v_app_ids character varying[];
  v_org_ids uuid[];
  v_queue_app_ids character varying[];
  v_queue_org_ids uuid[];
  v_slot record;
BEGIN
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
          -- An event written after how far the latest storage refresh
          -- calculated (it read version_meta up to there), not after
          -- stats_updated_at (its completion): a removal while a refresh ran,
          -- or one recorded late and dated at the deletion (before that
          -- cutoff), still gets refreshed. recorded_at is set at insert, not
          -- commit: an event recorded up to 1 hour before the cutoff may not
          -- have been visible to that refresh (these writes run in short,
          -- statement-timeout-bound transactions), so it is refreshed once
          -- more.
          SELECT 1
          FROM public.version_meta event
          WHERE event.app_id = a.app_id
            AND event.recorded_at > COALESCE(
              (
                SELECT pg_catalog.timezone('UTC', max(refresh.calculated_until)) - interval '1 hour'
                FROM public.daily_storage_hourly_refreshes refresh
                WHERE refresh.app_id = a.app_id
                  AND refresh.owner_org = a.owner_org
              ),
              '-infinity'::timestamp
            )
        )
      )
  )
  SELECT
    pg_catalog.array_agg(a.app_id ORDER BY a.app_id),
    pg_catalog.array_agg(a.owner_org ORDER BY a.app_id)
  INTO v_app_ids, v_org_ids
  FROM active_apps
  INNER JOIN public.apps a ON a.app_id = active_apps.app_id;

  IF v_app_ids IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.org_stats_refresh_state (org_id)
  SELECT DISTINCT org_ids.org_id
  FROM pg_catalog.unnest(v_org_ids) AS org_ids(org_id)
  ON CONFLICT ON CONSTRAINT org_stats_refresh_state_pkey DO NOTHING;

  PERFORM 1
  FROM public.org_stats_refresh_state s
  WHERE s.org_id = ANY(v_org_ids)
  ORDER BY s.org_id
  FOR UPDATE;

  WITH requested AS (
    INSERT INTO public.app_stats_refresh_state (app_id, owner_org, stats_refresh_requested_at)
    SELECT candidate.app_id, candidate.owner_org, v_now_utc
    FROM ROWS FROM (pg_catalog.unnest(v_app_ids), pg_catalog.unnest(v_org_ids)) AS candidate(app_id, owner_org)
    LEFT JOIN public.app_stats_refresh_state s ON s.app_id = candidate.app_id
    WHERE (s.stats_updated_at IS NULL OR s.stats_updated_at < v_now_utc - v_refresh_ttl)
      AND (s.stats_refresh_requested_at IS NULL OR s.stats_refresh_requested_at < v_now_utc - v_refresh_ttl)
    ON CONFLICT (app_id) DO UPDATE
    SET owner_org = EXCLUDED.owner_org,
        stats_refresh_requested_at = EXCLUDED.stats_refresh_requested_at
    WHERE (app_stats_refresh_state.stats_updated_at IS NULL
        OR app_stats_refresh_state.stats_updated_at < v_now_utc - v_refresh_ttl)
      AND (app_stats_refresh_state.stats_refresh_requested_at IS NULL
        OR app_stats_refresh_state.stats_refresh_requested_at < v_now_utc - v_refresh_ttl)
    RETURNING app_id, owner_org
  )
  SELECT
    pg_catalog.array_agg(requested.app_id ORDER BY requested.app_id),
    pg_catalog.array_agg(requested.owner_org ORDER BY requested.app_id)
  INTO v_queue_app_ids, v_queue_org_ids
  FROM requested
  WHERE NOT EXISTS (
    SELECT 1 FROM pgmq.q_cron_stat_app queued_job
    WHERE queued_job.message->'payload'->>'appId' = requested.app_id
  );

  IF v_queue_app_ids IS NULL THEN
    RETURN;
  END IF;

  FOR v_slot IN
    SELECT
      ((queued.position - 1) / v_per_minute)::integer AS slot,
      pg_catalog.array_agg(pg_catalog.jsonb_build_object(
        'function_name', 'cron_stat_app',
        'function_type', 'cloudflare',
        'payload', pg_catalog.jsonb_build_object(
          'appId', queued.app_id,
          'orgId', queued.owner_org,
          'todayOnly', false
        )
      ) ORDER BY queued.position) AS messages
    FROM ROWS FROM (pg_catalog.unnest(v_queue_app_ids), pg_catalog.unnest(v_queue_org_ids)) WITH ORDINALITY AS queued(app_id, owner_org, position)
    GROUP BY 1
    ORDER BY 1
  LOOP
    PERFORM pgmq.send_batch('cron_stat_app', v_slot.messages, v_slot.slot * 60);
  END LOOP;
END;
$$;

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
-- 2g. Transfers take their timestamp after locking the app
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."transfer_app"("p_app_id" character varying, "p_new_org_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_old_org_id uuid;
    v_user_id uuid;
    v_last_transfer jsonb;
    v_last_transfer_date timestamp;
    v_transferred_at timestamptz;
    v_transfer_error constant text := 'Unable to process transfer request.';
    v_app_id_key constant text := 'app_id';
    v_old_org_id_key constant text := 'old_org_id';
    v_new_org_id_key constant text := 'new_org_id';
    v_uid_key constant text := 'uid';
BEGIN
  -- Lock the app before reading its owner and last transfer: a concurrent
  -- transfer then waits, and this one checks permissions and the cooldown
  -- against the committed owner (else A->B and A->C could both pass and
  -- record A->C, attributing B's storage hours to A). A running storage
  -- refresh of the owner holds a share lock on the app until it commits, so
  -- the transfer time, taken after this lock, follows every hour it wrote.
  SELECT owner_org, transfer_history[array_length(transfer_history, 1)]
  INTO v_old_org_id, v_last_transfer
  FROM public.apps
  WHERE app_id = p_app_id
  FOR UPDATE;

  IF v_old_org_id IS NULL THEN
    RAISE EXCEPTION '%', v_transfer_error;
  END IF;

  v_user_id := (SELECT auth.uid());

  IF v_user_id IS NULL THEN
    PERFORM public.pg_log(
      'deny: TRANSFER_NO_AUTH',
      jsonb_build_object(v_app_id_key, p_app_id, v_new_org_id_key, p_new_org_id)
    );
    RAISE EXCEPTION '%', v_transfer_error;
  END IF;

  IF NOT public.rbac_check_permission(
      public.rbac_perm_app_transfer(),
      v_old_org_id,
      p_app_id,
      NULL::bigint
  ) THEN
    PERFORM public.pg_log(
      'deny: TRANSFER_OLD_ORG_RIGHTS',
      jsonb_build_object(
        v_app_id_key, p_app_id,
        v_old_org_id_key, v_old_org_id,
        v_new_org_id_key, p_new_org_id,
        v_uid_key, v_user_id
      )
    );
    RAISE EXCEPTION '%', v_transfer_error;
  END IF;

  IF NOT public.rbac_check_permission(
      public.rbac_perm_app_transfer(),
      p_new_org_id,
      NULL::character varying,
      NULL::bigint
  ) THEN
    PERFORM public.pg_log(
      'deny: TRANSFER_NEW_ORG_RIGHTS',
      jsonb_build_object(
        v_app_id_key, p_app_id,
        v_old_org_id_key, v_old_org_id,
        v_new_org_id_key, p_new_org_id,
        v_uid_key, v_user_id
      )
    );
    RAISE EXCEPTION '%', v_transfer_error;
  END IF;

  IF v_last_transfer IS NOT NULL THEN
    v_last_transfer_date := (v_last_transfer->>'transferred_at')::timestamp;
    IF v_last_transfer_date + interval '32 days' > now() THEN
      RAISE EXCEPTION
          'Cannot transfer app. Must wait at least 32 days '
          'between transfers. Last transfer was on %',
          v_last_transfer_date;
    END IF;
  END IF;

  BEGIN
    -- Allow the guarded owner_org cascade only inside the approved transfer path.
    PERFORM set_config('capgo.allow_owner_org_transfer', 'true', true);

    -- Storage is billed per owner up to transferred_at: taken after the lock
    -- above (now() is the transaction start, which could precede a refresh
    -- the transfer waited for).
    v_transferred_at := pg_catalog.clock_timestamp();

    UPDATE public.apps
    SET
        owner_org = p_new_org_id,
        updated_at = now(),
        transfer_history = COALESCE(transfer_history, '{}') || jsonb_build_object(
            'transferred_at', v_transferred_at,
            'transferred_from', v_old_org_id,
            'transferred_to', p_new_org_id,
            'initiated_by', v_user_id
        )::jsonb
    WHERE app_id = p_app_id;

    UPDATE public.app_versions
    SET owner_org = p_new_org_id
    WHERE app_id = p_app_id;

    UPDATE public.app_versions_meta
    SET owner_org = p_new_org_id
    WHERE app_id = p_app_id;

    UPDATE public.channel_devices
    SET owner_org = p_new_org_id
    WHERE app_id = p_app_id;

    UPDATE public.channels
    SET owner_org = p_new_org_id
    WHERE app_id = p_app_id;

    UPDATE public.deploy_history
    SET owner_org = p_new_org_id
    WHERE app_id = p_app_id;

    PERFORM set_config('capgo.allow_owner_org_transfer', 'false', true);
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM set_config('capgo.allow_owner_org_transfer', 'false', true);
      RAISE;
  END;

  -- The former owner's storage hours up to the transfer are recorded by a
  -- refresh under the new owner (it finalizes former owners). stats_jobs may
  -- never schedule an idle app of an org without billing, and jobs queued for
  -- the former owner are skipped once it no longer owns the app: queue one
  -- now (delivered at commit). A refresh is idempotent, so a duplicate is
  -- harmless.
  PERFORM pgmq.send(
    'cron_stat_app',
    pg_catalog.jsonb_build_object(
      'function_name', 'cron_stat_app',
      'function_type', 'cloudflare',
      'payload', pg_catalog.jsonb_build_object(
        'appId', p_app_id,
        'orgId', p_new_org_id,
        'todayOnly', false
      )
    )
  );

END;
$$;



ALTER FUNCTION "public"."transfer_app"("p_app_id" character varying, "p_new_org_id" "uuid") OWNER TO "postgres";

-- ---------------------------------------------------------------------------
-- 2i. Close lifetimes of bundles already deleted before this migration
-- ---------------------------------------------------------------------------
-- The triggers above close lifetimes from now on. Bundles deleted earlier can
-- still have an open (positive-only) lifetime in version_meta: soft-deleted
-- versions whose removal event was never written, and hard-deleted versions
-- whose app_versions_meta size cascaded away before the removal event could
-- be recorded. Byte-hours would bill them forever. Each one is closed at the
-- best known deletion time: the version's deleted_at (else updated_at), the
-- deleted app's time, or, when unknown, its upload (no further hours, as the
-- previous snapshot billing never billed a deleted bundle). Idempotent.
CREATE OR REPLACE FUNCTION public.close_orphaned_storage_lifetimes()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  WITH open_lifetimes AS (
    SELECT added.app_id, added.version_id, added.size, added.lifetime, added.timestamp AS added_at
    FROM public.version_meta added
    WHERE added.size > 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.version_meta removed
        WHERE removed.app_id = added.app_id
          AND removed.version_id = added.version_id
          AND removed.lifetime = added.lifetime
          AND removed.size < 0
      )
  ),
  orphaned AS (
    SELECT
      open_lifetimes.app_id,
      open_lifetimes.version_id,
      open_lifetimes.size,
      open_lifetimes.lifetime,
      open_lifetimes.added_at,
      CASE
        WHEN versions.id IS NOT NULL THEN
          LEAST(COALESCE(versions.deleted_at, versions.updated_at), pg_catalog.now())
        WHEN apps.app_id IS NULL THEN
          (SELECT max(deleted_apps.deleted_at) FROM public.deleted_apps WHERE deleted_apps.app_id = open_lifetimes.app_id)
      END AS deleted_at
    FROM open_lifetimes
    LEFT JOIN public.app_versions versions ON versions.id = open_lifetimes.version_id
    LEFT JOIN public.apps apps ON apps.app_id = open_lifetimes.app_id
    WHERE versions.id IS NULL OR versions.deleted
  ),
  closed AS (
    INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
    SELECT
      GREATEST(orphaned.added_at, COALESCE(pg_catalog.timezone('UTC', orphaned.deleted_at), orphaned.added_at)),
      orphaned.app_id,
      orphaned.version_id,
      -orphaned.size,
      orphaned.lifetime
    FROM orphaned
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM closed
$$;

ALTER FUNCTION public.close_orphaned_storage_lifetimes() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_orphaned_storage_lifetimes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_orphaned_storage_lifetimes() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_orphaned_storage_lifetimes() TO service_role;

SELECT public.close_orphaned_storage_lifetimes();

-- Live bundles whose size is known (app_versions_meta) but whose upload event
-- was never written to version_meta: the snapshot billing read the size, so a
-- failed event write was harmless, but byte-hours accrue only from that event.
-- Each one gets its upload event at the metadata time (else the version's
-- creation), so its storage keeps being billed. Idempotent.
-- Live bundles restored before this migration kept their closed lifetime (one
-- upload and one removal event per bundle back then): each one whose size is
-- known again gets a new lifetime from its restore (its last update, never
-- before the removal), also when only its removal was recorded.
CREATE OR REPLACE FUNCTION public.backfill_missing_storage_lifetimes()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  WITH added AS (
    INSERT INTO public.version_meta (timestamp, app_id, version_id, size)
    SELECT
      pg_catalog.timezone('UTC', LEAST(COALESCE(meta.created_at, versions.created_at, pg_catalog.now()), pg_catalog.now())),
      versions.app_id,
      versions.id,
      meta.size
    FROM public.app_versions versions
    JOIN public.app_versions_meta meta ON meta.id = versions.id
    WHERE NOT versions.deleted
      AND meta.size > 0
      -- No event at all: a bundle with a removal is handled below (a new
      -- lifetime from its restore), whether or not its upload was recorded.
      AND NOT EXISTS (
        SELECT 1
        FROM public.version_meta existing
        WHERE existing.app_id = versions.app_id
          AND existing.version_id = versions.id
      )
    ON CONFLICT DO NOTHING
    RETURNING 1
  ),
  latest AS (
    SELECT DISTINCT ON (event.app_id, event.version_id)
      event.app_id,
      event.version_id,
      event.lifetime,
      pg_catalog.min(event.timestamp) FILTER (WHERE event.size < 0) OVER lifetime_events AS removed_at
    FROM public.version_meta event
    WINDOW lifetime_events AS (PARTITION BY event.app_id, event.version_id, event.lifetime)
    ORDER BY event.app_id, event.version_id, event.lifetime DESC
  ),
  reopened AS (
    INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
    SELECT
      GREATEST(latest.removed_at, pg_catalog.timezone('UTC', LEAST(versions.updated_at, pg_catalog.now()))),
      versions.app_id,
      versions.id,
      meta.size,
      latest.lifetime + 1
    FROM public.app_versions versions
    JOIN public.app_versions_meta meta ON meta.id = versions.id
    JOIN latest ON latest.app_id = versions.app_id AND latest.version_id = versions.id
    WHERE NOT versions.deleted
      AND meta.size > 0
      -- Closed, with or without a recorded upload event (its write could fail).
      AND latest.removed_at IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM added) + (SELECT count(*) FROM reopened)
$$;

ALTER FUNCTION public.backfill_missing_storage_lifetimes() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.backfill_missing_storage_lifetimes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backfill_missing_storage_lifetimes() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_missing_storage_lifetimes() TO service_role;

SELECT public.backfill_missing_storage_lifetimes();

-- Storage events are recorded at the time they happened (p_timestamp), not at
-- job processing time: a repaired upload bills from the upload, a removal
-- processed late stops at the deletion. Capped at now; NULL keeps now().
-- An upload event can also arrive after its bundle was deleted: the upload job
-- was still reading the size when the deletion job found no lifetime to close.
-- The version row is locked (FOR SHARE) so a deletion cannot commit in between,
-- and a positive event for a version already deleted is closed at its last
-- server-side update (the deletion or later) in the same transaction, so a
-- removed bundle stops accruing byte-hours. A bundle restored after its
-- removal starts a new lifetime at the restore; a removal of a bundle that is
-- live again (restored before the removal job ran) is skipped.
DROP FUNCTION IF EXISTS public.upsert_version_meta(character varying, bigint, bigint);

CREATE OR REPLACE FUNCTION public.upsert_version_meta(
  p_app_id character varying,
  p_version_id bigint,
  p_size bigint,
  p_timestamp timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner_org uuid;
  v_lifetime integer;
  v_lifetime_added_at timestamp;
  v_lifetime_removed_at timestamp;
  v_deleted boolean;
  v_deleted_at timestamptz;
  v_event_at timestamp;
  v_added_at timestamp;
BEGIN
  IF p_size = 0 THEN
    RETURN FALSE;
  END IF;

  SELECT owner_org
  INTO v_owner_org
  FROM public.apps
  WHERE app_id = p_app_id
  LIMIT 1;

  IF v_owner_org IS NULL THEN
    RETURN FALSE;
  END IF;

  -- updated_at, not deleted_at: moddatetime sets it on every update, while a
  -- client can write deleted_at and would backdate the deletion.
  SELECT av.deleted, av.updated_at
  INTO v_deleted, v_deleted_at
  FROM public.app_versions av
  WHERE av.app_id = p_app_id
    AND av.id = p_version_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF COALESCE(current_setting('role', true), '') NOT IN ('service_role', 'postgres')
    AND COALESCE(session_user, current_user) NOT IN ('service_role', 'postgres')
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_app_upload_bundle(),
      v_owner_org,
      p_app_id,
      NULL::bigint
    )
  THEN
    RETURN FALSE;
  END IF;

  -- The bundle's latest stored interval and its events (lifetime 0 before any).
  SELECT COALESCE(max(event.lifetime), 0)
  INTO v_lifetime
  FROM public.version_meta event
  WHERE event.app_id = p_app_id
    AND event.version_id = p_version_id;

  SELECT
    min(event.timestamp) FILTER (WHERE event.size > 0),
    min(event.timestamp) FILTER (WHERE event.size < 0)
  INTO v_lifetime_added_at, v_lifetime_removed_at
  FROM public.version_meta event
  WHERE event.app_id = p_app_id
    AND event.version_id = p_version_id
    AND event.lifetime = v_lifetime;

  v_event_at := pg_catalog.timezone('UTC', LEAST(COALESCE(p_timestamp, pg_catalog.clock_timestamp()), pg_catalog.clock_timestamp()));

  IF p_size > 0 THEN
    -- Already stored and not removed since: nothing to record.
    IF v_lifetime_added_at IS NOT NULL AND v_lifetime_removed_at IS NULL THEN
      RETURN FALSE;
    END IF;
    IF v_lifetime_added_at IS NOT NULL THEN
      -- The interval was closed: only a restored (live again) bundle is stored
      -- again, from its restore (the last server-side update), never from the
      -- original upload: the deleted interval is not billed.
      IF COALESCE(v_deleted, false) THEN
        RETURN FALSE;
      END IF;
      v_lifetime := v_lifetime + 1;
      v_event_at := GREATEST(
        v_event_at,
        v_lifetime_removed_at,
        pg_catalog.timezone('UTC', LEAST(COALESCE(v_deleted_at, pg_catalog.clock_timestamp()), pg_catalog.clock_timestamp()))
      );
    END IF;
  ELSE
    IF v_lifetime_removed_at IS NOT NULL THEN
      RETURN FALSE;
    END IF;
    -- A removal processed after the bundle was restored would close the
    -- restored interval: only a bundle still deleted is removed.
    IF NOT COALESCE(v_deleted, false) THEN
      RETURN FALSE;
    END IF;
    -- A removal dated before a restored lifetime started belongs to an
    -- earlier deletion (a retried job): it never closes the later lifetime.
    IF v_lifetime > 0 AND p_timestamp IS NOT NULL
      AND pg_catalog.timezone('UTC', p_timestamp) < v_lifetime_added_at THEN
      RETURN FALSE;
    END IF;
    -- A removal never precedes the bundle's upload event.
    v_event_at := GREATEST(v_event_at, v_lifetime_added_at);
  END IF;

  INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
  VALUES (v_event_at, p_app_id, p_version_id, p_size, v_lifetime)
  RETURNING timestamp INTO v_added_at;

  -- A late upload event of a deleted bundle: close its lifetime at the deletion.
  IF p_size > 0 AND COALESCE(v_deleted, false) THEN
    INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
    VALUES (
      GREATEST(v_added_at, pg_catalog.timezone('UTC', LEAST(COALESCE(v_deleted_at, pg_catalog.clock_timestamp()), pg_catalog.clock_timestamp()))),
      p_app_id,
      p_version_id,
      -p_size,
      v_lifetime
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN TRUE;
EXCEPTION
  WHEN unique_violation THEN
    RETURN FALSE;
END;
$$;

ALTER FUNCTION public.upsert_version_meta(character varying, bigint, bigint, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_version_meta(character varying, bigint, bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_version_meta(character varying, bigint, bigint, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_version_meta(character varying, bigint, bigint, timestamptz) TO service_role;

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


-- ---------------------------------------------------------------------------
-- Deadlock-safe final locks (apps / app_versions)
-- ---------------------------------------------------------------------------
DO $capgo_lock_apps_for_storage_triggers$
DECLARE
  attempt int;
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      SET LOCAL lock_timeout = '500ms';
      LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE;
      RETURN;
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected THEN
        IF attempt >= 30 THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(0.1);
    END;
  END LOOP;
END;
$capgo_lock_apps_for_storage_triggers$;

-- ---------------------------------------------------------------------------
-- 2e. Close bundle lifetimes when an app is deleted
-- ---------------------------------------------------------------------------
-- Byte-hours are rebuilt from version_meta (a positive event when a bundle is
-- stored, a negative one when it is removed). Deleting an app through the API
-- removes app_versions_meta before app_versions, so the version delete path
-- cannot emit the negative events and the bundles stay "stored": a recreated
-- app ID would be billed for them. Close every still-open lifetime of the app
-- at the deletion (the transaction time, like version_meta's default). This
-- stops the deleted app's hours at its deletion, whatever the queue delay
-- before on_app_delete finalizes them (up to the message's occurred_at).
CREATE OR REPLACE FUNCTION public.close_app_storage_lifetimes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  -- clock_timestamp(): the deletion's statement time, not the transaction start.
  INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
  SELECT GREATEST(added.timestamp, pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())), added.app_id, added.version_id, -added.size, added.lifetime
  FROM public.version_meta added
  WHERE added.app_id = OLD.app_id
    AND added.size > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.version_meta removed
      WHERE removed.app_id = added.app_id
        AND removed.version_id = added.version_id
        AND removed.lifetime = added.lifetime
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
  -- clock_timestamp(): the deletion's statement time, not the transaction start.
  INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
  SELECT GREATEST(added.timestamp, pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())), added.app_id, added.version_id, -added.size, added.lifetime
  FROM public.version_meta added
  WHERE added.app_id = OLD.app_id
    AND added.version_id = OLD.id
    AND added.size > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.version_meta removed
      WHERE removed.app_id = added.app_id
        AND removed.version_id = added.version_id
        AND removed.lifetime = added.lifetime
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

-- A soft deletion closes the bundle's lifetime in the same transaction, at
-- that server time: the asynchronous removal job can run much later (after a
-- hard deletion that would otherwise close it at the later time). The job's
-- own removal write then finds the event and changes nothing.
CREATE OR REPLACE FUNCTION public.close_soft_deleted_version_storage_lifetime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
  SELECT
    -- The soft deletion's statement time (now() is the transaction start).
    GREATEST(added.timestamp, pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())),
    added.app_id, added.version_id, -added.size, added.lifetime
  FROM public.version_meta added
  WHERE added.app_id = NEW.app_id
    AND added.version_id = NEW.id
    AND added.size > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.version_meta removed
      WHERE removed.app_id = added.app_id
        AND removed.version_id = added.version_id
        AND removed.lifetime = added.lifetime
        AND removed.size < 0
    )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.close_soft_deleted_version_storage_lifetime() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_soft_deleted_version_storage_lifetime() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_soft_deleted_version_storage_lifetime() FROM anon, authenticated;

DROP TRIGGER IF EXISTS close_soft_deleted_version_storage_lifetime ON public.app_versions;
CREATE TRIGGER close_soft_deleted_version_storage_lifetime
AFTER UPDATE OF deleted ON public.app_versions
FOR EACH ROW
WHEN (NEW.deleted AND NOT OLD.deleted)
EXECUTE FUNCTION public.close_soft_deleted_version_storage_lifetime();

-- A restored bundle is stored again from the restore, in the next lifetime,
-- in the restoring transaction: its upload job can run after a second
-- deletion, when the bundle is no longer live. The size is the one its last
-- lifetime was billed for. Nothing happens unless that lifetime is closed.
CREATE OR REPLACE FUNCTION public.open_restored_version_storage_lifetime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
  SELECT
    -- The restore's statement time, never before the removal it reopens.
    GREATEST(latest.removed_at, pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())),
    NEW.app_id, NEW.id, latest.size, latest.lifetime + 1
  FROM (
    SELECT
      event.lifetime,
      (pg_catalog.array_agg(event.size ORDER BY event.timestamp) FILTER (WHERE event.size > 0))[1] AS size,
      pg_catalog.min(event.timestamp) FILTER (WHERE event.size < 0) AS removed_at
    FROM public.version_meta event
    WHERE event.app_id = NEW.app_id
      AND event.version_id = NEW.id
    GROUP BY event.lifetime
    ORDER BY event.lifetime DESC
    LIMIT 1
  ) latest
  WHERE latest.size IS NOT NULL
    AND latest.removed_at IS NOT NULL
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.open_restored_version_storage_lifetime() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.open_restored_version_storage_lifetime() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_restored_version_storage_lifetime() FROM anon, authenticated;

DROP TRIGGER IF EXISTS open_restored_version_storage_lifetime ON public.app_versions;
CREATE TRIGGER open_restored_version_storage_lifetime
AFTER UPDATE OF deleted ON public.app_versions
FOR EACH ROW
WHEN (OLD.deleted AND NOT NEW.deleted)
EXECUTE FUNCTION public.open_restored_version_storage_lifetime();

-- ---------------------------------------------------------------------------
-- 2h. Ownership history is backend-controlled
-- ---------------------------------------------------------------------------
-- apps.created_at and apps.transfer_history now delimit billable ownership
-- segments (cron_stat_app accrues from them). Clients could edit both through
-- the console's apps writes (an owner moving created_at into the future would
-- stop all accrual). Only internal roles and transfer_app may change them; a
-- client insert gets the real creation time and an empty history.
CREATE OR REPLACE FUNCTION public.guard_apps_ownership_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF public.is_internal_request_role(public.current_request_role())
    OR pg_catalog.current_setting('capgo.allow_owner_org_transfer', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.now();
    NEW.transfer_history := '{}';
    RETURN NEW;
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.transfer_history IS DISTINCT FROM OLD.transfer_history THEN
    RAISE EXCEPTION 'APP_OWNERSHIP_HISTORY_CLIENT_WRITE_DENIED'
      USING ERRCODE = '42501',
        DETAIL = 'apps.created_at and apps.transfer_history are set by the backend and transfer_app().';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_apps_ownership_history() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_apps_ownership_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_apps_ownership_history() FROM anon, authenticated;

DROP TRIGGER IF EXISTS guard_apps_ownership_history ON public.apps;
CREATE TRIGGER guard_apps_ownership_history
BEFORE INSERT OR UPDATE OF created_at, transfer_history ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.guard_apps_ownership_history();

COMMIT;
