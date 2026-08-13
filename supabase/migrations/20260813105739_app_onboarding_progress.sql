-- App-level onboarding ledger (started / succeeded / last used / 30d retained / distribution stage).
-- Feature keys live in application code; this JSON is the durable store.
--
-- Execution model:
-- - mark_onboarding_feature_started: user-facing RPC, once per click, indexed apps.app_id
--   lookup plus one rbac_check_permission_request. Cannot set succeeded/retained/stage.
-- - refresh_app_onboarding_progress: hourly cron_tasks job, service_role only. Pages apps
--   by app_id (LIMIT 500), then bounded joins on devices (partial app_id indexes),
--   app_versions(app_id), daily_version(app_id, date), build_requests(app_id).
-- - User-facing writes to apps.onboarding are blocked by protect_apps_onboarding
--   on INSERT and UPDATE; only SECURITY DEFINER RPCs and service_role/postgres
--   can change the column. Authenticated inserts are forced to '{}'.

ALTER TABLE "public"."apps"
  ADD COLUMN IF NOT EXISTS "onboarding" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL;

ALTER TABLE "public"."apps"
  DROP CONSTRAINT IF EXISTS "apps_onboarding_valid";

ALTER TABLE "public"."apps"
  ADD CONSTRAINT "apps_onboarding_valid" CHECK (
    ("jsonb_typeof"("onboarding") = 'object'::"text")
    AND (
      (NOT ("onboarding" ? 'features'::"text"))
      OR ("jsonb_typeof"(("onboarding" -> 'features'::"text")) = 'object'::"text")
    )
  );

COMMENT ON COLUMN "public"."apps"."onboarding" IS
  'Extensible feature onboarding ledger. Shape: {"refreshed_at": iso, "features": { "<key>": { "started_at", "succeeded_at", "last_used_at", "retained_30d_at", "stage"? } }}. Success/usage/stage are written by refresh_app_onboarding_progress; clients may only set started_at via mark_onboarding_feature_started.';

CREATE OR REPLACE FUNCTION "public"."protect_apps_onboarding"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.onboarding := '{}'::jsonb;
    ELSIF TG_OP = 'UPDATE' AND NEW.onboarding IS DISTINCT FROM OLD.onboarding THEN
      NEW.onboarding := OLD.onboarding;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."protect_apps_onboarding"() OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."protect_apps_onboarding"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_apps_onboarding"() TO "postgres";
GRANT ALL ON FUNCTION "public"."protect_apps_onboarding"() TO "service_role";
GRANT ALL ON FUNCTION "public"."protect_apps_onboarding"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."protect_apps_onboarding"() TO "anon";

DROP TRIGGER IF EXISTS "protect_apps_onboarding" ON "public"."apps";
CREATE TRIGGER "protect_apps_onboarding"
  BEFORE INSERT OR UPDATE ON "public"."apps"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."protect_apps_onboarding"();

CREATE INDEX IF NOT EXISTS "idx_apps_onboarding_ota_stage"
  ON "public"."apps" (("onboarding" -> 'features'::"text" -> 'ota'::"text" ->> 'stage'::"text"));

CREATE INDEX IF NOT EXISTS "idx_apps_onboarding_refreshed_at"
  ON "public"."apps" ((COALESCE(("onboarding" ->> 'refreshed_at'::"text"), ''::"text")), "app_id");

CREATE OR REPLACE FUNCTION "public"."merge_app_onboarding_feature"(
  "p_existing" "jsonb",
  "p_started_at" timestamp with time zone,
  "p_succeeded_at" timestamp with time zone,
  "p_last_used_at" timestamp with time zone,
  "p_stage" "text" DEFAULT NULL::"text"
) RETURNS "jsonb"
LANGUAGE "plpgsql"
STABLE
SET "search_path" TO ''
AS $$
DECLARE
  v_existing jsonb := COALESCE(p_existing, '{}'::jsonb);
  v_started timestamptz;
  v_succeeded timestamptz;
  v_last_used timestamptz;
  v_retained timestamptz;
  v_stage text;
  v_existing_stage text;
  v_new_rank integer;
  v_old_rank integer;
BEGIN
  BEGIN
    v_started := NULLIF(v_existing->>'started_at', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    v_started := NULL;
  END;
  BEGIN
    v_succeeded := NULLIF(v_existing->>'succeeded_at', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    v_succeeded := NULL;
  END;
  BEGIN
    v_last_used := NULLIF(v_existing->>'last_used_at', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    v_last_used := NULL;
  END;
  BEGIN
    v_retained := NULLIF(v_existing->>'retained_30d_at', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    v_retained := NULL;
  END;

  v_started := COALESCE(v_started, p_started_at);
  v_succeeded := COALESCE(v_succeeded, p_succeeded_at);
  v_last_used := GREATEST(v_last_used, p_last_used_at);

  IF v_retained IS NULL
    AND v_succeeded IS NOT NULL
    AND v_last_used IS NOT NULL
    AND v_last_used >= v_succeeded + INTERVAL '30 days'
  THEN
    v_retained := v_last_used;
  END IF;

  v_existing_stage := NULLIF(v_existing->>'stage', '');
  v_new_rank := CASE p_stage
    WHEN 'store_live' THEN 5
    WHEN 'testflight' THEN 4
    WHEN 'play_unknown' THEN 3
    WHEN 'native_unknown' THEN 2
    WHEN 'local_only' THEN 1
    WHEN 'no_device' THEN 0
    ELSE -1
  END;
  v_old_rank := CASE v_existing_stage
    WHEN 'store_live' THEN 5
    WHEN 'testflight' THEN 4
    WHEN 'play_unknown' THEN 3
    WHEN 'native_unknown' THEN 2
    WHEN 'local_only' THEN 1
    WHEN 'no_device' THEN 0
    ELSE -1
  END;
  IF p_stage IS NOT NULL AND v_new_rank >= v_old_rank THEN
    v_stage := p_stage;
  ELSE
    v_stage := v_existing_stage;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'started_at', CASE WHEN v_started IS NULL THEN NULL
      ELSE to_char(v_started AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'succeeded_at', CASE WHEN v_succeeded IS NULL THEN NULL
      ELSE to_char(v_succeeded AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'last_used_at', CASE WHEN v_last_used IS NULL THEN NULL
      ELSE to_char(v_last_used AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'retained_30d_at', CASE WHEN v_retained IS NULL THEN NULL
      ELSE to_char(v_retained AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'stage', v_stage
  ));
END;
$$;

ALTER FUNCTION "public"."merge_app_onboarding_feature"("jsonb", timestamp with time zone, timestamp with time zone, timestamp with time zone, "text") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."merge_app_onboarding_feature"("jsonb", timestamp with time zone, timestamp with time zone, timestamp with time zone, "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."merge_app_onboarding_feature"("jsonb", timestamp with time zone, timestamp with time zone, timestamp with time zone, "text") TO "service_role";

CREATE OR REPLACE FUNCTION "public"."mark_onboarding_feature_started"(
  "p_app_id" character varying,
  "p_feature_key" "text"
) RETURNS "jsonb"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_owner_org uuid;
  v_onboarding jsonb;
  v_feature jsonb;
  v_now text;
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RAISE EXCEPTION 'APP_NOT_FOUND';
  END IF;

  IF p_feature_key IS NULL OR p_feature_key !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'INVALID_FEATURE_KEY';
  END IF;

  SELECT apps.owner_org, apps.onboarding
  INTO v_owner_org, v_onboarding
  FROM public.apps
  WHERE apps.app_id = p_app_id
  FOR UPDATE;

  IF v_owner_org IS NULL THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  IF NOT public.rbac_check_permission_request(
    public.rbac_perm_app_read(),
    v_owner_org,
    p_app_id,
    NULL::bigint
  ) THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  v_onboarding := COALESCE(v_onboarding, '{}'::jsonb);
  IF jsonb_typeof(v_onboarding->'features') IS DISTINCT FROM 'object' THEN
    v_onboarding := v_onboarding || jsonb_build_object('features', '{}'::jsonb);
  END IF;

  v_feature := v_onboarding->'features'->p_feature_key;
  IF jsonb_typeof(v_feature) IS DISTINCT FROM 'object' THEN
    v_feature := '{}'::jsonb;
  END IF;

  IF NULLIF(v_feature->>'started_at', '') IS NULL THEN
    v_now := to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    v_feature := v_feature || jsonb_build_object('started_at', v_now);
    v_onboarding := jsonb_set(v_onboarding, ARRAY['features', p_feature_key], v_feature, true);

    UPDATE public.apps
    SET onboarding = v_onboarding,
        updated_at = now()
    WHERE apps.app_id = p_app_id;
  END IF;

  RETURN v_onboarding;
END;
$$;

ALTER FUNCTION "public"."mark_onboarding_feature_started"(character varying, "text") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."mark_onboarding_feature_started"(character varying, "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_onboarding_feature_started"(character varying, "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_onboarding_feature_started"(character varying, "text") TO "service_role";

COMMENT ON FUNCTION "public"."mark_onboarding_feature_started"(character varying, "text") IS
  'Sets features.<key>.started_at once when the caller can read the app. Does not write succeeded_at, last_used_at, retained_30d_at, or stage.';

CREATE OR REPLACE FUNCTION "public"."refresh_app_onboarding_progress"(
  "p_batch_size" integer DEFAULT 500
) RETURNS integer
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_batch_size, 500), 2000));
  v_updated integer := 0;
BEGIN
  WITH batch AS (
    SELECT apps.app_id
    FROM public.apps
    ORDER BY COALESCE(apps.onboarding->>'refreshed_at', ''), apps.app_id
    LIMIT v_limit
  ),
  device_signals AS (
    SELECT
      devices.app_id,
      bool_or(devices.install_source = 'app_store') AS has_app_store,
      bool_or(devices.install_source = 'testflight') AS has_testflight,
      bool_or(devices.install_source IN (
        'google_play',
        'amazon_appstore',
        'samsung_galaxy_store',
        'huawei_appgallery'
      )) AS has_play_unknown,
      bool_or(devices.is_prod IS TRUE AND devices.is_emulator IS NOT TRUE) AS has_native,
      bool_or(devices.install_source IS NOT NULL) AS has_install_source,
      MAX(devices.updated_at) AS last_device_at
    FROM public.devices
    INNER JOIN batch ON batch.app_id = devices.app_id
    WHERE devices.install_source IS NOT NULL
       OR (devices.is_prod IS TRUE AND devices.is_emulator IS NOT TRUE)
    GROUP BY devices.app_id
  ),
  bundle_signals AS (
    SELECT
      app_versions.app_id,
      MIN(app_versions.created_at) AS first_bundle_at,
      MAX(app_versions.created_at) AS last_bundle_at
    FROM public.app_versions
    INNER JOIN batch ON batch.app_id = app_versions.app_id
    WHERE app_versions.deleted IS NOT TRUE
      AND app_versions.name IS DISTINCT FROM 'builtin'
      AND app_versions.name IS DISTINCT FROM 'unknown'
    GROUP BY app_versions.app_id
  ),
  install_signals AS (
    SELECT
      daily_version.app_id,
      MIN(daily_version.date)::timestamptz AS first_install_at,
      MAX(daily_version.date)::timestamptz AS last_install_at
    FROM public.daily_version
    INNER JOIN batch ON batch.app_id = daily_version.app_id
    WHERE COALESCE(daily_version.install, 0) > 0
    GROUP BY daily_version.app_id
  ),
  build_signals AS (
    SELECT
      build_requests.app_id,
      MIN(build_requests.created_at) AS first_build_at,
      MIN(build_requests.completed_at) FILTER (
        WHERE build_requests.status IN ('succeeded', 'released')
      ) AS first_success_at,
      MAX(COALESCE(build_requests.completed_at, build_requests.created_at)) AS last_build_at
    FROM public.build_requests
    INNER JOIN batch ON batch.app_id = build_requests.app_id
    GROUP BY build_requests.app_id
  ),
  merged AS (
    SELECT
      batch.app_id,
      public.merge_app_onboarding_feature(
        apps.onboarding->'features'->'cli_install',
        device_signals.last_device_at,
        device_signals.last_device_at,
        device_signals.last_device_at,
        NULL
      ) AS cli_install,
      public.merge_app_onboarding_feature(
        apps.onboarding->'features'->'ota',
        bundle_signals.first_bundle_at,
        install_signals.first_install_at,
        GREATEST(install_signals.last_install_at, bundle_signals.last_bundle_at),
        CASE
          WHEN device_signals.has_app_store THEN 'store_live'
          WHEN device_signals.has_testflight THEN 'testflight'
          WHEN device_signals.has_play_unknown THEN 'play_unknown'
          WHEN device_signals.has_native THEN 'native_unknown'
          WHEN device_signals.has_install_source THEN 'local_only'
          ELSE 'no_device'
        END
      ) AS ota,
      public.merge_app_onboarding_feature(
        apps.onboarding->'features'->'builder',
        build_signals.first_build_at,
        build_signals.first_success_at,
        build_signals.last_build_at,
        NULL
      ) AS builder
    FROM batch
    INNER JOIN public.apps ON apps.app_id = batch.app_id
    LEFT JOIN device_signals ON device_signals.app_id = batch.app_id
    LEFT JOIN bundle_signals ON bundle_signals.app_id = batch.app_id
    LEFT JOIN install_signals ON install_signals.app_id = batch.app_id
    LEFT JOIN build_signals ON build_signals.app_id = batch.app_id
  )
  UPDATE public.apps
  SET
    onboarding = jsonb_strip_nulls(
      COALESCE(apps.onboarding, '{}'::jsonb)
      || jsonb_build_object(
        'refreshed_at', to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'features', COALESCE(apps.onboarding->'features', '{}'::jsonb) || jsonb_build_object(
          'cli_install', merged.cli_install,
          'ota', merged.ota,
          'builder', merged.builder
        )
      )
    ),
    updated_at = now()
  FROM merged
  WHERE apps.app_id = merged.app_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

ALTER FUNCTION "public"."refresh_app_onboarding_progress"(integer) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."refresh_app_onboarding_progress"(integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_app_onboarding_progress"(integer) TO "service_role";

COMMENT ON FUNCTION "public"."refresh_app_onboarding_progress"(integer) IS
  'Hourly bounded backfill/refresh of apps.onboarding from devices, bundles, daily_version installs, and build_requests. Never called from plugin request paths.';

INSERT INTO public.cron_tasks (
  name,
  description,
  task_type,
  target,
  batch_size,
  payload,
  second_interval,
  minute_interval,
  hour_interval,
  run_at_hour,
  run_at_minute,
  run_at_second,
  run_on_dow,
  run_on_day,
  enabled
) VALUES (
  'refresh_app_onboarding_progress',
  'Refresh apps.onboarding feature ledger (started/succeeded/last_used/stage) in bounded batches',
  'function',
  'public.refresh_app_onboarding_progress(2000)',
  2000,
  NULL,
  NULL,
  NULL,
  1,
  NULL,
  20,
  NULL,
  NULL,
  NULL,
  true
)
ON CONFLICT (name) DO UPDATE
SET
  description = EXCLUDED.description,
  task_type = EXCLUDED.task_type,
  target = EXCLUDED.target,
  batch_size = EXCLUDED.batch_size,
  hour_interval = EXCLUDED.hour_interval,
  run_at_minute = EXCLUDED.run_at_minute,
  enabled = true,
  updated_at = pg_catalog.now();

CREATE OR REPLACE FUNCTION "public"."audit_log_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_old_record jsonb;
  v_new_record jsonb;
  v_changed_fields text[];
  v_org_id uuid;
  v_record_id text;
  v_user_id uuid;
  v_key text;
  v_api_key_text text;
  v_api_key public.apikeys%ROWTYPE;
  v_actor_type text := 'system';
  v_actor_user_id uuid;
  v_actor_user_email text;
  v_actor_apikey_id bigint;
  v_actor_apikey_name text;
  v_stats_refresh_fields constant text[] := ARRAY['stats_refresh_requested_at', 'stats_updated_at', 'updated_at'];
  v_background_counter_fields constant text[] := ARRAY['channel_device_count', 'manifest_bundle_count', 'updated_at'];
  v_onboarding_progress_fields constant text[] := ARRAY['onboarding', 'updated_at'];
  v_fat_app_version_fields constant text[] := ARRAY['manifest', 'native_packages'];
BEGIN
  SELECT auth.uid() INTO v_actor_user_id;

  IF v_actor_user_id IS NOT NULL THEN
    v_actor_type := 'user';
  ELSE
    SELECT public.get_apikey_header() INTO v_api_key_text;

    IF v_api_key_text IS NOT NULL THEN
      SELECT *
      INTO v_api_key
      FROM public.find_apikey_by_value(v_api_key_text)
      LIMIT 1;

      IF v_api_key.id IS NOT NULL
        AND NOT public.is_apikey_expired(v_api_key.expires_at)
        AND (
          public.is_allowed_capgkey(v_api_key_text, '{upload}'::text[])
          OR public.is_allowed_capgkey(v_api_key_text, '{write}'::text[])
          OR public.is_allowed_capgkey(v_api_key_text, '{all}'::text[])
        ) THEN
        v_actor_type := 'apikey';
        v_actor_user_id := v_api_key.user_id;
        v_actor_apikey_id := v_api_key.id;
        v_actor_apikey_name := v_api_key.name;
      END IF;
    END IF;
  END IF;

  IF v_actor_user_id IS NOT NULL THEN
    SELECT users.email
    INTO v_actor_user_email
    FROM public.users AS users
    WHERE users.id = v_actor_user_id;
  END IF;

  v_user_id := v_actor_user_id;

  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'app_versions' THEN
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := pg_catalog.to_jsonb(NEW);
    IF (
      v_old_record
        - 'manifest'
        - 'updated_at'
        - 'manifest_count'
        - 'storage_provider'
        - 'r2_path'
    ) IS NOT DISTINCT FROM (
      v_new_record
        - 'manifest'
        - 'updated_at'
        - 'manifest_count'
        - 'storage_provider'
        - 'r2_path'
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_old_record := NULL;
    v_new_record := pg_catalog.to_jsonb(NEW);
  ELSE
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := pg_catalog.to_jsonb(NEW);

    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_new_record)
    LOOP
      IF v_old_record->v_key IS DISTINCT FROM v_new_record->v_key THEN
        v_changed_fields := pg_catalog.array_append(v_changed_fields, v_key);
      END IF;
    END LOOP;

    IF v_changed_fields IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name IS DISTINCT FROM 'updated_at'
      ) THEN
      RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = ANY(ARRAY['apps', 'orgs'])
      AND v_changed_fields && ARRAY['stats_refresh_requested_at', 'stats_updated_at']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_stats_refresh_fields)
      ) THEN
      RETURN NEW;
    END IF;

    IF v_actor_type = 'system'
      AND TG_TABLE_NAME = 'apps'
      AND v_changed_fields && ARRAY['channel_device_count', 'manifest_bundle_count']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_background_counter_fields)
      ) THEN
      RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'apps'
      AND v_changed_fields && ARRAY['onboarding']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_onboarding_progress_fields)
      ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'app_versions' THEN
    IF v_old_record IS NOT NULL THEN
      v_old_record := v_old_record - v_fat_app_version_fields;
    END IF;
    IF v_new_record IS NOT NULL THEN
      v_new_record := v_new_record - v_fat_app_version_fields;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    CASE TG_TABLE_NAME
      WHEN 'orgs' THEN
        v_org_id := OLD.id;
        v_record_id := OLD.id::text;
      WHEN 'apps' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.app_id::text;
      WHEN 'channels' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.id::text;
      WHEN 'app_versions' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.id::text;
      WHEN 'org_users' THEN
        v_org_id := OLD.org_id;
        v_record_id := OLD.id::text;
      ELSE
        v_org_id := NULL;
        v_record_id := NULL;
    END CASE;
  ELSE
    CASE TG_TABLE_NAME
      WHEN 'orgs' THEN
        v_org_id := NEW.id;
        v_record_id := NEW.id::text;
      WHEN 'apps' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.app_id::text;
      WHEN 'channels' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.id::text;
      WHEN 'app_versions' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.id::text;
      WHEN 'org_users' THEN
        v_org_id := NEW.org_id;
        v_record_id := NEW.id::text;
      ELSE
        v_org_id := NULL;
        v_record_id := NULL;
    END CASE;
  END IF;

  IF v_org_id IS NOT NULL THEN
    INSERT INTO public.audit_logs (
      table_name,
      record_id,
      operation,
      user_id,
      org_id,
      old_record,
      new_record,
      changed_fields,
      actor_type,
      actor_user_id,
      actor_user_email,
      actor_apikey_id,
      actor_apikey_name
    ) VALUES (
      TG_TABLE_NAME,
      v_record_id,
      TG_OP,
      v_user_id,
      v_org_id,
      v_old_record,
      v_new_record,
      v_changed_fields,
      v_actor_type,
      v_actor_user_id,
      v_actor_user_email,
      v_actor_apikey_id,
      v_actor_apikey_name
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."audit_log_trigger"() OWNER TO "postgres";
