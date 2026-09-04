CREATE OR REPLACE FUNCTION "public"."read_native_active_devices_summary"(
  "p_app_id" character varying,
  "p_period_start" timestamp without time zone,
  "p_period_end" timestamp without time zone
)
RETURNS TABLE("platform" character varying, "devices" bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH authorized_app AS (
    SELECT apps.app_id
    FROM public.apps
    WHERE apps.app_id = p_app_id
      AND public.rbac_check_permission_request(
        public.rbac_perm_app_read(),
        apps.owner_org,
        apps.app_id,
        NULL::bigint
      )
  ),
  usage_rows AS (
    SELECT
      du.device_id,
      COALESCE(NULLIF(du.platform, ''), NULLIF(d.platform::text, ''), 'unknown')::character varying AS usage_platform
    FROM public.device_usage AS du
    INNER JOIN authorized_app AS aa ON aa.app_id = du.app_id
    LEFT JOIN public.devices AS d
      ON d.app_id = du.app_id
      AND d.device_id = du.device_id
    WHERE du.timestamp >= p_period_start
      AND du.timestamp < p_period_end
  )
  SELECT usage_rows.usage_platform AS platform, COUNT(DISTINCT usage_rows.device_id)::bigint AS devices
  FROM usage_rows
  GROUP BY usage_rows.usage_platform
  UNION ALL
  SELECT 'total'::character varying AS platform, COUNT(DISTINCT usage_rows.device_id)::bigint AS devices
  FROM usage_rows
  ORDER BY platform;
END;
$$;

ALTER FUNCTION "public"."read_native_active_devices_summary"(
  "p_app_id" character varying,
  "p_period_start" timestamp without time zone,
  "p_period_end" timestamp without time zone
) OWNER TO "postgres";

COMMENT ON FUNCTION "public"."read_native_active_devices_summary"(
  "p_app_id" character varying,
  "p_period_start" timestamp without time zone,
  "p_period_end" timestamp without time zone
) IS 'Authorized distinct active native devices by platform for a period. Active means at least one device_usage report in the window.';

REVOKE ALL ON FUNCTION "public"."read_native_active_devices_summary"(
  "p_app_id" character varying,
  "p_period_start" timestamp without time zone,
  "p_period_end" timestamp without time zone
) FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."read_native_active_devices_summary"(
  "p_app_id" character varying,
  "p_period_start" timestamp without time zone,
  "p_period_end" timestamp without time zone
) TO "service_role";

GRANT ALL ON FUNCTION "public"."read_native_active_devices_summary"(
  "p_app_id" character varying,
  "p_period_start" timestamp without time zone,
  "p_period_end" timestamp without time zone
) TO "authenticated";

GRANT ALL ON FUNCTION "public"."read_native_active_devices_summary"(
  "p_app_id" character varying,
  "p_period_start" timestamp without time zone,
  "p_period_end" timestamp without time zone
) TO "anon";
