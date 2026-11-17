-- Console request fan-out: aggregate and batch reads the dashboard used to
-- issue as many separate requests.

-- 1. Daily update stats for the dashboard update chart. The console used to
--    download every daily_version row of the window (one row per app, bundle
--    and day, 1000 per request, one request after another) only to sum them
--    per app and day. Security invoker: the caller's RLS on daily_version
--    still decides which rows count. Same bounds as the other dashboard daily
--    counts (assert_console_daily_window): at most 370 days and 1000 apps.
--    p_end is inclusive (daily_version.date is a calendar date).
CREATE OR REPLACE FUNCTION public.get_update_daily_counts(
  p_app_ids character varying[],
  p_start date,
  p_end date
)
RETURNS TABLE (
  app_id character varying,
  date date,
  install_count bigint,
  fail_count bigint,
  get_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL THEN
    RAISE EXCEPTION 'invalid_window' USING ERRCODE = '22023', DETAIL = 'The window must be positive and at most 370 days.';
  END IF;
  PERFORM public.assert_console_daily_window(
    p_app_ids,
    p_start::timestamp AT TIME ZONE 'UTC',
    (p_end + 1)::timestamp AT TIME ZONE 'UTC'
  );
  RETURN QUERY
  SELECT
    dv.app_id,
    dv.date,
    coalesce(sum(dv.install), 0)::bigint,
    coalesce(sum(dv.fail), 0)::bigint,
    coalesce(sum(dv.get), 0)::bigint
  FROM public.daily_version dv
  WHERE dv.app_id = ANY (p_app_ids)
    AND dv.date >= p_start
    AND dv.date <= p_end
  GROUP BY dv.app_id, dv.date
  -- Stable order so callers can page past the API's per-request row cap.
  ORDER BY dv.app_id, dv.date;
END;
$$;

ALTER FUNCTION public.get_update_daily_counts(character varying[], date, date) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.get_update_daily_counts(character varying[], date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_update_daily_counts(character varying[], date, date) TO authenticated, service_role;

-- 2. Accept several compatibility events in one request (bulk acknowledge on
--    the observe page sent one RPC per event). Security invoker: every id goes
--    through acknowledge_compatibility_event, which keeps its own RBAC check
--    and its uniform not_authorized error (no existence oracle). All or
--    nothing: one refused id rolls the whole batch back.
CREATE OR REPLACE FUNCTION public.acknowledge_compatibility_events(
  event_ids bigint[],
  note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_event_id bigint;
BEGIN
  IF note IS NULL OR length(btrim(note)) = 0 THEN
    RAISE EXCEPTION 'reason_required';
  END IF;
  IF coalesce(cardinality(event_ids), 0) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(event_ids) > 500 THEN
    RAISE EXCEPTION 'too_many_events' USING ERRCODE = '22023', DETAIL = 'At most 500 events per request.';
  END IF;
  FOREACH v_event_id IN ARRAY event_ids LOOP
    PERFORM public.acknowledge_compatibility_event(v_event_id, note);
  END LOOP;
END;
$$;

ALTER FUNCTION public.acknowledge_compatibility_events(bigint[], text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.acknowledge_compatibility_events(bigint[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_compatibility_events(bigint[], text) TO authenticated, service_role;

-- 3. Recent earlier deployments of several channels in one request (the bundle
--    compare picker sent one deploy_history query per channel). For each
--    channel: up to p_per_channel deployments of another bundle, older than
--    that channel's cutoff when one is given, newest first. Security invoker:
--    deploy_history RLS still applies. Each channel is one bounded lookup on
--    the (channel_id, app_id) index.
CREATE OR REPLACE FUNCTION public.get_channels_previous_deploys(
  p_app_id character varying,
  p_exclude_version_id bigint,
  p_channel_ids bigint[],
  p_cutoffs timestamptz[],
  p_per_channel integer
)
RETURNS TABLE (
  channel_id bigint,
  version_id bigint,
  created_at timestamptz,
  deployed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(cardinality(p_channel_ids), 0) > 1000 THEN
    RAISE EXCEPTION 'too_many_channels' USING ERRCODE = '22023', DETAIL = 'At most 1000 channels per request.';
  END IF;
  IF p_cutoffs IS NOT NULL AND cardinality(p_cutoffs) <> coalesce(cardinality(p_channel_ids), 0) THEN
    RAISE EXCEPTION 'invalid_cutoffs' USING ERRCODE = '22023', DETAIL = 'One cutoff (or null) per channel.';
  END IF;
  IF p_per_channel IS NULL OR p_per_channel < 1 OR p_per_channel > 50 THEN
    RAISE EXCEPTION 'invalid_per_channel' USING ERRCODE = '22023', DETAIL = 'Between 1 and 50 deployments per channel.';
  END IF;
  IF coalesce(cardinality(p_channel_ids), 0) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    ch.channel_id,
    d.version_id,
    d.created_at,
    d.deployed_at
  FROM unnest(p_channel_ids, coalesce(p_cutoffs, array_fill(NULL::timestamptz, ARRAY[cardinality(p_channel_ids)])))
    WITH ORDINALITY AS ch(channel_id, cutoff, position)
  CROSS JOIN LATERAL (
    SELECT h.version_id, h.created_at, h.deployed_at
    FROM public.deploy_history h
    WHERE h.app_id = p_app_id
      AND h.channel_id = ch.channel_id
      AND (p_exclude_version_id IS NULL OR h.version_id <> p_exclude_version_id)
      AND (ch.cutoff IS NULL OR h.created_at < ch.cutoff)
    ORDER BY h.created_at DESC
    LIMIT p_per_channel
  ) d
  ORDER BY ch.position, d.created_at DESC;
END;
$$;

ALTER FUNCTION public.get_channels_previous_deploys(character varying, bigint, bigint[], timestamptz[], integer) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.get_channels_previous_deploys(character varying, bigint, bigint[], timestamptz[], integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_channels_previous_deploys(character varying, bigint, bigint[], timestamptz[], integer) TO authenticated, service_role;
