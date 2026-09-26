CREATE TABLE "public"."app_stats_refresh_state" (
  "app_id" character varying NOT NULL,
  "owner_org" uuid NOT NULL,
  "stats_updated_at" timestamp without time zone,
  "stats_refresh_requested_at" timestamp without time zone,
  CONSTRAINT "app_stats_refresh_state_pkey" PRIMARY KEY ("app_id"),
  CONSTRAINT "app_stats_refresh_state_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("app_id") ON DELETE CASCADE,
  CONSTRAINT "app_stats_refresh_state_owner_org_fkey" FOREIGN KEY ("owner_org") REFERENCES "public"."orgs"("id") ON DELETE CASCADE
);
ALTER TABLE "public"."app_stats_refresh_state" OWNER TO "postgres";
COMMENT ON TABLE "public"."app_stats_refresh_state" IS 'Primary-only app stats refresh coordination state. Intentionally excluded from the Google read-replica publication.';

CREATE INDEX "app_stats_refresh_state_owner_org_requested_idx" ON "public"."app_stats_refresh_state" ("owner_org", "stats_refresh_requested_at");
INSERT INTO "public"."app_stats_refresh_state" ("app_id", "owner_org", "stats_updated_at", "stats_refresh_requested_at")
SELECT "app_id", "owner_org", "stats_updated_at", "stats_refresh_requested_at" FROM "public"."apps";
CREATE FUNCTION "public"."create_app_stats_refresh_state"()
RETURNS trigger LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
BEGIN
  INSERT INTO public.app_stats_refresh_state (app_id, owner_org)
  VALUES (NEW.app_id, NEW.owner_org);
  RETURN NEW;
END;
$$;
ALTER FUNCTION "public"."create_app_stats_refresh_state"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."create_app_stats_refresh_state"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_app_stats_refresh_state"() TO "service_role";

CREATE TRIGGER "create_app_stats_refresh_state" AFTER INSERT ON "public"."apps"
FOR EACH ROW EXECUTE FUNCTION "public"."create_app_stats_refresh_state"();

ALTER TABLE "public"."app_stats_refresh_state" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."app_stats_refresh_state" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."app_stats_refresh_state" FROM "anon";
REVOKE ALL ON TABLE "public"."app_stats_refresh_state" FROM "authenticated";
GRANT ALL ON TABLE "public"."app_stats_refresh_state" TO "service_role";

CREATE FUNCTION "public"."get_app_stats_refresh_state"("p_app_id" character varying)
RETURNS TABLE("owner_org" uuid, "stats_updated_at" timestamp without time zone,
  "stats_refresh_requested_at" timestamp without time zone)
LANGUAGE "sql" SECURITY DEFINER ROWS 1 SET "search_path" TO '' AS $$
  SELECT s.owner_org, s.stats_updated_at, s.stats_refresh_requested_at
  FROM public.app_stats_refresh_state s
  WHERE s.app_id = p_app_id
    AND public.rbac_check_permission_request(
      public.rbac_perm_app_read(), s.owner_org, s.app_id, NULL::bigint
    );
$$;
ALTER FUNCTION "public"."get_app_stats_refresh_state"(character varying) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."get_app_stats_refresh_state"(character varying) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."get_app_stats_refresh_state"(character varying) TO "authenticated";

CREATE OR REPLACE FUNCTION "public"."mark_app_stats_refreshed"("p_app_id" character varying)
RETURNS timestamp without time zone LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO '' AS $$
DECLARE
  v_now_utc timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
BEGIN
  IF p_app_id IS NULL OR p_app_id = '' THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.app_stats_refresh_state (app_id, owner_org, stats_updated_at)
  SELECT a.app_id, a.owner_org, v_now_utc
  FROM public.apps a
  WHERE a.app_id = p_app_id
  ON CONFLICT (app_id) DO UPDATE
  SET owner_org = EXCLUDED.owner_org,
      stats_updated_at = EXCLUDED.stats_updated_at;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN v_now_utc;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."queue_cron_stat_app_for_app"(
  "p_app_id" character varying, "p_org_id" uuid DEFAULT NULL::uuid)
RETURNS void LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  v_org_id uuid;
  v_now_utc timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  v_refresh_ttl CONSTANT interval := INTERVAL '5 minutes';
BEGIN
  IF p_app_id IS NULL OR p_app_id = '' THEN
    RETURN;
  END IF;
  INSERT INTO public.app_stats_refresh_state (app_id, owner_org, stats_refresh_requested_at)
  SELECT a.app_id, a.owner_org, v_now_utc
  FROM public.apps a
  LEFT JOIN public.app_stats_refresh_state s ON s.app_id = a.app_id
  WHERE a.app_id = p_app_id
    AND (p_org_id IS NULL OR a.owner_org = p_org_id)
    AND (s.stats_updated_at IS NULL OR s.stats_updated_at < v_now_utc - v_refresh_ttl)
    AND (s.stats_refresh_requested_at IS NULL OR s.stats_refresh_requested_at < v_now_utc - v_refresh_ttl)
  ON CONFLICT (app_id) DO UPDATE
  SET owner_org = EXCLUDED.owner_org,
      stats_refresh_requested_at = EXCLUDED.stats_refresh_requested_at
  WHERE (app_stats_refresh_state.stats_updated_at IS NULL
      OR app_stats_refresh_state.stats_updated_at < v_now_utc - v_refresh_ttl)
    AND (app_stats_refresh_state.stats_refresh_requested_at IS NULL
      OR app_stats_refresh_state.stats_refresh_requested_at < v_now_utc - v_refresh_ttl)
  RETURNING owner_org INTO v_org_id;
  IF v_org_id IS NULL OR EXISTS (
    SELECT 1
    FROM pgmq.q_cron_stat_app queued_job
    WHERE queued_job.message->'payload'->>'appId' = p_app_id
  ) THEN
    RETURN;
  END IF;
  PERFORM pgmq.send(
    'cron_stat_app',
    pg_catalog.jsonb_build_object(
      'function_name', 'cron_stat_app',
      'function_type', 'cloudflare',
      'payload', pg_catalog.jsonb_build_object(
        'appId', p_app_id,
        'orgId', v_org_id,
        'todayOnly', false
      )
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION "public"."request_app_chart_refresh"("app_id" character varying)
RETURNS TABLE("requested_at" timestamp without time zone, "queued_app_ids" character varying[],
  "queued_count" integer, "skipped_count" integer)
LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  v_org_id uuid;
  v_before_requested_at timestamp without time zone;
  v_after_requested_at timestamp without time zone;
  v_request_started_at timestamp without time zone := pg_catalog.timezone('UTC', pg_catalog.clock_timestamp());
  v_queued boolean := false;
BEGIN
  IF request_app_chart_refresh.app_id IS NULL OR request_app_chart_refresh.app_id = '' THEN
    RAISE EXCEPTION 'App ID is required';
  END IF;
  SELECT a.owner_org, s.stats_refresh_requested_at
  INTO v_org_id, v_before_requested_at
  FROM public.apps a
  LEFT JOIN public.app_stats_refresh_state s ON s.app_id = a.app_id
  WHERE a.app_id = request_app_chart_refresh.app_id
  LIMIT 1;
  IF v_org_id IS NULL THEN
    IF public.is_internal_request_role(public.current_request_role()) THEN
      RAISE EXCEPTION 'App not found';
    END IF;
    RAISE EXCEPTION 'App access denied';
  END IF;
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_app_read(),
      v_org_id,
      request_app_chart_refresh.app_id,
      NULL::bigint
    )
  THEN
    RAISE EXCEPTION 'App access denied';
  END IF;
  PERFORM public.queue_cron_stat_app_for_app(request_app_chart_refresh.app_id, v_org_id);
  SELECT s.stats_refresh_requested_at
  INTO v_after_requested_at
  FROM public.app_stats_refresh_state s
  WHERE s.app_id = request_app_chart_refresh.app_id;
  v_queued := v_after_requested_at IS NOT NULL
    AND v_after_requested_at >= v_request_started_at
    AND (v_before_requested_at IS NULL OR v_after_requested_at IS DISTINCT FROM v_before_requested_at);
  RETURN QUERY SELECT
    v_after_requested_at,
    CASE WHEN v_queued THEN ARRAY[request_app_chart_refresh.app_id]::character varying[] ELSE ARRAY[]::character varying[] END,
    CASE WHEN v_queued THEN 1 ELSE 0 END,
    CASE WHEN v_queued THEN 0 ELSE 1 END;
END;
$$;

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
  SELECT o.stats_refresh_requested_at
  INTO v_org_requested_at_before
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
    UPDATE public.orgs
    SET stats_refresh_requested_at = v_request_started_at
    WHERE id = request_org_chart_refresh.org_id;
    requested_at := v_request_started_at;
  ELSE
    requested_at := v_org_requested_at_before;
  END IF;
  queued_app_ids := COALESCE(v_queued_app_ids, ARRAY[]::character varying[]);
  queued_count := v_queued_count;
  skipped_count := GREATEST(v_total_count - v_queued_count, 0);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."get_org_apps_with_last_upload"(
  "p_org_id" uuid, "p_search" text DEFAULT NULL::text,
  "p_sort_by" text DEFAULT 'last_upload_at'::text, "p_sort_desc" boolean DEFAULT true,
  "p_limit" integer DEFAULT 10, "p_offset" integer DEFAULT 0)
RETURNS TABLE(
  "created_at" timestamp with time zone, "app_id" character varying, "icon_url" character varying,
  "user_id" uuid, "name" character varying, "last_version" character varying,
  "updated_at" timestamp with time zone, "id" uuid, "retention" bigint, "owner_org" uuid,
  "default_upload_channel" character varying, "transfer_history" jsonb[], "channel_device_count" bigint,
  "manifest_bundle_count" bigint, "expose_metadata" boolean, "allow_preview" boolean,
  "allow_device_custom_id" boolean, "need_onboarding" boolean, "existing_app" boolean,
  "ios_store_url" text, "android_store_url" text, "stats_updated_at" timestamp without time zone,
  "stats_refresh_requested_at" timestamp without time zone, "build_timeout_seconds" bigint,
  "build_timeout_updated_at" timestamp with time zone, "block_provider_infra_requests" boolean,
  "last_upload_at" timestamp with time zone, "total_count" bigint
)
LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(pg_catalog.btrim(COALESCE(p_search, '')), '');
  v_sort text := CASE WHEN p_sort_by IN ('name', 'last_version', 'updated_at', 'created_at', 'last_upload_at') THEN p_sort_by ELSE 'last_upload_at' END;
  v_desc boolean := COALESCE(p_sort_desc, true);
BEGIN
  RETURN QUERY
  WITH scoped AS (
    SELECT
      a.created_at, a.app_id, a.icon_url, a.user_id, a.name, a.last_version, a.updated_at, a.id,
      a.retention, a.owner_org, a.default_upload_channel, a.transfer_history, a.channel_device_count,
      a.manifest_bundle_count, a.expose_metadata, a.allow_preview, a.allow_device_custom_id,
      a.need_onboarding, a.existing_app, a.ios_store_url, a.android_store_url, s.stats_updated_at,
      s.stats_refresh_requested_at, a.build_timeout_seconds, a.build_timeout_updated_at,
      a.block_provider_infra_requests, lv.created_at AS last_upload_at
    FROM public.apps a
    LEFT JOIN public.app_stats_refresh_state s ON s.app_id = a.app_id
    LEFT JOIN LATERAL (
      SELECT av.created_at
      FROM public.app_versions av
      WHERE av.app_id = a.app_id AND av.name = a.last_version AND av.deleted = false
        AND av.app_id = ANY (COALESCE((SELECT public.app_versions_readable_app_ids()), ARRAY[]::character varying[]))
      ORDER BY av.created_at DESC
      LIMIT 1
    ) lv ON a.last_version IS NOT NULL
    WHERE a.owner_org = p_org_id
      AND a.app_id = ANY (COALESCE((SELECT public.apps_readable_app_ids()), ARRAY[]::character varying[]))
      AND (v_search IS NULL OR a.name ILIKE '%' || v_search || '%' OR a.app_id ILIKE '%' || v_search || '%')
  )
  SELECT s.*, COUNT(*) OVER () AS total_count
  FROM scoped s
  ORDER BY
    CASE WHEN v_sort = 'last_upload_at' AND v_desc THEN s.last_upload_at END DESC NULLS LAST,
    CASE WHEN v_sort = 'last_upload_at' AND NOT v_desc THEN s.last_upload_at END ASC NULLS LAST,
    CASE WHEN v_sort = 'updated_at' AND v_desc THEN s.updated_at END DESC NULLS LAST,
    CASE WHEN v_sort = 'updated_at' AND NOT v_desc THEN s.updated_at END ASC NULLS LAST,
    CASE WHEN v_sort = 'created_at' AND v_desc THEN s.created_at END DESC NULLS LAST,
    CASE WHEN v_sort = 'created_at' AND NOT v_desc THEN s.created_at END ASC NULLS LAST,
    CASE WHEN v_sort = 'name' AND v_desc THEN s.name END DESC NULLS LAST,
    CASE WHEN v_sort = 'name' AND NOT v_desc THEN s.name END ASC NULLS LAST,
    CASE WHEN v_sort = 'last_version' AND v_desc THEN s.last_version END DESC NULLS LAST,
    CASE WHEN v_sort = 'last_version' AND NOT v_desc THEN s.last_version END ASC NULLS LAST,
    s.app_id ASC
  LIMIT v_limit OFFSET v_offset;
END;
$$;
COMMENT ON FUNCTION "public"."get_org_apps_with_last_upload"(uuid, text, text, boolean, integer, integer) IS 'Bounded org app list. SECURITY DEFINER reads primary-only refresh state; explicit readable-app filters preserve caller visibility.';

ALTER TABLE "public"."apps"
  DROP COLUMN "stats_updated_at",
  DROP COLUMN "stats_refresh_requested_at";
