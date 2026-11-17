-- The device host now stops a simulator after a few minutes without input. When the API
-- learns that stop (device_stopped_at), settle the session at once: it frees its builder
-- slot and is billed up to the stop, instead of staying open until its maximum duration.
CREATE OR REPLACE FUNCTION public.expire_simulator_sessions(p_org_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  expired_count integer := 0;
  session_row record;
  elapsed bigint;
BEGIN
  FOR session_row IN
    SELECT id, app_id, platform, requested_by, max_duration_minutes, started_at, device_stopped_at,
           COALESCE(started_at, created_at) AS opened_at,
           COALESCE(device_stopped_at, now()) AS closed_at
    FROM public.simulator_sessions
    WHERE owner_org = p_org_id
      AND status IN ('new', 'queued', 'starting', 'in-progress')
      AND (
        device_stopped_at IS NOT NULL
        OR COALESCE(started_at, created_at) <= now() - make_interval(mins => max_duration_minutes)
      )
    FOR UPDATE
  LOOP
    -- A device stopped before the session started ran nothing for the user: like an explicit
    -- stop, it costs nothing. (The created_at fallback stays for maximum-duration cleanup only.)
    IF session_row.device_stopped_at IS NOT NULL AND session_row.started_at IS NULL THEN
      UPDATE public.simulator_sessions
      SET status = 'stopped',
          finished_at = session_row.device_stopped_at,
          updated_at = now()
      WHERE id = session_row.id;
      expired_count := expired_count + 1;
      CONTINUE;
    END IF;
    elapsed := LEAST(
      session_row.max_duration_minutes * 60,
      GREATEST(1, round(extract(epoch FROM (session_row.closed_at - session_row.opened_at)))::bigint)
    );
    -- Write the log here. record_build_time rejects the call unless the request
    -- role is internal, and this sweeper runs from whichever connection holds the slot lock.
    INSERT INTO public.build_logs (
      org_id, user_id, build_id, platform, build_time_unit, billable_seconds, app_id, created_at
    )
    VALUES (
      p_org_id,
      (SELECT id FROM auth.users WHERE id = session_row.requested_by),
      session_row.id::varchar,
      session_row.platform,
      elapsed,
      elapsed * CASE session_row.platform WHEN 'ios' THEN 2 ELSE 1 END,
      session_row.app_id,
      session_row.opened_at + make_interval(secs => elapsed)
    )
    ON CONFLICT (build_id, org_id) DO NOTHING;
    UPDATE public.simulator_sessions
    SET status = 'stopped',
        finished_at = session_row.opened_at + make_interval(secs => elapsed),
        updated_at = now()
    WHERE id = session_row.id;
    expired_count := expired_count + 1;
  END LOOP;
  RETURN expired_count;
END;
$$;

ALTER FUNCTION public.expire_simulator_sessions(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.expire_simulator_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_simulator_sessions(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.expire_simulator_sessions(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_simulator_sessions(uuid) TO service_role;

-- The console lists an app's recent simulators with the build time each one used.
CREATE INDEX simulator_sessions_org_app_recent_idx
  ON public.simulator_sessions (owner_org, app_id, created_at DESC);
