ALTER TABLE "public"."org_stats_refresh_state"
ADD COLUMN "manual_refresh_requested_at" timestamp without time zone;

COMMENT ON COLUMN "public"."org_stats_refresh_state"."manual_refresh_requested_at"
IS 'User-visible start time for a manual dashboard refresh. This is separate from stats_refresh_requested_at, which is the org-job coordinator target.';

UPDATE "public"."org_stats_refresh_state" state
SET "manual_refresh_requested_at" = org."stats_refresh_requested_at"
FROM "public"."orgs" org
WHERE org."id" = state."org_id";

CREATE OR REPLACE FUNCTION "public"."create_org_stats_refresh_state"()
RETURNS trigger LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
BEGIN
  INSERT INTO public.org_stats_refresh_state (org_id)
  VALUES (NEW.id);
  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."create_org_stats_refresh_state"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_org_stats_refresh_state"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_org_stats_refresh_state"() TO "service_role";

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

  INSERT INTO public.org_stats_refresh_state (org_id)
  VALUES (v_org_id)
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
  INSERT INTO public.org_stats_refresh_state (org_id)
  SELECT org.id
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

CREATE OR REPLACE FUNCTION "public"."mark_org_stats_refreshed"(
  "p_org_id" uuid, "p_stats_target_at" timestamp without time zone DEFAULT NULL)
RETURNS timestamp without time zone LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  v_now_utc timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  v_target_at timestamp without time zone;
BEGIN
  INSERT INTO public.org_stats_refresh_state (org_id)
  SELECT org.id
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

  RETURN v_target_at;
END;
$$;
ALTER FUNCTION "public"."mark_org_stats_refreshed"(uuid, timestamp without time zone) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."mark_org_stats_refreshed"(uuid, timestamp without time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."mark_org_stats_refreshed"(uuid, timestamp without time zone) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."request_org_chart_refresh"("org_id" uuid)
RETURNS TABLE("requested_at" timestamp without time zone, "queued_app_ids" character varying[],
  "queued_count" integer, "skipped_count" integer)
LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  v_request_started_at timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  v_queued_app_ids character varying[] := ARRAY[]::character varying[];
  v_queued_count integer := 0;
  v_total_count integer := 0;
  v_org_requested_at_before timestamp without time zone;
  v_before_requested_at timestamp without time zone;
  v_after_requested_at timestamp without time zone;
  app_record record;
BEGIN
  IF request_org_chart_refresh.org_id IS NULL THEN
    RAISE EXCEPTION 'Org ID is required';
  END IF;

  PERFORM 1
  FROM public.orgs o
  WHERE o.id = request_org_chart_refresh.org_id;
  IF NOT FOUND THEN
    IF public.is_internal_request_role(public.current_request_role()) THEN
      RAISE EXCEPTION 'Organization not found';
    END IF;
    RAISE EXCEPTION 'Organization access denied';
  END IF;

  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_org_read(),
      request_org_chart_refresh.org_id,
      NULL::character varying,
      NULL::bigint
    )
  THEN
    RAISE EXCEPTION 'Organization access denied';
  END IF;

  INSERT INTO public.org_stats_refresh_state (org_id)
  VALUES (request_org_chart_refresh.org_id)
  ON CONFLICT ON CONSTRAINT org_stats_refresh_state_pkey DO NOTHING;

  SELECT GREATEST(state.manual_refresh_requested_at, state.stats_refresh_requested_at)
  INTO v_org_requested_at_before
  FROM public.org_stats_refresh_state state
  WHERE state.org_id = request_org_chart_refresh.org_id;

  FOR app_record IN
    SELECT a.app_id, s.stats_refresh_requested_at
    FROM public.apps a
    LEFT JOIN public.app_stats_refresh_state s ON s.app_id = a.app_id
    WHERE a.owner_org = request_org_chart_refresh.org_id
    ORDER BY a.app_id
  LOOP
    v_total_count := v_total_count + 1;
    v_before_requested_at := app_record.stats_refresh_requested_at;
    PERFORM public.queue_cron_stat_app_for_app(app_record.app_id, request_org_chart_refresh.org_id);
    SELECT s.stats_refresh_requested_at
    INTO v_after_requested_at
    FROM public.app_stats_refresh_state s
    WHERE s.app_id = app_record.app_id;
    IF v_after_requested_at IS NOT NULL
      AND v_after_requested_at >= v_request_started_at
      AND (v_before_requested_at IS NULL OR v_after_requested_at IS DISTINCT FROM v_before_requested_at)
    THEN
      v_queued_count := v_queued_count + 1;
      v_queued_app_ids := pg_catalog.array_append(v_queued_app_ids, app_record.app_id);
    END IF;
  END LOOP;

  IF v_queued_count > 0 THEN
    UPDATE public.org_stats_refresh_state state
    SET manual_refresh_requested_at = GREATEST(
      COALESCE(state.manual_refresh_requested_at, v_request_started_at),
      v_request_started_at
    )
    WHERE state.org_id = request_org_chart_refresh.org_id
    RETURNING state.manual_refresh_requested_at INTO requested_at;
  ELSE
    requested_at := v_org_requested_at_before;
  END IF;

  queued_app_ids := COALESCE(v_queued_app_ids, ARRAY[]::character varying[]);
  queued_count := v_queued_count;
  skipped_count := GREATEST(v_total_count - v_queued_count, 0);
  RETURN NEXT;
END;
$$;
ALTER FUNCTION "public"."request_org_chart_refresh"(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."request_org_chart_refresh"(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."request_org_chart_refresh"(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."request_org_chart_refresh"(uuid) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_org_stats_refresh_state"("p_org_id" uuid)
RETURNS TABLE("stats_updated_at" timestamp without time zone,
  "stats_refresh_requested_at" timestamp without time zone)
LANGUAGE "sql" SECURITY DEFINER ROWS 1 SET "search_path" TO '' AS $$
  SELECT
    state.stats_updated_at,
    GREATEST(state.manual_refresh_requested_at, state.stats_refresh_requested_at)
  FROM public.org_stats_refresh_state state
  WHERE state.org_id = p_org_id
    AND public.rbac_check_permission_request(
      public.rbac_perm_org_read(), state.org_id, NULL::character varying, NULL::bigint
    );
$$;
ALTER FUNCTION "public"."get_org_stats_refresh_state"(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_org_stats_refresh_state"(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."get_org_stats_refresh_state"(uuid) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."get_org_stats_refresh_state"(uuid) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."get_app_metrics"(
  "org_id" uuid, "start_date" date, "end_date" date)
RETURNS TABLE("app_id" character varying, "date" date, "mau" bigint, "storage" bigint,
  "bandwidth" bigint, "build_time_unit" bigint, "get" bigint, "fail" bigint,
  "install" bigint, "uninstall" bigint)
LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  cache_entry public.app_metrics_cache%ROWTYPE;
  org_stats_updated_at timestamp without time zone;
  v_cache_ttl CONSTANT interval := INTERVAL '5 minutes';
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_org_read(),
      get_app_metrics.org_id,
      NULL::character varying,
      NULL::bigint
    )
  THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.orgs WHERE orgs.id = get_app_metrics.org_id) THEN
    RETURN;
  END IF;

  SELECT state.stats_updated_at
  INTO org_stats_updated_at
  FROM public.org_stats_refresh_state state
  WHERE state.org_id = get_app_metrics.org_id;

  SELECT *
  INTO cache_entry
  FROM public.app_metrics_cache
  WHERE app_metrics_cache.org_id = get_app_metrics.org_id;

  IF cache_entry.id IS NULL
    OR cache_entry.start_date IS DISTINCT FROM get_app_metrics.start_date
    OR cache_entry.end_date IS DISTINCT FROM get_app_metrics.end_date
    OR cache_entry.cached_at IS NULL
    OR cache_entry.cached_at < (pg_catalog.now() - v_cache_ttl)
    OR (
      org_stats_updated_at IS NOT NULL
      AND pg_catalog.timezone('UTC', cache_entry.cached_at) < org_stats_updated_at
    ) THEN
    cache_entry := public.seed_get_app_metrics_caches(
      get_app_metrics.org_id,
      get_app_metrics.start_date,
      get_app_metrics.end_date
    );
  END IF;

  IF cache_entry.response IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    metrics.app_id,
    metrics.date,
    metrics.mau,
    metrics.storage,
    metrics.bandwidth,
    metrics.build_time_unit,
    metrics.get,
    metrics.fail,
    metrics.install,
    metrics.uninstall
  FROM pg_catalog.jsonb_to_recordset(cache_entry.response) AS metrics(
    app_id character varying,
    date date,
    mau bigint,
    storage bigint,
    bandwidth bigint,
    build_time_unit bigint,
    get bigint,
    fail bigint,
    install bigint,
    uninstall bigint
  )
  ORDER BY metrics.app_id, metrics.date;
END;
$$;
ALTER FUNCTION "public"."get_app_metrics"(uuid, date, date) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_app_metrics"(
  "p_org_id" uuid, "p_app_id" character varying, "p_start_date" date, "p_end_date" date)
RETURNS TABLE("app_id" character varying, "date" date, "mau" bigint, "storage" bigint,
  "bandwidth" bigint, "build_time_unit" bigint, "get" bigint, "fail" bigint,
  "install" bigint, "uninstall" bigint)
LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  cache_entry public.app_metrics_cache%ROWTYPE;
  org_stats_updated_at timestamp without time zone;
  v_cache_ttl CONSTANT interval := INTERVAL '5 minutes';
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_app_read(),
      get_app_metrics.p_org_id,
      get_app_metrics.p_app_id,
      NULL::bigint
    )
  THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.apps
    WHERE apps.app_id = get_app_metrics.p_app_id
      AND apps.owner_org = get_app_metrics.p_org_id
  ) THEN
    RETURN;
  END IF;

  SELECT state.stats_updated_at
  INTO org_stats_updated_at
  FROM public.org_stats_refresh_state state
  WHERE state.org_id = get_app_metrics.p_org_id;

  SELECT *
  INTO cache_entry
  FROM public.app_metrics_cache
  WHERE app_metrics_cache.org_id = get_app_metrics.p_org_id;

  IF cache_entry.id IS NULL
    OR cache_entry.start_date IS DISTINCT FROM get_app_metrics.p_start_date
    OR cache_entry.end_date IS DISTINCT FROM get_app_metrics.p_end_date
    OR cache_entry.cached_at IS NULL
    OR cache_entry.cached_at < (pg_catalog.now() - v_cache_ttl)
    OR (
      org_stats_updated_at IS NOT NULL
      AND pg_catalog.timezone('UTC', cache_entry.cached_at) < org_stats_updated_at
    ) THEN
    cache_entry := public.seed_get_app_metrics_caches(
      get_app_metrics.p_org_id,
      get_app_metrics.p_start_date,
      get_app_metrics.p_end_date
    );
  END IF;

  IF cache_entry.response IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    metrics.app_id,
    metrics.date,
    metrics.mau,
    metrics.storage,
    metrics.bandwidth,
    metrics.build_time_unit,
    metrics.get,
    metrics.fail,
    metrics.install,
    metrics.uninstall
  FROM pg_catalog.jsonb_to_recordset(cache_entry.response) AS metrics(
    app_id character varying,
    date date,
    mau bigint,
    storage bigint,
    bandwidth bigint,
    build_time_unit bigint,
    get bigint,
    fail bigint,
    install bigint,
    uninstall bigint
  )
  WHERE metrics.app_id = get_app_metrics.p_app_id
  ORDER BY metrics.date;
END;
$$;
ALTER FUNCTION "public"."get_app_metrics"(uuid, character varying, date, date) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_orgs_v7"("userid" uuid)
RETURNS TABLE("gid" uuid, "created_by" uuid, "created_at" timestamp with time zone,
  "logo" text, "website" text, "name" text, "role" character varying, "is_invite" boolean,
  "paying" boolean, "trial_left" integer, "can_use_more" boolean, "is_canceled" boolean,
  "app_count" bigint, "subscription_start" timestamp with time zone,
  "subscription_end" timestamp with time zone, "management_email" text, "is_yearly" boolean,
  "stats_updated_at" timestamp without time zone,
  "stats_refresh_requested_at" timestamp without time zone,
  "next_stats_update_at" timestamp with time zone, "credit_available" numeric,
  "credit_total" numeric, "credit_next_expiration" timestamp with time zone,
  "enforcing_2fa" boolean, "2fa_has_access" boolean, "enforce_hashed_api_keys" boolean,
  "password_policy_config" jsonb, "password_has_access" boolean,
  "require_apikey_expiration" boolean, "max_apikey_expiration_days" integer,
  "enforce_encrypted_bundles" boolean, "required_encryption_key" character varying)
LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
BEGIN
  RETURN QUERY
  WITH app_counts AS (
    SELECT owner_org, COUNT(*) AS cnt
    FROM public.apps
    GROUP BY owner_org
  ),
  rbac_role_candidates AS (
    SELECT rb.org_id, r.name, r.priority_rank
    FROM public.role_bindings rb
    JOIN public.roles r ON rb.role_id = r.id
      AND r.scope_type = rb.scope_type
      -- Hide non-assignable backfill roles from the public role label.
      AND r.is_assignable = true
    WHERE rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = userid
      AND rb.scope_type = public.rbac_scope_org()
      AND rb.org_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION ALL
    SELECT rb.org_id, r.name, r.priority_rank
    FROM public.role_bindings rb
    JOIN public.group_members gm ON gm.group_id = rb.principal_id
    JOIN public.roles r ON rb.role_id = r.id
      AND r.scope_type = rb.scope_type
      AND r.is_assignable = true
    WHERE rb.principal_type = public.rbac_principal_group()
      AND gm.user_id = userid
      AND rb.scope_type = public.rbac_scope_org()
      AND rb.org_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
  ),
  rbac_org_roles AS (
    SELECT org_id,
      (ARRAY_AGG(rbac_role_candidates.name ORDER BY rbac_role_candidates.priority_rank DESC))[1] AS role_name
    FROM rbac_role_candidates
    GROUP BY org_id
  ),
  rbac_org_ids AS (
    SELECT org_id
    FROM rbac_org_roles
    UNION
    SELECT apps.owner_org
    FROM public.role_bindings rb
    JOIN public.apps ON apps.id = rb.app_id
    WHERE rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = userid
      AND rb.app_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION
    SELECT apps.owner_org
    FROM public.role_bindings rb
    JOIN public.channels ch ON ch.rbac_id = rb.channel_id
    JOIN public.apps ON apps.app_id = ch.app_id
    WHERE rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = userid
      AND rb.channel_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION
    SELECT rb.org_id
    FROM public.role_bindings rb
    JOIN public.group_members gm ON gm.group_id = rb.principal_id
    WHERE rb.principal_type = public.rbac_principal_group()
      AND gm.user_id = userid
      AND rb.org_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION
    SELECT apps.owner_org
    FROM public.role_bindings rb
    JOIN public.group_members gm ON gm.group_id = rb.principal_id
    JOIN public.apps ON apps.id = rb.app_id
    WHERE rb.principal_type = public.rbac_principal_group()
      AND gm.user_id = userid
      AND rb.app_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION
    SELECT apps.owner_org
    FROM public.role_bindings rb
    JOIN public.group_members gm ON gm.group_id = rb.principal_id
    JOIN public.channels ch ON ch.rbac_id = rb.channel_id
    JOIN public.apps ON apps.app_id = ch.app_id
    WHERE rb.principal_type = public.rbac_principal_group()
      AND gm.user_id = userid
      AND rb.channel_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
  ),
  pending_invites AS (
    SELECT ou.org_id,
      COALESCE(ou.rbac_role_name, public.rbac_role_org_member()) AS role_name
    FROM public.org_users ou
    WHERE ou.user_id = userid
      AND ou.is_invite IS TRUE
  ),
  user_orgs AS (
    SELECT rbac_org_ids.org_id
    FROM rbac_org_ids
    WHERE rbac_org_ids.org_id IS NOT NULL
    UNION
    SELECT pending_invites.org_id
    FROM pending_invites
  ),
  time_constants AS (
    SELECT
      NOW() AS current_time,
      date_trunc('MONTH', NOW()) AS current_month_start,
      '0 DAYS'::INTERVAL AS zero_day_interval
  ),
  paying_orgs_ordered AS (
    SELECT
      o.id,
      ROW_NUMBER() OVER (ORDER BY o.id ASC) - 1 AS preceding_count
    FROM public.orgs o
    JOIN public.stripe_info si ON o.customer_id = si.customer_id
    CROSS JOIN time_constants tc
    WHERE (
      (si.status = 'succeeded'
        AND (si.canceled_at IS NULL OR si.canceled_at > tc.current_time)
        AND si.subscription_anchor_end > tc.current_time)
      OR si.trial_at > tc.current_time
    )
  ),
  billing_cycles AS (
    SELECT
      o.id AS org_id,
      CASE
        WHEN COALESCE(
          si.subscription_anchor_start - date_trunc('MONTH', si.subscription_anchor_start),
          tc.zero_day_interval
        ) > tc.current_time - tc.current_month_start
        THEN date_trunc('MONTH', tc.current_time - INTERVAL '1 MONTH')
          + COALESCE(
            si.subscription_anchor_start - date_trunc('MONTH', si.subscription_anchor_start),
            tc.zero_day_interval
          )
        ELSE tc.current_month_start
          + COALESCE(
            si.subscription_anchor_start - date_trunc('MONTH', si.subscription_anchor_start),
            tc.zero_day_interval
          )
      END AS cycle_start
    FROM public.orgs o
    CROSS JOIN time_constants tc
    LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
  ),
  two_fa_access AS (
    SELECT
      o.id AS org_id,
      o.enforcing_2fa,
      CASE
        WHEN o.enforcing_2fa = false THEN true
        ELSE public.has_2fa_enabled(userid)
      END AS "2fa_has_access",
      (o.enforcing_2fa = true AND NOT public.has_2fa_enabled(userid)) AS should_redact_2fa
    FROM public.orgs o
    JOIN user_orgs uo ON uo.org_id = o.id
  ),
  password_policy_access AS (
    SELECT
      o.id AS org_id,
      o.password_policy_config,
      public.user_meets_password_policy(userid, o.id) AS password_has_access,
      NOT public.user_meets_password_policy(userid, o.id) AS should_redact_password
    FROM public.orgs o
    JOIN user_orgs uo ON uo.org_id = o.id
  ),
  billing_access AS (
    SELECT
      o.id AS org_id,
      NOT public.rbac_check_permission_direct(
        public.rbac_perm_org_read_billing(),
        userid,
        o.id,
        NULL::character varying,
        NULL::bigint,
        public.get_apikey_header()
      ) AS should_redact_billing
    FROM public.orgs o
    JOIN user_orgs uo ON uo.org_id = o.id
  )
  SELECT
    o.id AS gid,
    o.created_by,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password THEN NULL::timestamptz
      ELSE o.created_at
    END AS created_at,
    o.logo,
    o.website,
    o.name,
    COALESCE(
      pi.role_name::varchar,
      ror.role_name::varchar,
      public.rbac_role_org_member()::varchar
    ) AS role,
    (pi.org_id IS NOT NULL) AS is_invite,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN false
      ELSE COALESCE(si.status = 'succeeded', false)
    END AS paying,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN 0
      ELSE GREATEST(COALESCE((si.trial_at::date - NOW()::date), 0), 0)::integer
    END AS trial_left,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN false
      ELSE COALESCE((si.status = 'succeeded' AND si.is_good_plan = true)
        OR (si.trial_at::date - NOW()::date > 0)
        OR COALESCE(ucb.available_credits, 0) > 0, false)
    END AS can_use_more,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN false
      ELSE COALESCE(si.status = 'canceled', false)
    END AS is_canceled,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password THEN 0::bigint
      ELSE COALESCE(ac.cnt, 0)
    END AS app_count,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::timestamptz
      ELSE bc.cycle_start
    END AS subscription_start,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::timestamptz
      ELSE (bc.cycle_start + INTERVAL '1 MONTH')
    END AS subscription_end,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::text
      ELSE o.management_email
    END AS management_email,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN false
      ELSE COALESCE(si.price_id = p.price_y_id, false)
    END AS is_yearly,
    CASE
      WHEN refresh_state.org_id IS NULL THEN o.stats_updated_at
      ELSE refresh_state.stats_updated_at
    END AS stats_updated_at,
    CASE
      WHEN refresh_state.org_id IS NULL THEN o.stats_refresh_requested_at
      ELSE GREATEST(
        refresh_state.manual_refresh_requested_at,
        refresh_state.stats_refresh_requested_at
      )
    END AS stats_refresh_requested_at,
    CASE
      WHEN COALESCE(billing_acc.should_redact_billing, true) THEN NULL::timestamptz
      WHEN poo.id IS NOT NULL THEN
        public.get_next_cron_time('0 3 * * *', NOW())
          + make_interval(mins => poo.preceding_count::int * 4)
      ELSE NULL
    END AS next_stats_update_at,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::numeric
      ELSE COALESCE(ucb.available_credits, 0)
    END AS credit_available,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::numeric
      ELSE COALESCE(ucb.total_credits, 0)
    END AS credit_total,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::timestamptz
      ELSE ucb.next_expiration
    END AS credit_next_expiration,
    tfa.enforcing_2fa,
    tfa."2fa_has_access",
    o.enforce_hashed_api_keys,
    ppa.password_policy_config,
    ppa.password_has_access,
    o.require_apikey_expiration,
    o.max_apikey_expiration_days,
    o.enforce_encrypted_bundles,
    o.required_encryption_key
  FROM public.orgs o
  JOIN user_orgs uo ON uo.org_id = o.id
  LEFT JOIN pending_invites pi ON pi.org_id = o.id
  LEFT JOIN rbac_org_roles ror ON ror.org_id = o.id
  LEFT JOIN two_fa_access tfa ON tfa.org_id = o.id
  LEFT JOIN password_policy_access ppa ON ppa.org_id = o.id
  LEFT JOIN billing_access billing_acc ON billing_acc.org_id = o.id
  LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
  LEFT JOIN public.plans p ON si.product_id = p.stripe_id
  LEFT JOIN app_counts ac ON ac.owner_org = o.id
  LEFT JOIN public.usage_credit_balances ucb ON ucb.org_id = o.id
  LEFT JOIN paying_orgs_ordered poo ON poo.id = o.id
  LEFT JOIN billing_cycles bc ON bc.org_id = o.id
  LEFT JOIN public.org_stats_refresh_state refresh_state ON refresh_state.org_id = o.id;
END;
$$;
ALTER FUNCTION "public"."get_orgs_v7"(uuid) OWNER TO "postgres";
COMMENT ON FUNCTION "public"."get_orgs_v7"(uuid)
IS 'Org membership list for a user. Billing/plan/credit fields are null/false when the user lacks org.read_billing for that org.';
