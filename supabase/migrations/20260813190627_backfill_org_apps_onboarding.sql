-- Org-scoped backfill of apps.onboarding so existing customers see Getting Started
-- progress without waiting on the hourly 2000-app global cron.
--
-- Execution model:
-- - refresh_app_onboarding_progress(p_batch_size, p_owner_org): still service_role
--   only. Cron keeps calling refresh_app_onboarding_progress(2000). When p_owner_org
--   is set, the batch is limited to that org and to rows with empty refreshed_at.
--   Batch is ORDER BY refreshed_at, app_id LIMIT <= 2000, then the same bounded
--   joins as before (devices/app_versions/daily_version/build_requests on app_id).
-- - refresh_org_apps_onboarding(p_org_id): authenticated RPC. One
--   rbac_check_permission_request(org.read) then one owner_org-filtered refresh.
--   Authenticated members can already SELECT apps.onboarding for their org via RLS;
--   this RPC only writes the derived ledger for unrefreshed apps in that org.
--   Failed RBAC raises NO_PERMISSION with no counts, so it is not an existence
--   oracle. Restricting it would leave Getting Started empty until cron reaches
--   the org.

DROP FUNCTION IF EXISTS "public"."refresh_app_onboarding_progress"(integer);

CREATE OR REPLACE FUNCTION "public"."refresh_app_onboarding_progress"(
  "p_batch_size" integer DEFAULT 500,
  "p_owner_org" uuid DEFAULT NULL
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
    WHERE (p_owner_org IS NULL OR apps.owner_org = p_owner_org)
      AND (
        p_owner_org IS NULL
        OR COALESCE(apps.onboarding->>'refreshed_at', '') = ''
      )
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

ALTER FUNCTION "public"."refresh_app_onboarding_progress"(integer, uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."refresh_app_onboarding_progress"(integer, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_app_onboarding_progress"(integer, uuid) TO "service_role";

COMMENT ON FUNCTION "public"."refresh_app_onboarding_progress"(integer, uuid) IS
  'Bounded backfill/refresh of apps.onboarding from devices, bundles, daily_version installs, and build_requests. Optional p_owner_org limits the batch to unrefreshed apps in that org. Never called from plugin request paths. service_role only.';

CREATE OR REPLACE FUNCTION "public"."refresh_org_apps_onboarding"(
  "p_org_id" uuid
) RETURNS integer
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  IF NOT public.rbac_check_permission_request(
    public.rbac_perm_org_read(),
    p_org_id,
    NULL::character varying,
    NULL::bigint
  ) THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  RETURN public.refresh_app_onboarding_progress(2000, p_org_id);
END;
$$;

ALTER FUNCTION "public"."refresh_org_apps_onboarding"(uuid) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."refresh_org_apps_onboarding"(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."refresh_org_apps_onboarding"(uuid) TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_org_apps_onboarding"(uuid) TO "service_role";

COMMENT ON FUNCTION "public"."refresh_org_apps_onboarding"(uuid) IS
  'User-facing org backfill of apps.onboarding. One org.read RBAC check, then refresh_app_onboarding_progress(2000, org). Authenticated only; not granted to anon.';
