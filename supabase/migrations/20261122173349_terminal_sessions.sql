-- Cloud terminal sessions (metered, service-managed). One row per org:app:session key.
ALTER TABLE public.orgs
  ADD COLUMN IF NOT EXISTS cloud_terminal_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.orgs.cloud_terminal_enabled IS
  'When true and the org has a paid plan, API keys may open cloud terminal sessions for entitled apps. Off by default.';

CREATE TABLE public.terminal_sessions (
  session_key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  owner_org uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES public.apps (app_id) ON DELETE CASCADE,
  apikey_id bigint REFERENCES public.apikeys (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sleeping', 'ended', 'teardown')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  billed_minutes integer NOT NULL DEFAULT 0 CHECK (billed_minutes >= 0),
  max_duration_minutes integer NOT NULL DEFAULT 60 CHECK (max_duration_minutes BETWEEN 1 AND 240),
  teardown_reason text
);

ALTER TABLE public.terminal_sessions OWNER TO postgres;

COMMENT ON TABLE public.terminal_sessions IS
  'Metered cloud terminal sandboxes. Active rows count against per-org concurrency; billing is recorded in billed_minutes only (not invoiced yet).';

CREATE INDEX terminal_sessions_owner_active_idx
  ON public.terminal_sessions (owner_org)
  WHERE status = 'active';

CREATE INDEX terminal_sessions_app_active_idx
  ON public.terminal_sessions (app_id)
  WHERE status = 'active';

ALTER TABLE public.terminal_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deny all direct access on terminal_sessions"
  ON public.terminal_sessions
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.terminal_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.terminal_sessions FROM anon;
REVOKE ALL ON TABLE public.terminal_sessions FROM authenticated;
GRANT ALL ON TABLE public.terminal_sessions TO service_role;

CREATE OR REPLACE FUNCTION public.terminal_org_entitled(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.orgs o
    WHERE o.id = p_org_id
      AND o.cloud_terminal_enabled = true
  )
  AND EXISTS (
    SELECT 1
    FROM public.orgs o
    JOIN public.stripe_info si ON si.customer_id = o.customer_id
    WHERE o.id = p_org_id
      AND si.status = 'succeeded'
      AND si.is_good_plan = true
  );
$$;

ALTER FUNCTION public.terminal_org_entitled(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.terminal_org_entitled(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminal_org_entitled(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.terminal_org_entitled(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.terminal_org_entitled(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.terminal_count_active_sessions(p_org_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COUNT(*)::integer
  FROM public.terminal_sessions
  WHERE owner_org = p_org_id
    AND status = 'active'
    AND started_at + make_interval(mins => max_duration_minutes) > now();
$$;

ALTER FUNCTION public.terminal_count_active_sessions(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.terminal_count_active_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminal_count_active_sessions(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.terminal_count_active_sessions(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.terminal_count_active_sessions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.terminal_session_reserve(
  p_session_key text,
  p_org_id uuid,
  p_app_id text,
  p_apikey_id bigint,
  p_max_duration_minutes integer DEFAULT 60,
  p_max_concurrency integer DEFAULT 2
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_active integer;
BEGIN
  IF p_session_key IS NULL OR length(trim(p_session_key)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_session_key');
  END IF;

  IF NOT public.terminal_org_entitled(p_org_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'terminal_not_entitled');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.apps a WHERE a.app_id = p_app_id AND a.owner_org = p_org_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_app');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.terminal_sessions t
    WHERE t.session_key = p_session_key AND t.status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok', true, 'session_key', p_session_key, 'reused', true);
  END IF;

  PERFORM 1
  FROM public.orgs
  WHERE id = p_org_id
  FOR UPDATE;

  SELECT public.terminal_count_active_sessions(p_org_id) INTO v_active;
  IF v_active >= p_max_concurrency THEN
    RETURN jsonb_build_object('ok', false, 'error', 'concurrency_limit', 'active', v_active, 'limit', p_max_concurrency);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.terminal_sessions t WHERE t.session_key = p_session_key
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_ended');
  END IF;

  INSERT INTO public.terminal_sessions (
    session_key, owner_org, app_id, apikey_id, status, max_duration_minutes
  )
  VALUES (
    p_session_key, p_org_id, p_app_id, p_apikey_id, 'active', p_max_duration_minutes
  );

  RETURN jsonb_build_object('ok', true, 'session_key', p_session_key);
END;
$$;

ALTER FUNCTION public.terminal_session_reserve(text, uuid, text, bigint, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.terminal_session_reserve(text, uuid, text, bigint, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminal_session_reserve(text, uuid, text, bigint, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.terminal_session_reserve(text, uuid, text, bigint, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.terminal_session_reserve(text, uuid, text, bigint, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.terminal_session_finish(
  p_session_key text,
  p_reason text DEFAULT 'normal'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.terminal_sessions%ROWTYPE;
  v_minutes integer;
BEGIN
  SELECT *
  INTO v_row
  FROM public.terminal_sessions
  WHERE session_key = p_session_key
  FOR UPDATE;

  IF NOT FOUND OR v_row.status <> 'active' THEN
    RETURN 0;
  END IF;

  v_minutes := LEAST(
    v_row.max_duration_minutes,
    GREATEST(1, extract(epoch FROM (now() - v_row.started_at))::integer / 60)
  );

  UPDATE public.terminal_sessions
  SET status = 'ended',
      ended_at = now(),
      updated_at = now(),
      billed_minutes = v_minutes,
      teardown_reason = left(coalesce(p_reason, 'normal'), 120)
  WHERE session_key = p_session_key;

  RETURN v_minutes;
END;
$$;

ALTER FUNCTION public.terminal_session_finish(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.terminal_session_finish(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminal_session_finish(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.terminal_session_finish(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.terminal_session_finish(text, text) TO service_role;