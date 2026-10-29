-- A running simulator takes one native builder slot, the same limit as a native build.
-- Rows are written by the API with the service connection. Clients cannot read this table.
CREATE TABLE public.simulator_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  owner_org uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES public.apps (app_id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  name text,
  status text NOT NULL DEFAULT 'starting' CHECK (status IN ('new', 'queued', 'starting', 'in-progress', 'stopped', 'errored')),
  url text,
  emulator_id text,
  requested_by uuid NOT NULL,
  max_duration_minutes integer NOT NULL DEFAULT 40 CHECK (max_duration_minutes BETWEEN 1 AND 115),
  started_at timestamptz,
  finished_at timestamptz
);

ALTER TABLE public.simulator_sessions OWNER TO postgres;

COMMENT ON TABLE public.simulator_sessions IS
  'Cloud simulator sessions. A row in new, queued, starting, or in-progress uses one native builder slot and build minutes when it stops.';

CREATE INDEX simulator_sessions_owner_active_idx
  ON public.simulator_sessions (owner_org)
  WHERE status IN ('new', 'queued', 'starting', 'in-progress');

ALTER TABLE public.simulator_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all direct access" ON public.simulator_sessions AS RESTRICTIVE USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.simulator_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.simulator_sessions FROM anon;
REVOKE ALL ON TABLE public.simulator_sessions FROM authenticated;
GRANT ALL ON TABLE public.simulator_sessions TO service_role;

-- A session past its duration no longer holds a builder slot, and its open time is billed.
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
    SELECT id, app_id, platform, requested_by, max_duration_minutes,
           COALESCE(started_at, created_at) AS opened_at
    FROM public.simulator_sessions
    WHERE owner_org = p_org_id
      AND status IN ('new', 'queued', 'starting', 'in-progress')
      AND COALESCE(started_at, created_at) <= now() - make_interval(mins => max_duration_minutes)
    FOR UPDATE
  LOOP
    elapsed := LEAST(
      session_row.max_duration_minutes * 60,
      GREATEST(1, floor(extract(epoch FROM (now() - session_row.opened_at)))::bigint)
    );
    PERFORM public.record_build_time(
      p_org_id => p_org_id,
      p_user_id => session_row.requested_by,
      p_build_id => session_row.id::varchar,
      p_platform => session_row.platform,
      p_build_time_unit => elapsed,
      p_app_id => session_row.app_id
    );
    UPDATE public.simulator_sessions
    SET status = 'stopped', finished_at = now(), updated_at = now()
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
