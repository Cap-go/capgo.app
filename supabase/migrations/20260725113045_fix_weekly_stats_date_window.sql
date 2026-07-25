-- get_weekly_stats previously used CURRENT_DATE - 7 days with an inclusive BETWEEN,
-- which covers 8 calendar days. Use a 7-day inclusive window instead.
CREATE OR REPLACE FUNCTION "public"."get_weekly_stats"("app_id" character varying)
RETURNS TABLE("all_updates" bigint, "failed_updates" bigint, "open_app" bigint)
LANGUAGE "plpgsql"
SET "search_path" TO ''
AS $$
DECLARE
  period_start DATE;
BEGIN
  -- Inclusive 7-day window: today and the previous 6 days.
  period_start := CURRENT_DATE - INTERVAL '6 days';
  SELECT COALESCE(SUM(install), 0) INTO all_updates
  FROM public.daily_version
  WHERE date BETWEEN period_start AND CURRENT_DATE
    AND public.daily_version.app_id = get_weekly_stats.app_id;
  SELECT COALESCE(SUM(fail), 0) INTO failed_updates
  FROM public.daily_version
  WHERE date BETWEEN period_start AND CURRENT_DATE
    AND public.daily_version.app_id = get_weekly_stats.app_id;
  SELECT COALESCE(SUM(get), 0) INTO open_app
  FROM public.daily_version
  WHERE date BETWEEN period_start AND CURRENT_DATE
    AND public.daily_version.app_id = get_weekly_stats.app_id;
  RETURN QUERY SELECT all_updates, failed_updates, open_app;
END;
$$;
