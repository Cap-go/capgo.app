-- Credit-only orgs keep stripe_info.status = canceled after trial ends while
-- paying via usage credits. Retention must not treat them as unpaid abandoned
-- orgs (same exemption rationale as has_usage_credits_org for the CLI).

CREATE OR REPLACE FUNCTION public.canceled_org_ids_past_grace(p_days integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.id
  FROM public.stripe_info AS si
  JOIN public.orgs AS o ON o.customer_id = si.customer_id
  WHERE si.status IN ('canceled', 'deleted')
    AND NOT COALESCE(o.has_usage_credits, false)
    AND GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at)
      <= pg_catalog.now() - make_interval(days => GREATEST(0, COALESCE(p_days, 0)));
$$;

ALTER FUNCTION public.canceled_org_ids_past_grace(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM anon;
REVOKE ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) FROM authenticated;
GRANT ALL ON FUNCTION public.canceled_org_ids_past_grace(integer) TO service_role;

COMMENT ON FUNCTION public.canceled_org_ids_past_grace(integer) IS
  'Org ids whose stripe_info is canceled/deleted, without active usage credits, '
  'and GREATEST(canceled_at, subscription_anchor_end, trial_at) is older than p_days.';

COMMENT ON FUNCTION public.long_canceled_org_ids() IS
  'Org ids past 90-day canceled grace without active usage credits '
  '(see canceled_org_ids_past_grace).';

CREATE OR REPLACE FUNCTION public.queue_canceled_org_retention_alerts(
  p_alert_type text,
  p_min_days integer,
  p_batch_size integer DEFAULT 500
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch_size integer := GREATEST(1, COALESCE(p_batch_size, 500));
  v_min_days integer := GREATEST(0, COALESCE(p_min_days, 0));
  v_max_days integer := v_min_days + 5;
  v_event text;
  v_queued bigint := 0;
  org_record RECORD;
  v_days_until integer;
BEGIN
  IF p_alert_type = 'bundles_deletion_warning' THEN
    v_event := 'org:bundles_will_be_deleted';
  ELSIF p_alert_type = 'app_deletion_warning' THEN
    v_event := 'org:apps_will_be_deleted';
  ELSE
    RAISE EXCEPTION 'unsupported retention alert type: %', p_alert_type;
  END IF;

  FOR org_record IN
    SELECT
      o.id AS org_id,
      o.name AS org_name,
      o.management_email,
      GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at) AS access_end,
      COALESCE(
        (
          SELECT jsonb_agg(a.app_id ORDER BY a.app_id)
          FROM public.apps AS a
          WHERE a.owner_org = o.id
        ),
        '[]'::jsonb
      ) AS app_ids
    FROM public.stripe_info AS si
    JOIN public.orgs AS o ON o.customer_id = si.customer_id
    WHERE si.status IN ('canceled', 'deleted')
      AND NOT COALESCE(o.has_usage_credits, false)
      AND GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at)
        <= pg_catalog.now() - make_interval(days => v_min_days)
      AND GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at)
        > pg_catalog.now() - make_interval(days => v_max_days)
      AND (
        CASE
          WHEN p_alert_type = 'bundles_deletion_warning' THEN EXISTS (
            SELECT 1
            FROM public.app_versions AS av
            WHERE av.owner_org = o.id
              AND av.deleted = false
              AND av.name NOT IN ('builtin', 'unknown')
          )
          ELSE EXISTS (
            SELECT 1
            FROM public.apps AS a
            WHERE a.owner_org = o.id
          )
        END
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.notifications AS n
        WHERE n.owner_org = o.id
          AND n.event = v_event
          AND n.uniq_id = (
            'retention:'
            || p_alert_type
            || ':'
            || to_char(
              GREATEST(si.canceled_at, si.subscription_anchor_end, si.trial_at) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS"Z"'
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pgmq.q_canceled_org_retention_alerts AS q
        WHERE q.message -> 'payload' ->> 'org_id' = o.id::text
          AND q.message -> 'payload' ->> 'alert_type' = p_alert_type
      )
    ORDER BY o.id
    LIMIT v_batch_size
  LOOP
    v_days_until := GREATEST(
      0,
      CEIL(
        EXTRACT(
          EPOCH FROM (
            org_record.access_end
            + make_interval(days => v_max_days)
            - pg_catalog.now()
          )
        ) / 86400.0
      )::integer
    );

    PERFORM pgmq.send(
      'canceled_org_retention_alerts',
      jsonb_build_object(
        'function_name', 'canceled_org_retention_alerts',
        'function_type', 'cloudflare',
        'payload', jsonb_build_object(
          'org_id', org_record.org_id,
          'org_name', org_record.org_name,
          'management_email', org_record.management_email,
          'alert_type', p_alert_type,
          'access_end', org_record.access_end,
          'days_until_deletion', v_days_until,
          'app_ids', org_record.app_ids
        )
      )
    );
    v_queued := v_queued + 1;
  END LOOP;

  IF v_queued > 0 THEN
    RAISE NOTICE
      'queue_canceled_org_retention_alerts: type=% queued=% window=[%,%)',
      p_alert_type,
      v_queued,
      v_min_days,
      v_max_days;
  END IF;

  RETURN v_queued;
END;
$$;

ALTER FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.queue_canceled_org_retention_alerts(text, integer, integer) IS
  'Queues once-per-cancel-cycle Bento/tracking warnings for canceled orgs '
  'without active usage credits in [p_min_days, p_min_days+5). Bundles require '
  'a deletable app_versions row; apps require an apps row. Dedup uniq_id uses '
  'access_end UTC timestamp.';
