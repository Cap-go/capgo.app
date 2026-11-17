-- Stats and rollout crons: less database and Analytics Engine load.
--
-- 1. queue_cron_stat_app_for_app and process_cron_stat_org_jobs look up a
--    queued job by its payload id. Without an index that scans the whole
--    queue table, and process_cron_stats_jobs calls it once per active app
--    (~2,500 apps while up to ~2,500 messages are queued), so a 6-hourly run
--    cost O(apps x queued messages). Index the exact expressions they filter on.
CREATE INDEX IF NOT EXISTS "q_cron_stat_app_payload_app_id_idx"
ON "pgmq"."q_cron_stat_app" (((message -> 'payload') ->> 'appId'));

CREATE INDEX IF NOT EXISTS "q_cron_stat_org_payload_org_id_idx"
ON "pgmq"."q_cron_stat_org" (((message -> 'payload') ->> 'orgId'));

-- 2. The stats producer now works on the whole set of active apps at once:
--    one upsert of app_stats_refresh_state, one indexed anti-join against the
--    queue, and one pgmq.send_batch per stagger minute, instead of one
--    queue_cron_stat_app_for_app call (several statements) per app. Same
--    rules as that function for a delayed job: the 5-minute request TTL, the
--    org rows locked (in org_id order, so concurrent callers cannot deadlock),
--    no second message for an app already queued, and the same message.
CREATE OR REPLACE FUNCTION "public"."process_cron_stats_jobs"()
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

ALTER FUNCTION "public"."process_cron_stats_jobs"() OWNER TO "postgres";

-- 3. cron_stat_app makes 4 Analytics Engine SQL API calls per app, not the 3
--    20261026223238_cron_stat_app_cf_api_budget.sql assumed: device_usage
--    (MAU), bandwidth_usage, version_usage and the app_log legacy
--    download_fail correction of version usage. At batch_size 5 (up to 10
--    consumer calls per minute, 50 apps) that was 200 calls per minute, i.e.
--    1,000 of the token's 1,200 requests per 5 minutes, with no room for
--    dashboards or rollout auto-pause on the same token.
--    Apps cannot share a query: Analytics Engine samples a multi-app query at
--    the rate of its biggest app, which changes the smaller apps' MAU.
--    batch_size 3 gives at most 30 apps (120 calls) per minute, i.e. 600 per
--    5 minutes, half of the limit. A 6-hourly run of ~2,500 apps drains in
--    about 100 minutes at the 25/min release rate set above.
UPDATE public.cron_tasks
SET
    batch_size = 3,
    description = 'Consume up to 10 batches of 3 apps per minute (30 apps, '
    || '120 Analytics Engine queries) to stay under the Cloudflare API limit',
    updated_at = pg_catalog.now()
WHERE name = 'stat_app_queue';

-- 4. cron_rollout_auto_pause checks at most 500 channels per run, oldest first.
--    A channel whose Analytics Engine read fails is not evaluated and keeps its
--    auto_pause_last_checked_at (the public channel API reports it as the last
--    real check). Its failed attempt is recorded here instead, and the cron
--    orders by the later of the two, so apps whose reads keep failing move
--    behind the others instead of using up every run's time budget.
--    Internal cron state: not replicated, no direct client access.
CREATE TABLE IF NOT EXISTS "public"."channel_auto_pause_attempts" (
    "channel_id" bigint PRIMARY KEY
    REFERENCES "public"."channels" ("id") ON DELETE CASCADE,
    "failed_at" timestamp with time zone NOT NULL
);

ALTER TABLE "public"."channel_auto_pause_attempts" OWNER TO "postgres";
ALTER TABLE "public"."channel_auto_pause_attempts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deny all direct access"
ON "public"."channel_auto_pause_attempts"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);

REVOKE ALL ON TABLE "public"."channel_auto_pause_attempts" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."channel_auto_pause_attempts" FROM "anon";
REVOKE ALL ON TABLE "public"."channel_auto_pause_attempts" FROM "authenticated";
GRANT ALL ON TABLE "public"."channel_auto_pause_attempts" TO "service_role";
