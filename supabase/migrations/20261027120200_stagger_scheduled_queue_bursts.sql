-- The daily sync_sub_jobs run (~8,000 orgs at 04:00 UTC) and the 6-hourly
-- stats_jobs run (~2,500 apps) pushed their whole batch as visible messages
-- at once. Consumers drain cron_sync_sub at ~85/min and cron_stat_app at
-- ~45/min, so the tail of each burst sat visible and unread for over an hour
-- and /queue_health reported never_read_stale (503) on every run, hiding real
-- stalls behind a daily false alarm.
-- Release each burst with pgmq delays at a rate below what consumers drain,
-- so a message only becomes visible when a consumer can take it. A visible
-- unread message then means consumers really are behind.

CREATE OR REPLACE FUNCTION "public"."process_cron_sync_sub_jobs"()
RETURNS void
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  org_record RECORD;
  -- per_minute_queues drains up to 100/min; release 60/min to keep headroom.
  v_per_minute CONSTANT integer := 60;
  v_index integer := 0;
BEGIN
  FOR org_record IN
    SELECT DISTINCT
      o.id,
      si.customer_id
    FROM public.orgs AS o
    INNER JOIN public.stripe_info AS si ON o.customer_id = si.customer_id
    WHERE o.customer_id IS NOT NULL
      AND si.customer_id IS NOT NULL
  LOOP
    PERFORM pgmq.send(
      'cron_sync_sub',
      pg_catalog.jsonb_build_object(
        'function_name', 'cron_sync_sub',
        'function_type', NULL,
        'payload', pg_catalog.jsonb_build_object(
          'orgId', org_record.id,
          'customerId', org_record.customer_id
        )
      ),
      (v_index / v_per_minute) * 60
    );
    v_index := v_index + 1;
  END LOOP;
END;
$$;

-- A new trailing parameter would leave the 2-argument signature callable and
-- make 2-argument calls ambiguous, so replace the function instead.
DROP FUNCTION IF EXISTS "public"."queue_cron_stat_app_for_app"(character varying, uuid);

CREATE FUNCTION "public"."queue_cron_stat_app_for_app"(
  "p_app_id" character varying,
  "p_org_id" uuid DEFAULT NULL::uuid,
  "p_delay_seconds" integer DEFAULT 0
)
RETURNS void LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  v_org_id uuid;
  v_queued_org_id uuid;
  v_now_utc timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  v_refresh_ttl CONSTANT interval := INTERVAL '5 minutes';
BEGIN
  IF p_app_id IS NULL OR p_app_id = '' THEN
    RETURN;
  END IF;

  SELECT a.owner_org INTO v_org_id
  FROM public.apps a
  WHERE a.app_id = p_app_id
    AND (p_org_id IS NULL OR a.owner_org = p_org_id);
  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.org_stats_refresh_state (org_id)
  VALUES (v_org_id)
  ON CONFLICT ON CONSTRAINT org_stats_refresh_state_pkey DO NOTHING;

  PERFORM 1 FROM public.org_stats_refresh_state s
  WHERE s.org_id = v_org_id
  FOR UPDATE;

  -- An immediate refresh must not wait behind a job still parked in a
  -- staggered stats_jobs slot: make it readable now. This runs before the
  -- request TTL, which stats_jobs itself just stamped when it parked the job.
  -- Rows already read are in flight and keep their visibility timeout.
  IF p_delay_seconds <= 0 THEN
    UPDATE pgmq.q_cron_stat_app queued_job
    SET vt = pg_catalog.clock_timestamp()
    WHERE queued_job.message->'payload'->>'appId' = p_app_id
      AND queued_job.read_ct = 0
      AND queued_job.vt > pg_catalog.clock_timestamp();
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.app_stats_refresh_state (app_id, owner_org, stats_refresh_requested_at)
  SELECT a.app_id, a.owner_org, v_now_utc
  FROM public.apps a
  LEFT JOIN public.app_stats_refresh_state s ON s.app_id = a.app_id
  WHERE a.app_id = p_app_id
    AND a.owner_org = v_org_id
    AND (s.stats_updated_at IS NULL OR s.stats_updated_at < v_now_utc - v_refresh_ttl)
    AND (s.stats_refresh_requested_at IS NULL OR s.stats_refresh_requested_at < v_now_utc - v_refresh_ttl)
  ON CONFLICT (app_id) DO UPDATE
  SET owner_org = EXCLUDED.owner_org,
      stats_refresh_requested_at = EXCLUDED.stats_refresh_requested_at
  WHERE (app_stats_refresh_state.stats_updated_at IS NULL
      OR app_stats_refresh_state.stats_updated_at < v_now_utc - v_refresh_ttl)
    AND (app_stats_refresh_state.stats_refresh_requested_at IS NULL
      OR app_stats_refresh_state.stats_refresh_requested_at < v_now_utc - v_refresh_ttl)
  RETURNING owner_org INTO v_queued_org_id;

  IF v_queued_org_id IS NULL OR EXISTS (
    SELECT 1 FROM pgmq.q_cron_stat_app queued_job
    WHERE queued_job.message->'payload'->>'appId' = p_app_id
  ) THEN
    RETURN;
  END IF;

  PERFORM pgmq.send('cron_stat_app', pg_catalog.jsonb_build_object(
    'function_name', 'cron_stat_app',
    'function_type', 'cloudflare',
    'payload', pg_catalog.jsonb_build_object(
      'appId', p_app_id,
      'orgId', v_queued_org_id,
      'todayOnly', false
    )
  ), GREATEST(p_delay_seconds, 0));
END;
$$;
ALTER FUNCTION "public"."queue_cron_stat_app_for_app"(character varying, uuid, integer) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."queue_cron_stat_app_for_app"(character varying, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."queue_cron_stat_app_for_app"(character varying, uuid, integer) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."process_cron_stats_jobs"()
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
    )
    SELECT DISTINCT
      active_apps.app_id,
      a.owner_org
    FROM active_apps
    INNER JOIN public.apps a ON a.app_id = active_apps.app_id
  )
  LOOP
    PERFORM public.queue_cron_stat_app_for_app(
      app_record.app_id,
      app_record.owner_org,
      (v_index / v_per_minute) * 60
    );
    v_index := v_index + 1;
  END LOOP;
END;
$$;
