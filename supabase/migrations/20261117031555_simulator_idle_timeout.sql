ALTER TABLE public.simulator_sessions
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

UPDATE public.simulator_sessions
SET last_activity_at = now()
WHERE last_activity_at IS NULL
  AND status IN ('new', 'queued', 'starting', 'in-progress');

UPDATE public.simulator_sessions
SET last_activity_at = COALESCE(started_at, created_at)
WHERE last_activity_at IS NULL;

-- Idle window is five minutes here and SIMULATOR_IDLE_TIMEOUT_MINUTES (5) in the API worker.
CREATE INDEX IF NOT EXISTS simulator_sessions_idle_sweep_idx
  ON public.simulator_sessions (last_activity_at)
  WHERE status IN ('new', 'queued', 'starting', 'in-progress');

-- Stop when the session hits its max duration or five minutes without API activity.
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
  opened_at timestamptz;
  activity_at timestamptz;
  effective_stop timestamptz;
BEGIN
  FOR session_row IN
    SELECT id, app_id, platform, requested_by, max_duration_minutes,
           started_at, created_at, last_activity_at, device_stopped_at
    FROM public.simulator_sessions
    WHERE owner_org = p_org_id
      AND status IN ('new', 'queued', 'starting', 'in-progress')
      AND (
        COALESCE(started_at, created_at) <= now() - make_interval(mins => max_duration_minutes)
        OR COALESCE(last_activity_at, started_at, created_at) <= now() - interval '5 minutes'
      )
    FOR UPDATE
  LOOP
  IF session_row.started_at IS NULL THEN
    elapsed := 0;
    effective_stop := COALESCE(session_row.device_stopped_at, now());
  ELSE
    opened_at := session_row.started_at;
    activity_at := COALESCE(session_row.last_activity_at, session_row.started_at);
    effective_stop := LEAST(
      COALESCE(session_row.device_stopped_at, now()),
      opened_at + make_interval(mins => session_row.max_duration_minutes),
      activity_at + interval '5 minutes'
    );
    elapsed := LEAST(
      session_row.max_duration_minutes * 60,
      GREATEST(1, round(extract(epoch FROM (effective_stop - opened_at)))::bigint)
    );
  END IF;
    IF elapsed > 0 THEN
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
        effective_stop
      )
      ON CONFLICT (build_id, org_id) DO NOTHING;
    END IF;
    UPDATE public.simulator_sessions
    SET status = 'stopped',
        finished_at = effective_stop,
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

CREATE OR REPLACE FUNCTION public.settle_simulator_sessions_before_app_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  session_row record;
  elapsed bigint;
  opened_at timestamptz;
  activity_at timestamptz;
  effective_stop timestamptz;
BEGIN
  IF public.is_org_delete_cascade(OLD.owner_org) THEN
    RETURN OLD;
  END IF;

  FOR session_row IN
    SELECT id, owner_org, platform, requested_by, max_duration_minutes,
           started_at, created_at, last_activity_at, device_stopped_at
    FROM public.simulator_sessions
    WHERE app_id = OLD.app_id
      AND status IN ('new', 'queued', 'starting', 'in-progress')
    FOR UPDATE
  LOOP
  IF session_row.started_at IS NULL THEN
    elapsed := 0;
    effective_stop := COALESCE(session_row.device_stopped_at, now());
  ELSE
    opened_at := session_row.started_at;
    activity_at := COALESCE(session_row.last_activity_at, session_row.started_at);
    effective_stop := LEAST(
      COALESCE(session_row.device_stopped_at, now()),
      opened_at + make_interval(mins => session_row.max_duration_minutes),
      activity_at + interval '5 minutes'
    );
    elapsed := LEAST(
      session_row.max_duration_minutes * 60,
      GREATEST(1, round(extract(epoch FROM (effective_stop - opened_at)))::bigint)
    );
  END IF;
    IF elapsed > 0 THEN
      INSERT INTO public.build_logs (
        org_id, user_id, build_id, platform, build_time_unit, billable_seconds, app_id, created_at
      )
      VALUES (
        session_row.owner_org,
        (SELECT id FROM auth.users WHERE id = session_row.requested_by),
        session_row.id::varchar,
        session_row.platform,
        elapsed,
        elapsed * CASE session_row.platform WHEN 'ios' THEN 2 ELSE 1 END,
        OLD.app_id,
        effective_stop
      )
      ON CONFLICT (build_id, org_id) DO NOTHING;
    END IF;
  END LOOP;
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.settle_simulator_sessions_before_app_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.settle_simulator_sessions_before_app_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_simulator_sessions_before_app_delete() FROM anon;
REVOKE ALL ON FUNCTION public.settle_simulator_sessions_before_app_delete() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settle_simulator_sessions_before_app_delete() TO service_role;