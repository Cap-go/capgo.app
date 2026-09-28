CREATE TABLE "public"."org_stats_refresh_state" (
  "org_id" uuid NOT NULL,
  "stats_updated_at" timestamp without time zone,
  "stats_refresh_requested_at" timestamp without time zone,
  CONSTRAINT "org_stats_refresh_state_pkey" PRIMARY KEY ("org_id"),
  CONSTRAINT "org_stats_refresh_state_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE CASCADE
);
ALTER TABLE "public"."org_stats_refresh_state" OWNER TO "postgres";
COMMENT ON TABLE "public"."org_stats_refresh_state" IS 'Primary-only watermark for producing org stats jobs after app refreshes settle.';

CREATE INDEX "app_stats_refresh_state_owner_org_updated_idx"
ON "public"."app_stats_refresh_state" ("owner_org", "stats_updated_at");

INSERT INTO "public"."org_stats_refresh_state" ("org_id", "stats_updated_at", "stats_refresh_requested_at")
SELECT "id", "stats_updated_at", "stats_updated_at" FROM "public"."orgs";

CREATE FUNCTION "public"."create_org_stats_refresh_state"()
RETURNS trigger LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
BEGIN
  INSERT INTO public.org_stats_refresh_state (org_id, stats_updated_at, stats_refresh_requested_at)
  VALUES (NEW.id, NEW.stats_updated_at, NEW.stats_updated_at);
  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."create_org_stats_refresh_state"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_org_stats_refresh_state"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_org_stats_refresh_state"() TO "service_role";

CREATE TRIGGER "create_org_stats_refresh_state" AFTER INSERT ON "public"."orgs"
FOR EACH ROW EXECUTE FUNCTION "public"."create_org_stats_refresh_state"();

ALTER TABLE "public"."org_stats_refresh_state" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."org_stats_refresh_state" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."org_stats_refresh_state" FROM "anon";
REVOKE ALL ON TABLE "public"."org_stats_refresh_state" FROM "authenticated";
GRANT ALL ON TABLE "public"."org_stats_refresh_state" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."queue_cron_stat_app_for_app"(
  "p_app_id" character varying, "p_org_id" uuid DEFAULT NULL::uuid)
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

  INSERT INTO public.org_stats_refresh_state (org_id, stats_updated_at, stats_refresh_requested_at)
  SELECT org.id, org.stats_updated_at, org.stats_updated_at
  FROM public.orgs org
  WHERE org.id = v_org_id
  ON CONFLICT ON CONSTRAINT org_stats_refresh_state_pkey DO NOTHING;

  PERFORM 1 FROM public.org_stats_refresh_state s
  WHERE s.org_id = v_org_id
  FOR UPDATE;

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
  ));
END;
$$;
ALTER FUNCTION "public"."queue_cron_stat_app_for_app"(character varying, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."queue_cron_stat_app_for_app"(character varying, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."queue_cron_stat_app_for_app"(character varying, uuid) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."queue_cron_stat_org_for_org"("org_id" uuid, "customer_id" text)
RETURNS void LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  v_now_utc timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  v_target_at timestamp without time zone;
BEGIN
  INSERT INTO public.org_stats_refresh_state (org_id, stats_updated_at, stats_refresh_requested_at)
  SELECT org.id, org.stats_updated_at, org.stats_updated_at
  FROM public.orgs org
  WHERE org.id = queue_cron_stat_org_for_org.org_id
  ON CONFLICT ON CONSTRAINT org_stats_refresh_state_pkey DO NOTHING;

  PERFORM 1 FROM public.org_stats_refresh_state s
  WHERE s.org_id = queue_cron_stat_org_for_org.org_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM pgmq.q_cron_stat_org queued_job
    WHERE queued_job.message->'payload'->>'orgId' = queue_cron_stat_org_for_org.org_id::text
  ) THEN
    RETURN;
  END IF;

  UPDATE public.org_stats_refresh_state state
  SET stats_refresh_requested_at = CASE
    WHEN state.stats_refresh_requested_at IS NULL
      OR state.stats_updated_at IS NOT NULL
      AND state.stats_refresh_requested_at <= state.stats_updated_at
      THEN v_now_utc
    ELSE state.stats_refresh_requested_at
  END
  WHERE state.org_id = queue_cron_stat_org_for_org.org_id
  RETURNING state.stats_refresh_requested_at INTO v_target_at;

  PERFORM pgmq.send('cron_stat_org', pg_catalog.jsonb_build_object(
    'function_name', 'cron_stat_org',
    'function_type', 'cloudflare',
    'payload', pg_catalog.jsonb_build_object(
      'orgId', queue_cron_stat_org_for_org.org_id,
      'customerId', queue_cron_stat_org_for_org.customer_id,
      'statsTargetAt', v_target_at
    )
  ));
END;
$$;
ALTER FUNCTION "public"."queue_cron_stat_org_for_org"(uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."queue_cron_stat_org_for_org"(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."queue_cron_stat_org_for_org"(uuid, text) TO "service_role";

CREATE FUNCTION "public"."mark_org_stats_refreshed"(
  "p_org_id" uuid, "p_stats_target_at" timestamp without time zone DEFAULT NULL)
RETURNS timestamp without time zone LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  v_now_utc timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  v_target_at timestamp without time zone;
BEGIN
  INSERT INTO public.org_stats_refresh_state (org_id, stats_updated_at, stats_refresh_requested_at)
  SELECT org.id, org.stats_updated_at, org.stats_updated_at
  FROM public.orgs org
  WHERE org.id = p_org_id
  ON CONFLICT ON CONSTRAINT org_stats_refresh_state_pkey DO NOTHING;

  SELECT CASE
    WHEN p_stats_target_at IS NOT NULL THEN p_stats_target_at
    WHEN state.stats_refresh_requested_at IS NOT NULL
      AND (state.stats_updated_at IS NULL OR state.stats_refresh_requested_at > state.stats_updated_at)
      THEN state.stats_refresh_requested_at
    ELSE v_now_utc
  END
  INTO v_target_at
  FROM public.org_stats_refresh_state state
  WHERE state.org_id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.org_stats_refresh_state state
  SET stats_updated_at = GREATEST(COALESCE(state.stats_updated_at, v_target_at), v_target_at),
      stats_refresh_requested_at = GREATEST(COALESCE(state.stats_refresh_requested_at, v_target_at), v_target_at)
  WHERE state.org_id = p_org_id;

  UPDATE public.orgs org
  SET last_stats_updated_at = org.stats_updated_at,
      stats_updated_at = v_target_at
  WHERE org.id = p_org_id
    AND (org.stats_updated_at IS NULL OR org.stats_updated_at < v_target_at);

  RETURN v_target_at;
END;
$$;
ALTER FUNCTION "public"."mark_org_stats_refreshed"(uuid, timestamp without time zone) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."mark_org_stats_refreshed"(uuid, timestamp without time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."mark_org_stats_refreshed"(uuid, timestamp without time zone) TO "service_role";

CREATE FUNCTION "public"."process_cron_stat_org_jobs"(
  "p_batch_size" integer DEFAULT 500,
  "p_org_id" uuid DEFAULT NULL::uuid)
RETURNS integer LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  org_record record;
  v_completed_at timestamp without time zone;
  v_org_requested_at timestamp without time zone;
  v_org_updated_at timestamp without time zone;
  v_queued integer := 0;
  v_batch_size integer := LEAST(GREATEST(COALESCE(p_batch_size, 500), 1), 1000);
BEGIN
  FOR org_record IN
    SELECT state.org_id, org.customer_id
    FROM public.org_stats_refresh_state state
    JOIN public.orgs org ON org.id = state.org_id
    WHERE (p_org_id IS NULL OR state.org_id = p_org_id)
      AND NOT EXISTS (
        SELECT 1 FROM pgmq.q_cron_stat_org queued_job
        WHERE queued_job.message->'payload'->>'orgId' = state.org_id::text
      )
      AND (
        state.stats_refresh_requested_at IS NOT NULL
          AND (state.stats_updated_at IS NULL OR state.stats_refresh_requested_at > state.stats_updated_at)
        OR (
          (state.stats_refresh_requested_at IS NULL OR state.stats_refresh_requested_at <= state.stats_updated_at)
          AND EXISTS (
            SELECT 1 FROM public.app_stats_refresh_state completed
            WHERE completed.owner_org = state.org_id
              AND completed.stats_updated_at IS NOT NULL
              AND (state.stats_updated_at IS NULL OR completed.stats_updated_at > state.stats_updated_at)
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.app_stats_refresh_state pending
            WHERE pending.owner_org = state.org_id
              AND pending.stats_refresh_requested_at IS NOT NULL
              AND (state.stats_updated_at IS NULL OR pending.stats_refresh_requested_at >= state.stats_updated_at)
              AND (pending.stats_updated_at IS NULL OR pending.stats_updated_at < pending.stats_refresh_requested_at)
          )
        )
      )
    ORDER BY state.org_id
    LIMIT v_batch_size
    FOR UPDATE OF state SKIP LOCKED
  LOOP
    SELECT state.stats_refresh_requested_at, state.stats_updated_at
    INTO v_org_requested_at, v_org_updated_at
    FROM public.org_stats_refresh_state state
    WHERE state.org_id = org_record.org_id;

    IF v_org_requested_at IS NOT NULL
      AND (v_org_updated_at IS NULL OR v_org_requested_at > v_org_updated_at) THEN
      PERFORM public.queue_cron_stat_org_for_org(org_record.org_id, org_record.customer_id);
      v_queued := v_queued + 1;
      CONTINUE;
    END IF;

    SELECT pg_catalog.max(app_state.stats_updated_at)
    INTO v_completed_at
    FROM public.app_stats_refresh_state app_state
    WHERE app_state.owner_org = org_record.org_id
      AND app_state.stats_updated_at IS NOT NULL
      AND (v_org_updated_at IS NULL OR app_state.stats_updated_at > v_org_updated_at);

    IF v_completed_at IS NULL OR EXISTS (
      SELECT 1
      FROM public.app_stats_refresh_state pending
      WHERE pending.owner_org = org_record.org_id
        AND pending.stats_refresh_requested_at IS NOT NULL
        AND (v_org_updated_at IS NULL OR pending.stats_refresh_requested_at >= v_org_updated_at)
        AND (pending.stats_updated_at IS NULL OR pending.stats_updated_at < pending.stats_refresh_requested_at)
    ) OR EXISTS (
      SELECT 1 FROM pgmq.q_cron_stat_org queued_job
      WHERE queued_job.message->'payload'->>'orgId' = org_record.org_id::text
    ) THEN
      CONTINUE;
    END IF;

    UPDATE public.org_stats_refresh_state
    SET stats_refresh_requested_at = v_completed_at
    WHERE org_id = org_record.org_id;

    PERFORM public.queue_cron_stat_org_for_org(org_record.org_id, org_record.customer_id);
    v_queued := v_queued + 1;
  END LOOP;

  RETURN v_queued;
END;
$$;
ALTER FUNCTION "public"."process_cron_stat_org_jobs"(integer, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."process_cron_stat_org_jobs"(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."process_cron_stat_org_jobs"(integer, uuid) TO "service_role";

INSERT INTO public.cron_tasks (
  name, description, task_type, target, minute_interval, run_at_second, enabled
) VALUES (
  'produce_org_stats_jobs', 'Queue org stats after all requested app stats have finished',
  'function', 'public.process_cron_stat_org_jobs()', 1, 0, true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, task_type = EXCLUDED.task_type, target = EXCLUDED.target,
  second_interval = NULL, minute_interval = EXCLUDED.minute_interval, hour_interval = NULL,
  run_at_hour = NULL, run_at_minute = NULL, run_at_second = EXCLUDED.run_at_second,
  run_on_dow = NULL, run_on_day = NULL, enabled = EXCLUDED.enabled,
  updated_at = pg_catalog.now();
