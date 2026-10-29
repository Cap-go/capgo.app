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
