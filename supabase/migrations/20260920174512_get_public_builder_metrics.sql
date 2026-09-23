-- Public builder metrics for website /builder-metrics.json (anon RPC).
-- Rates and shares only — no raw job counts, org/app ids, or last_error text.

CREATE OR REPLACE FUNCTION public.get_public_builder_metrics()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_period_days integer := 30;
  v_window_start timestamptz := timezone('utc', now()) - make_interval(days => 30);
  v_successes bigint := 0;
  v_failures bigint := 0;
  v_total bigint := 0;
  v_avg_process double precision;
  v_avg_queue double precision;
  v_daily jsonb := '[]'::jsonb;
  v_failures_json jsonb := '[]'::jsonb;
  v_platforms jsonb := '[]'::jsonb;
  v_success_rate numeric := 0;
BEGIN
  WITH terminal AS (
    SELECT
      br.platform::text AS platform,
      (timezone('utc', br.created_at))::date AS day,
      CASE
        WHEN br.status IN ('succeeded', 'completed') THEN 'success'
        WHEN br.status IN ('failed', 'cancelled', 'canceled', 'expired') THEN 'failure'
        ELSE NULL
      END AS outcome,
      CASE
        WHEN br.started_at IS NOT NULL
          AND br.completed_at IS NOT NULL
          AND br.completed_at >= br.started_at
        THEN EXTRACT(EPOCH FROM (br.completed_at - br.started_at))::double precision
        ELSE NULL
      END AS process_seconds,
      br.runner_wait_seconds::double precision AS queue_seconds,
      CASE
        WHEN br.status IN ('failed', 'cancelled', 'canceled', 'expired') THEN
          CASE
            WHEN lower(COALESCE(br.last_error, '')) LIKE '%script_failure%' THEN 'script_failure'
            WHEN lower(COALESCE(br.last_error, '')) LIKE '%timeout%' THEN 'timeout'
            WHEN lower(COALESCE(br.last_error, '')) LIKE '%runner_system_failure%' THEN 'runner_system_failure'
            WHEN lower(COALESCE(br.last_error, '')) LIKE '%runner is not available%'
              OR lower(COALESCE(br.last_error, '')) LIKE '%runner unavailable%' THEN 'runner_unavailable'
            ELSE 'other'
          END
        ELSE NULL
      END AS failure_reason
    FROM public.build_requests AS br
    WHERE br.created_at >= v_window_start
      AND br.platform IN ('ios', 'android')
  ),
  scored AS (
    SELECT * FROM terminal WHERE outcome IS NOT NULL
  ),
  totals AS (
    SELECT
      COUNT(*) FILTER (WHERE outcome = 'success') AS successes,
      COUNT(*) FILTER (WHERE outcome = 'failure') AS failures,
      AVG(process_seconds) FILTER (WHERE process_seconds IS NOT NULL) AS avg_process,
      AVG(queue_seconds) FILTER (WHERE queue_seconds IS NOT NULL) AS avg_queue
    FROM scored
  ),
  daily AS (
    SELECT
      day,
      ROUND((
        COUNT(*) FILTER (WHERE platform = 'ios' AND outcome = 'success')::numeric
        / NULLIF(COUNT(*) FILTER (WHERE platform = 'ios'), 0)::numeric
      ) * 100, 1) AS ios_rate,
      ROUND((
        COUNT(*) FILTER (WHERE platform = 'android' AND outcome = 'success')::numeric
        / NULLIF(COUNT(*) FILTER (WHERE platform = 'android'), 0)::numeric
      ) * 100, 1) AS android_rate,
      ROUND(AVG(process_seconds) FILTER (WHERE platform = 'ios' AND process_seconds IS NOT NULL)::numeric, 1) AS ios_process,
      ROUND(AVG(process_seconds) FILTER (WHERE platform = 'android' AND process_seconds IS NOT NULL)::numeric, 1) AS android_process
    FROM scored
    GROUP BY day
  ),
  failure_roll AS (
    SELECT
      failure_reason AS reason,
      COUNT(*)::bigint AS n
    FROM scored
    WHERE outcome = 'failure' AND failure_reason IS NOT NULL
    GROUP BY failure_reason
  ),
  failure_total AS (
    SELECT COALESCE(SUM(n), 0)::bigint AS total FROM failure_roll
  ),
  platform_roll AS (
    SELECT
      platform AS key,
      COUNT(*)::bigint AS outcomes,
      COUNT(*) FILTER (WHERE outcome = 'success')::bigint AS successes,
      COUNT(*) FILTER (WHERE outcome = 'failure')::bigint AS failures,
      AVG(process_seconds) FILTER (WHERE process_seconds IS NOT NULL) AS avg_process,
      AVG(queue_seconds) FILTER (WHERE queue_seconds IS NOT NULL) AS avg_queue
    FROM scored
    GROUP BY platform
  ),
  platform_outcome_total AS (
    SELECT COALESCE(SUM(outcomes), 0)::bigint AS total FROM platform_roll
  ),
  platform_failure_roll AS (
    SELECT
      platform,
      failure_reason AS reason,
      COUNT(*)::bigint AS n
    FROM scored
    WHERE outcome = 'failure' AND failure_reason IS NOT NULL
    GROUP BY platform, failure_reason
  ),
  platform_failure_ranked AS (
    SELECT
      pfr.platform,
      pfr.reason,
      pfr.n,
      SUM(pfr.n) OVER (PARTITION BY pfr.platform) AS platform_failure_total,
      ROW_NUMBER() OVER (PARTITION BY pfr.platform ORDER BY pfr.n DESC, pfr.reason ASC) AS rn
    FROM platform_failure_roll AS pfr
  )
  SELECT
    t.successes,
    t.failures,
    t.avg_process,
    t.avg_queue,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'date', d.day::text,
          'ios', d.ios_rate,
          'android', d.android_rate,
          'ios_process_seconds', d.ios_process,
          'android_process_seconds', d.android_process
        )
        ORDER BY d.day
      )
      FROM daily AS d
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'reason', fr.reason,
          'share', ROUND((fr.n::numeric / NULLIF(ft.total, 0)::numeric) * 100, 1)
        )
        ORDER BY (fr.n::numeric / NULLIF(ft.total, 0)::numeric) DESC, fr.reason ASC
      )
      FROM failure_roll AS fr
      CROSS JOIN failure_total AS ft
      WHERE ft.total > 0
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'key', pr.key,
          'share', ROUND((pr.outcomes::numeric / NULLIF(pot.total, 0)::numeric) * 100, 1),
          'success_rate', CASE
            WHEN (pr.successes + pr.failures) > 0
            THEN ROUND((pr.successes::numeric / (pr.successes + pr.failures)::numeric) * 100, 1)
            ELSE NULL
          END,
          'avg_process_seconds', ROUND(pr.avg_process::numeric, 1),
          'avg_queue_seconds', ROUND(pr.avg_queue::numeric, 1),
          'top_failure', (
            SELECT CASE
              WHEN pfr.reason IS NULL THEN NULL
              ELSE jsonb_build_object(
                'reason', pfr.reason,
                'share', ROUND((pfr.n::numeric / NULLIF(pfr.platform_failure_total, 0)::numeric) * 100, 1)
              )
            END
            FROM platform_failure_ranked AS pfr
            WHERE pfr.platform = pr.key AND pfr.rn = 1
          )
        )
        ORDER BY pr.outcomes DESC, pr.key ASC
      )
      FROM platform_roll AS pr
      CROSS JOIN platform_outcome_total AS pot
    ), '[]'::jsonb)
  INTO
    v_successes,
    v_failures,
    v_avg_process,
    v_avg_queue,
    v_daily,
    v_failures_json,
    v_platforms
  FROM totals AS t;

  v_total := COALESCE(v_successes, 0) + COALESCE(v_failures, 0);
  IF v_total > 0 THEN
    v_success_rate := ROUND((COALESCE(v_successes, 0)::numeric / v_total::numeric) * 100, 1);
  ELSE
    v_success_rate := 0;
  END IF;

  RETURN jsonb_build_object(
    'success_rate', v_success_rate,
    'avg_process_seconds', CASE WHEN v_avg_process IS NULL THEN NULL ELSE ROUND(v_avg_process::numeric, 1) END,
    'avg_queue_seconds', CASE WHEN v_avg_queue IS NULL THEN NULL ELSE ROUND(v_avg_queue::numeric, 1) END,
    'period_days', v_period_days,
    'updated_at', timezone('utc', now()),
    'daily_platforms', COALESCE(v_daily, '[]'::jsonb),
    'failures', COALESCE(v_failures_json, '[]'::jsonb),
    'platforms', COALESCE(v_platforms, '[]'::jsonb)
  );
END;
$$;

ALTER FUNCTION public.get_public_builder_metrics() OWNER TO postgres;

COMMENT ON FUNCTION public.get_public_builder_metrics() IS
  'Public Capgo builder metrics for the marketing site. Returns rates/shares only over the last 30 days of build_requests. SECURITY DEFINER; safe for anon.';

REVOKE ALL ON FUNCTION public.get_public_builder_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_builder_metrics() TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_builder_metrics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_builder_metrics() TO service_role;
