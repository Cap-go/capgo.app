-- Console query performance.
--
-- 1. The restrictive "Prevent non 2FA access" policies called verify_mfa() bare,
--    so Postgres evaluated it once per candidate row. Wrapping the call in a
--    scalar subquery makes it an InitPlan evaluated once per statement, with the
--    same result. Measured on 27k bundles: count 140 ms -> 7 ms.
ALTER POLICY "Prevent non 2FA access" ON public.apikeys USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.app_versions USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.apps USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.channel_devices USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.channels USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.org_users USING ((SELECT public.verify_mfa()));
ALTER POLICY "Prevent non 2FA access" ON public.orgs USING ((SELECT public.verify_mfa()));

-- 2. Daily counts for the dashboard upload and deployment charts. The console
--    used to download every bundle or deploy of the window (tens of thousands
--    of rows for CI-heavy organizations) only to bucket them by day. Security
--    invoker: the caller's RLS still decides which rows count. day_index is the
--    whole number of days since p_start, the bucket the charts use. Inputs are
--    bounded (one billing cycle, 1000 apps) so a caller cannot ask for a
--    full-history aggregation.
CREATE OR REPLACE FUNCTION public.assert_console_daily_window(
  p_app_ids character varying[],
  p_start timestamptz,
  p_end timestamptz
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start OR p_end - p_start > interval '370 days' THEN
    RAISE EXCEPTION 'invalid_window' USING ERRCODE = '22023', DETAIL = 'The window must be positive and at most 370 days.';
  END IF;
  IF coalesce(cardinality(p_app_ids), 0) > 1000 THEN
    RAISE EXCEPTION 'too_many_apps' USING ERRCODE = '22023', DETAIL = 'At most 1000 apps per request.';
  END IF;
END;
$$;

ALTER FUNCTION public.assert_console_daily_window(character varying[], timestamptz, timestamptz) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.assert_console_daily_window(character varying[], timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_console_daily_window(character varying[], timestamptz, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_bundle_upload_daily_counts(
  p_app_ids character varying[],
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE (app_id character varying, day_index integer, uploads bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.assert_console_daily_window(p_app_ids, p_start, p_end);
  RETURN QUERY
  SELECT
    v.app_id,
    floor(extract(epoch FROM (v.created_at - p_start)) / 86400)::integer AS day_index,
    count(*) AS uploads
  FROM public.app_versions v
  WHERE v.app_id = ANY (p_app_ids)
    AND v.created_at >= p_start
    AND v.created_at < p_end
    -- builtin/unknown placeholders are created by the system, not uploaded.
    AND NOT (
      v.deleted
      AND coalesce(v.r2_path, '') = ''
      AND coalesce(v.external_url, '') = ''
      AND v.user_id IS NULL
    )
  GROUP BY 1, 2
  -- Stable order so callers can page past PostgREST's max_rows.
  ORDER BY 1, 2;
END;
$$;

ALTER FUNCTION public.get_bundle_upload_daily_counts(character varying[], timestamptz, timestamptz) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.get_bundle_upload_daily_counts(character varying[], timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bundle_upload_daily_counts(character varying[], timestamptz, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_deploy_daily_counts(
  p_app_ids character varying[],
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE (app_id character varying, channel_id bigint, channel_name character varying, day_index integer, deploys bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.assert_console_daily_window(p_app_ids, p_start, p_end);
  RETURN QUERY
  SELECT
    d.app_id,
    d.channel_id,
    c.name AS channel_name,
    floor(extract(epoch FROM (d.deployed_at - p_start)) / 86400)::integer AS day_index,
    count(*) AS deploys
  FROM public.deploy_history d
  LEFT JOIN public.channels c ON c.id = d.channel_id
  WHERE d.app_id = ANY (p_app_ids)
    AND d.deployed_at >= p_start
    AND d.deployed_at < p_end
  GROUP BY 1, 2, 3, 4
  -- Stable order so callers can page past PostgREST's max_rows.
  ORDER BY 1, 2, 4;
END;
$$;

ALTER FUNCTION public.get_deploy_daily_counts(character varying[], timestamptz, timestamptz) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.get_deploy_daily_counts(character varying[], timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_deploy_daily_counts(character varying[], timestamptz, timestamptz) TO authenticated, service_role;
