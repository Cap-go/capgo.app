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
  requested_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  max_duration_minutes integer NOT NULL DEFAULT 40 CHECK (max_duration_minutes BETWEEN 1 AND 115),
  started_at timestamptz,
  -- Set when the device itself has stopped, before build minutes are recorded.
  device_stopped_at timestamptz,
  finished_at timestamptz
);

ALTER TABLE public.simulator_sessions OWNER TO postgres;

COMMENT ON TABLE public.simulator_sessions IS
  'Cloud simulator sessions. A row in new, queued, starting, or in-progress uses one native builder slot and build minutes when it stops.';

CREATE INDEX simulator_sessions_owner_active_idx
  ON public.simulator_sessions (owner_org)
  WHERE status IN ('new', 'queued', 'starting', 'in-progress');

CREATE INDEX simulator_sessions_app_active_idx
  ON public.simulator_sessions (app_id)
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
           COALESCE(started_at, created_at) AS opened_at,
           COALESCE(device_stopped_at, now()) AS closed_at
    FROM public.simulator_sessions
    WHERE owner_org = p_org_id
      AND status IN ('new', 'queued', 'starting', 'in-progress')
      AND COALESCE(started_at, created_at) <= now() - make_interval(mins => max_duration_minutes)
    FOR UPDATE
  LOOP
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

-- App deletion cascades the session row. Write the usage first so the minutes survive.
CREATE OR REPLACE FUNCTION public.settle_simulator_sessions_before_app_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  session_row record;
  elapsed bigint;
BEGIN
  -- Organization deletion cascades apps, then this trigger. The org row is already
  -- gone, and build_logs are removed with it, so settlement would fail the delete.
  IF public.is_org_delete_cascade(OLD.owner_org) THEN
    RETURN OLD;
  END IF;

  FOR session_row IN
    SELECT id, owner_org, platform, requested_by, max_duration_minutes,
           COALESCE(started_at, created_at) AS opened_at,
           COALESCE(device_stopped_at, now()) AS closed_at
    FROM public.simulator_sessions
    WHERE app_id = OLD.app_id
      AND status IN ('new', 'queued', 'starting', 'in-progress')
    FOR UPDATE
  LOOP
    elapsed := LEAST(
      session_row.max_duration_minutes * 60,
      GREATEST(0, round(extract(epoch FROM (session_row.closed_at - session_row.opened_at)))::bigint)
    );
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
        session_row.opened_at + make_interval(secs => elapsed)
      )
      ON CONFLICT (build_id, org_id) DO NOTHING;
    END IF;
  END LOOP;
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.settle_simulator_sessions_before_app_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.settle_simulator_sessions_before_app_delete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_simulator_sessions_before_app_delete() TO service_role;

CREATE TRIGGER settle_simulator_sessions_before_app_delete
BEFORE DELETE ON public.apps
FOR EACH ROW
EXECUTE FUNCTION public.settle_simulator_sessions_before_app_delete();

-- transfer_app moves the app, then get and stop look up the session under the new
-- organization. Stop the device first so the original organization is billed and the slot is released.
CREATE OR REPLACE FUNCTION public.reject_app_transfer_with_active_simulator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.owner_org IS NOT DISTINCT FROM OLD.owner_org THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.simulator_sessions
    WHERE app_id = OLD.app_id
      AND status IN ('new', 'queued', 'starting', 'in-progress')
  ) THEN
    RAISE EXCEPTION 'Stop the running simulator before transferring this app.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.reject_app_transfer_with_active_simulator() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_app_transfer_with_active_simulator() FROM PUBLIC;

CREATE TRIGGER reject_app_transfer_with_active_simulator
BEFORE UPDATE OF owner_org ON public.apps
FOR EACH ROW
EXECUTE FUNCTION public.reject_app_transfer_with_active_simulator();
