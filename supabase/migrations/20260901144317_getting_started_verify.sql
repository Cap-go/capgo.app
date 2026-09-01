-- Verify Getting Started against live app data, and stop the login splash from
-- bouncing people who already shipped a bundle, finished CLI/AI setup, or hid
-- the checklist.
--
-- Execution model:
-- - try_complete_pending_onboarding: internal, once per call, indexed apps.app_id
--   PK update. Trigger cleanup_onboarding_app_data_on_complete may run. Nested
--   EXCEPTION keeps the caller successful if demo cleanup refuses.
-- - refresh_one_app_onboarding_progress: internal, once per call. Same merge as
--   the hourly batch but for one app_id. Bound by apps PK plus:
--   idx_app_id_app_versions, idx_devices_app_id_install_source,
--   idx_devices_app_id_plugin_version_production, idx_daily_version_app_id,
--   idx_build_requests_app. Never scans all apps.
-- - verify_getting_started: user-facing RPC, once per click. Indexed apps.app_id
--   lookup + one rbac_check_permission_request (app_read). Refreshes that app,
--   then completes need_onboarding when a real (non-demo) bundle exists.
-- - report_app_onboarding_setup: after merging setup, completes need_onboarding
--   when outcome is completed or skipped (AI/CLI finished the 12 steps).
-- - dismiss_getting_started: still sets getting_started_dismissed_at; also tries
--   to complete need_onboarding so login no longer forces /onboarding/app.
-- - Callers: authenticated console users who can already read the app. Not granted
--   to anon. Internal helpers are service_role only.

CREATE OR REPLACE FUNCTION "public"."try_complete_pending_onboarding"(
  "p_app_id" character varying
) RETURNS boolean
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RETURN false;
  END IF;

  UPDATE public.apps
  SET need_onboarding = false,
      updated_at = now()
  WHERE apps.app_id = p_app_id
    AND apps.need_onboarding IS TRUE;

  RETURN FOUND;
EXCEPTION WHEN raise_exception THEN
  -- SQLSTATE P0001: provenance reset refused. Leave the app pending.
  RETURN false;
END;
$$;

ALTER FUNCTION public.try_complete_pending_onboarding(character varying) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.try_complete_pending_onboarding(character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION public.try_complete_pending_onboarding(character varying) TO "service_role";

COMMENT ON FUNCTION public.try_complete_pending_onboarding(character varying) IS
  'Internal. Sets apps.need_onboarding=false for one app_id. Swallows P0001 from demo cleanup so callers can still persist dismiss or setup progress.';

CREATE OR REPLACE FUNCTION "public"."try_complete_pending_onboarding_if_setup_done"(
  "p_app_id" character varying
) RETURNS boolean
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_outcome text;
BEGIN
  SELECT COALESCE(
    apps.onboarding -> 'setup' ->> 'outcome',
    apps.onboarding ->> 'outcome',
    ''
  )
  INTO v_outcome
  FROM public.apps
  WHERE apps.app_id = p_app_id;

  IF v_outcome NOT IN ('completed', 'skipped') THEN
    RETURN false;
  END IF;

  RETURN public.try_complete_pending_onboarding(p_app_id);
END;
$$;

ALTER FUNCTION public.try_complete_pending_onboarding_if_setup_done(character varying) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.try_complete_pending_onboarding_if_setup_done(character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION public.try_complete_pending_onboarding_if_setup_done(character varying) TO "service_role";

COMMENT ON FUNCTION public.try_complete_pending_onboarding_if_setup_done(character varying) IS
  'Internal. Completes pending onboarding when apps.onboarding.setup.outcome is completed or skipped. Indexed apps.app_id lookup.';

CREATE OR REPLACE FUNCTION "public"."refresh_one_app_onboarding_progress"(
  "p_app_id" character varying
) RETURNS "jsonb"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_onboarding jsonb;
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RAISE EXCEPTION 'APP_NOT_FOUND';
  END IF;

  WITH device_signals AS (
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
    WHERE devices.app_id = p_app_id
      AND (
        devices.install_source IS NOT NULL
        OR (devices.is_prod IS TRUE AND devices.is_emulator IS NOT TRUE)
      )
    GROUP BY devices.app_id
  ),
  bundle_signals AS (
    SELECT
      app_versions.app_id,
      MIN(app_versions.created_at) AS first_bundle_at,
      MAX(app_versions.created_at) AS last_bundle_at
    FROM public.app_versions
    WHERE app_versions.app_id = p_app_id
      AND app_versions.deleted IS NOT TRUE
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
    WHERE daily_version.app_id = p_app_id
      AND COALESCE(daily_version.install, 0) > 0
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
    WHERE build_requests.app_id = p_app_id
    GROUP BY build_requests.app_id
  )
  UPDATE public.apps
  SET
    onboarding = jsonb_strip_nulls(
      COALESCE(apps.onboarding, '{}'::jsonb)
      || jsonb_build_object(
        'refreshed_at', to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'features', COALESCE(apps.onboarding->'features', '{}'::jsonb) || jsonb_build_object(
          'cli_install', public.merge_app_onboarding_feature(
            apps.onboarding->'features'->'cli_install',
            device_signals.last_device_at,
            device_signals.last_device_at,
            device_signals.last_device_at,
            NULL
          ),
          'ota', public.merge_app_onboarding_feature(
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
          ),
          'builder', public.merge_app_onboarding_feature(
            apps.onboarding->'features'->'builder',
            build_signals.first_build_at,
            build_signals.first_success_at,
            build_signals.last_build_at,
            NULL
          )
        )
      )
    ),
    updated_at = now()
  FROM (SELECT p_app_id AS app_id) AS target
  LEFT JOIN device_signals ON device_signals.app_id = target.app_id
  LEFT JOIN bundle_signals ON bundle_signals.app_id = target.app_id
  LEFT JOIN install_signals ON install_signals.app_id = target.app_id
  LEFT JOIN build_signals ON build_signals.app_id = target.app_id
  WHERE apps.app_id = p_app_id
  RETURNING apps.onboarding INTO v_onboarding;

  IF v_onboarding IS NULL THEN
    RAISE EXCEPTION 'APP_NOT_FOUND';
  END IF;

  RETURN v_onboarding;
END;
$$;

ALTER FUNCTION public.refresh_one_app_onboarding_progress(character varying) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.refresh_one_app_onboarding_progress(character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION public.refresh_one_app_onboarding_progress(character varying) TO "service_role";

COMMENT ON FUNCTION public.refresh_one_app_onboarding_progress(character varying) IS
  'Internal. Refreshes apps.onboarding features for one app_id from devices, bundles, daily_version installs, and build_requests. Same merge as the hourly batch. Never called from plugin request paths.';

CREATE OR REPLACE FUNCTION "public"."verify_getting_started"(
  "p_app_id" character varying
) RETURNS "jsonb"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_owner_org uuid;
  v_onboarding jsonb;
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RAISE EXCEPTION 'APP_NOT_FOUND';
  END IF;

  SELECT apps.owner_org
  INTO v_owner_org
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

  v_onboarding := public.refresh_one_app_onboarding_progress(p_app_id);

  IF public.app_has_real_bundle(p_app_id)
    AND NOT public.has_seeded_demo_data(p_app_id)
  THEN
    PERFORM public.try_complete_pending_onboarding(p_app_id);
  END IF;

  SELECT apps.onboarding
  INTO v_onboarding
  FROM public.apps
  WHERE apps.app_id = p_app_id;

  RETURN v_onboarding;
END;
$$;

ALTER FUNCTION public.verify_getting_started(character varying) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.verify_getting_started(character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION public.verify_getting_started(character varying) TO "authenticated";
GRANT ALL ON FUNCTION public.verify_getting_started(character varying) TO "service_role";

COMMENT ON FUNCTION public.verify_getting_started(character varying) IS
  'Refreshes Getting Started from live devices/bundles/builds for one app the caller can read. Completes need_onboarding when a real non-demo bundle exists. Once per click, indexed app_id lookups only.';

CREATE OR REPLACE FUNCTION "public"."dismiss_getting_started"(
  "p_app_id" character varying
) RETURNS "jsonb"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_owner_org uuid;
  v_onboarding jsonb;
  v_now text;
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RAISE EXCEPTION 'APP_NOT_FOUND';
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
  IF NULLIF(v_onboarding->>'getting_started_dismissed_at', '') IS NULL THEN
    v_now := to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    v_onboarding := v_onboarding || jsonb_build_object('getting_started_dismissed_at', v_now);

    UPDATE public.apps
    SET onboarding = v_onboarding,
        updated_at = now()
    WHERE apps.app_id = p_app_id;
  END IF;

  -- Hide the login splash as well as the sidebar entry. Demo cleanup refusal
  -- is swallowed so dismiss still sticks.
  PERFORM public.try_complete_pending_onboarding(p_app_id);

  SELECT apps.onboarding
  INTO v_onboarding
  FROM public.apps
  WHERE apps.app_id = p_app_id;

  RETURN v_onboarding;
END;
$$;

ALTER FUNCTION public.dismiss_getting_started(character varying) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.dismiss_getting_started(character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION public.dismiss_getting_started(character varying) TO "authenticated";
GRANT ALL ON FUNCTION public.dismiss_getting_started(character varying) TO "service_role";

COMMENT ON FUNCTION public.dismiss_getting_started(character varying) IS
  'Sets onboarding.getting_started_dismissed_at once when the caller can read the app, and tries to complete need_onboarding so login no longer forces the setup splash.';

CREATE OR REPLACE FUNCTION "public"."report_app_onboarding_setup"(
  "p_app_id" character varying,
  "p_patch" "jsonb"
) RETURNS "jsonb"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_owner_org uuid;
  v_onboarding jsonb;
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RAISE EXCEPTION 'APP_NOT_FOUND';
  END IF;

  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'INVALID_PATCH';
  END IF;

  SELECT apps.owner_org, apps.onboarding
  INTO v_owner_org, v_onboarding
  FROM public.apps
  WHERE apps.app_id = p_app_id
  FOR UPDATE;

  IF v_owner_org IS NULL THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  IF NOT (
    public.rbac_check_permission_request(
      public.rbac_perm_app_update_settings(),
      v_owner_org,
      p_app_id,
      NULL::bigint
    )
    OR public.rbac_check_permission_request(
      public.rbac_perm_org_create_app(),
      v_owner_org,
      NULL::character varying,
      NULL::bigint
    )
  ) THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  v_onboarding := public.merge_app_onboarding_setup(v_onboarding, p_patch);

  UPDATE public.apps
  SET onboarding = v_onboarding,
      updated_at = now()
  WHERE apps.app_id = p_app_id;

  PERFORM public.try_complete_pending_onboarding_if_setup_done(p_app_id);

  SELECT apps.onboarding
  INTO v_onboarding
  FROM public.apps
  WHERE apps.app_id = p_app_id;

  RETURN v_onboarding;
END;
$$;

ALTER FUNCTION public.report_app_onboarding_setup(character varying, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.report_app_onboarding_setup(character varying, jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_app_onboarding_setup(character varying, jsonb) TO "authenticated";
GRANT ALL ON FUNCTION public.report_app_onboarding_setup(character varying, jsonb) TO "service_role";

COMMENT ON FUNCTION public.report_app_onboarding_setup(character varying, jsonb) IS
  'Records CLI/MCP/AI/manual setup progress for an app the caller can update. Completes need_onboarding when setup outcome is completed or skipped. Requires app.update_settings or org.create_app.';
