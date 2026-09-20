-- Public aggregate builder metrics for the marketing /builder-metrics page.
-- Returns only rounded rates/shares; never raw last_error, counts, org/app ids.
CREATE OR REPLACE FUNCTION public.get_public_builder_metrics()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
WITH params AS (
  SELECT
    (timezone('UTC', now())::date - 29) AS period_start,
    timezone('UTC', now())::date AS period_end,
    now() AS updated_at
),
base AS (
  SELECT
    br.platform,
    (br.created_at AT TIME ZONE 'UTC')::date AS build_date,
    CASE
      WHEN br.status IN ('succeeded', 'completed') THEN 'succeeded'
      WHEN br.status IN ('failed', 'cancelled', 'canceled', 'expired') THEN 'failed'
      ELSE NULL
    END AS outcome,
    CASE
      WHEN br.started_at IS NOT NULL
        AND br.completed_at IS NOT NULL
        AND br.completed_at >= br.started_at
      THEN EXTRACT(EPOCH FROM (br.completed_at - br.started_at))::numeric
      ELSE NULL
    END AS process_seconds,
    br.runner_wait_seconds::numeric AS queue_seconds,
    br.last_error
  FROM public.build_requests br
  CROSS JOIN params p
  WHERE br.platform IN ('ios', 'android')
    AND br.created_at >= (p.period_start::timestamp AT TIME ZONE 'UTC')
    AND br.created_at < ((p.period_end + 1)::timestamp AT TIME ZONE 'UTC')
),
terminal AS (
  SELECT *
  FROM base
  WHERE outcome IS NOT NULL
),
classified_failures AS (
  SELECT
    platform,
    CASE
      WHEN lower(COALESCE(last_error, '')) LIKE '%script_failure%' THEN 'script_failure'
      WHEN lower(COALESCE(last_error, '')) LIKE '%timeout%' THEN 'timeout'
      WHEN lower(COALESCE(last_error, '')) LIKE '%runner_system_failure%' THEN 'runner_system_failure'
      WHEN lower(COALESCE(last_error, '')) LIKE '%runner is not available%'
        OR lower(COALESCE(last_error, '')) LIKE '%runner unavailable%' THEN 'runner_unavailable'
      ELSE 'other'
    END AS reason
  FROM terminal
  WHERE outcome = 'failed'
),
platform_stats AS (
  SELECT
    platform,
    COUNT(*) FILTER (WHERE outcome = 'succeeded')::numeric AS successes,
    COUNT(*) FILTER (WHERE outcome = 'failed')::numeric AS failures,
    AVG(process_seconds) AS avg_process_seconds,
    AVG(queue_seconds) AS avg_queue_seconds
  FROM terminal
  GROUP BY platform
),
platform_rows AS (
  SELECT
    ps.platform,
    ps.successes,
    ps.failures,
    ps.successes + ps.failures AS outcomes,
    CASE
      WHEN ps.successes + ps.failures > 0
      THEN round((ps.successes / (ps.successes + ps.failures) * 100)::numeric, 1)
      ELSE NULL
    END AS success_rate,
    CASE
      WHEN ps.avg_process_seconds IS NOT NULL
      THEN round(ps.avg_process_seconds::numeric, 1)
      ELSE NULL
    END AS avg_process_seconds,
    CASE
      WHEN ps.avg_queue_seconds IS NOT NULL
      THEN round(ps.avg_queue_seconds::numeric, 1)
      ELSE NULL
    END AS avg_queue_seconds
  FROM platform_stats ps
),
platform_failure_counts AS (
  SELECT
    platform,
    reason,
    COUNT(*)::numeric AS failures
  FROM classified_failures
  GROUP BY platform, reason
),
platform_failure_totals AS (
  SELECT
    platform,
    SUM(failures) AS total_failures
  FROM platform_failure_counts
  GROUP BY platform
),
platform_top_failures AS (
  SELECT DISTINCT ON (pfc.platform)
    pfc.platform,
    pfc.reason,
    round((pfc.failures / pft.total_failures * 100)::numeric, 1) AS share
  FROM platform_failure_counts pfc
  INNER JOIN platform_failure_totals pft ON pft.platform = pfc.platform
  ORDER BY
    pfc.platform,
    round((pfc.failures / pft.total_failures * 100)::numeric, 1) DESC,
    pfc.reason ASC
),
daily_stats AS (
  SELECT
    build_date,
    platform,
    COUNT(*) FILTER (WHERE outcome = 'succeeded')::numeric AS successes,
    COUNT(*) FILTER (WHERE outcome = 'failed')::numeric AS failures,
    AVG(process_seconds) AS avg_process_seconds
  FROM terminal
  GROUP BY build_date, platform
),
daily_dates AS (
  SELECT DISTINCT build_date
  FROM terminal
),
daily_rows AS (
  SELECT
    dd.build_date AS date,
    CASE
      WHEN ios.successes + ios.failures > 0
      THEN round((ios.successes / (ios.successes + ios.failures) * 100)::numeric, 1)
      ELSE NULL
    END AS ios,
    CASE
      WHEN android.successes + android.failures > 0
      THEN round((android.successes / (android.successes + android.failures) * 100)::numeric, 1)
      ELSE NULL
    END AS android,
    CASE
      WHEN ios.avg_process_seconds IS NOT NULL
      THEN round(ios.avg_process_seconds::numeric, 1)
      ELSE NULL
    END AS ios_process_seconds,
    CASE
      WHEN android.avg_process_seconds IS NOT NULL
      THEN round(android.avg_process_seconds::numeric, 1)
      ELSE NULL
    END AS android_process_seconds
  FROM daily_dates dd
  LEFT JOIN daily_stats ios
    ON ios.build_date = dd.build_date
   AND ios.platform = 'ios'
  LEFT JOIN daily_stats android
    ON android.build_date = dd.build_date
   AND android.platform = 'android'
),
failure_counts AS (
  SELECT
    reason,
    COUNT(*)::numeric AS failures
  FROM classified_failures
  GROUP BY reason
),
failure_total AS (
  SELECT COALESCE(SUM(failures), 0::numeric) AS total_failures
  FROM failure_counts
),
failure_rows AS (
  SELECT
    fc.reason,
    round((fc.failures / ft.total_failures * 100)::numeric, 1) AS share
  FROM failure_counts fc
  CROSS JOIN failure_total ft
  WHERE ft.total_failures > 0
),
totals AS (
  SELECT
    COALESCE(SUM(successes), 0::numeric) AS success_total,
    COALESCE(SUM(failures), 0::numeric) AS failure_total,
    COALESCE(SUM(outcomes), 0::numeric) AS outcome_total
  FROM platform_rows
),
-- Weight by platform outcomes (not per-row duration sample counts) to match
-- website buildPublicBuilderMetrics in Cap-go/website publicBuilderMetrics.ts.
weighted AS (
  SELECT
    CASE
      WHEN SUM(outcomes) FILTER (WHERE avg_process_seconds IS NOT NULL) > 0
      THEN round(
        (
          SUM(avg_process_seconds * outcomes) FILTER (WHERE avg_process_seconds IS NOT NULL)
          / SUM(outcomes) FILTER (WHERE avg_process_seconds IS NOT NULL)
        )::numeric,
        1
      )
      ELSE NULL
    END AS avg_process_seconds,
    CASE
      WHEN SUM(outcomes) FILTER (WHERE avg_queue_seconds IS NOT NULL) > 0
      THEN round(
        (
          SUM(avg_queue_seconds * outcomes) FILTER (WHERE avg_queue_seconds IS NOT NULL)
          / SUM(outcomes) FILTER (WHERE avg_queue_seconds IS NOT NULL)
        )::numeric,
        1
      )
      ELSE NULL
    END AS avg_queue_seconds
  FROM platform_rows
),
platform_payload AS (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'key', pr.platform,
        'share',
          CASE
            WHEN t.outcome_total > 0
            THEN round((pr.outcomes / t.outcome_total * 100)::numeric, 1)
            ELSE 0::numeric
          END,
        'success_rate', pr.success_rate,
        'avg_process_seconds', pr.avg_process_seconds,
        'avg_queue_seconds', pr.avg_queue_seconds,
        'top_failure',
          CASE
            WHEN ptf.reason IS NULL THEN NULL
            ELSE jsonb_build_object(
              'reason', ptf.reason,
              'share', ptf.share
            )
          END
      )
      ORDER BY pr.outcomes DESC, pr.platform ASC
    ),
    '[]'::jsonb
  ) AS platforms
  FROM platform_rows pr
  CROSS JOIN totals t
  LEFT JOIN platform_top_failures ptf ON ptf.platform = pr.platform
)
SELECT jsonb_build_object(
  'success_rate',
    CASE
      WHEN t.success_total + t.failure_total > 0
      THEN round((t.success_total / (t.success_total + t.failure_total) * 100)::numeric, 1)
      ELSE 0::numeric
    END,
  'avg_process_seconds', w.avg_process_seconds,
  'avg_queue_seconds', w.avg_queue_seconds,
  'period_days', 30,
  'updated_at', to_jsonb(p.updated_at)#>>'{}',
  'daily_platforms', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'date', dr.date::text,
          'ios', dr.ios,
          'android', dr.android,
          'ios_process_seconds', dr.ios_process_seconds,
          'android_process_seconds', dr.android_process_seconds
        )
        ORDER BY dr.date ASC
      )
      FROM daily_rows dr
    ),
    '[]'::jsonb
  ),
  'failures', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'reason', fr.reason,
          'share', fr.share
        )
        ORDER BY fr.share DESC, fr.reason ASC
      )
      FROM failure_rows fr
    ),
    '[]'::jsonb
  ),
  'platforms', pp.platforms
)
FROM params p
CROSS JOIN totals t
CROSS JOIN weighted w
CROSS JOIN platform_payload pp;
$function$;

ALTER FUNCTION public.get_public_builder_metrics() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_public_builder_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_builder_metrics() TO anon, authenticated;

COMMENT ON FUNCTION public.get_public_builder_metrics() IS
  'Public marketing aggregate of native build outcomes for the last 30 days. Exposes rounded rates/shares only; no raw errors, counts, or tenant identifiers.';
