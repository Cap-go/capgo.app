-- Cloud terminal sessions (metered, service-managed). One row per org:app:session key.
ALTER TABLE public.orgs
  ADD COLUMN IF NOT EXISTS cloud_terminal_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.orgs.cloud_terminal_enabled IS
  'When true and the org has a paid plan, API keys may open cloud terminal sessions for entitled apps. Off by default.';

-- cloud_terminal_enabled is billing-gated; guard ships in the same migration as the column.
CREATE OR REPLACE FUNCTION "public"."guard_org_billing_columns"()
RETURNS "trigger"
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_request_role text := public.current_request_role();
  v_bootstrap_org_id text := COALESCE(
    pg_catalog.current_setting('capgo.org_creation_bootstrap_org_id', true),
    ''
  );
  v_expected_has_usage_credits boolean;
BEGIN
  IF public.is_internal_request_role(v_request_role) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.customer_id IS NOT NULL THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_ORG_CUSTOMER_ID'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.auto_top_up_enabled IS DISTINCT FROM false
      OR NEW.auto_top_up_threshold IS DISTINCT FROM 10::numeric
      OR NEW.auto_top_up_monthly_limit IS DISTINCT FROM 0::numeric
      OR NEW.auto_top_up_last_attempt_at IS NOT NULL
      OR NEW.has_usage_credits IS DISTINCT FROM false
      OR NEW.cloud_terminal_enabled IS DISTINCT FROM false
    THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_ORG_BILLING_COLUMNS'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
    AND NOT (
      v_bootstrap_org_id <> ''
      AND v_bootstrap_org_id = NEW.id::text
    )
  THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_ORG_CUSTOMER_ID'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.auto_top_up_enabled IS DISTINCT FROM OLD.auto_top_up_enabled
    OR NEW.auto_top_up_threshold IS DISTINCT FROM OLD.auto_top_up_threshold
    OR NEW.auto_top_up_monthly_limit
    IS DISTINCT FROM OLD.auto_top_up_monthly_limit
    OR NEW.auto_top_up_last_attempt_at
    IS DISTINCT FROM OLD.auto_top_up_last_attempt_at
  THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_ORG_BILLING_COLUMNS'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.cloud_terminal_enabled IS DISTINCT FROM OLD.cloud_terminal_enabled THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_ORG_BILLING_COLUMNS'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.has_usage_credits IS DISTINCT FROM OLD.has_usage_credits THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.usage_credit_grants AS g
      WHERE g.org_id = NEW.id
        AND g.expires_at >= pg_catalog.now()
        AND g.credits_consumed < g.credits_total
    ) INTO v_expected_has_usage_credits;

    IF NEW.has_usage_credits IS DISTINCT FROM v_expected_has_usage_credits THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_ORG_BILLING_COLUMNS'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."guard_org_billing_columns"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."guard_org_billing_columns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_org_billing_columns"() TO "service_role";

COMMENT ON FUNCTION "public"."guard_org_billing_columns"() IS
'BEFORE INSERT/UPDATE guard for org billing columns (customer_id, '
'has_usage_credits, auto_top_up_*, cloud_terminal_enabled). User/capgkey roles '
'cannot write them; service_role/postgres bypass via is_internal_request_role.';

DROP TRIGGER IF EXISTS "guard_org_billing_columns" ON "public"."orgs";

CREATE TRIGGER "guard_org_billing_columns"
BEFORE UPDATE OF
"customer_id",
"has_usage_credits",
"auto_top_up_enabled",
"auto_top_up_threshold",
"auto_top_up_monthly_limit",
"auto_top_up_last_attempt_at",
"cloud_terminal_enabled"
ON "public"."orgs"
FOR EACH ROW
EXECUTE FUNCTION "public"."guard_org_billing_columns"();

CREATE TABLE public.terminal_sessions (
  session_key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  owner_org uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES public.apps (app_id) ON DELETE RESTRICT,
  apikey_id bigint REFERENCES public.apikeys (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sleeping', 'ended', 'teardown')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  billed_minutes integer NOT NULL DEFAULT 0 CHECK (billed_minutes >= 0),
  max_duration_minutes integer NOT NULL DEFAULT 60 CHECK (max_duration_minutes BETWEEN 1 AND 60),
  teardown_reason text,
  ws_connect_token_hash text,
  ws_connect_token_expires_at timestamptz
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
    WHERE t.session_key = p_session_key
      AND t.status = 'active'
      AND t.started_at + make_interval(mins => t.max_duration_minutes) > now()
  ) THEN
    RETURN jsonb_build_object('ok', true, 'session_key', p_session_key, 'reused', true);
  END IF;

  PERFORM 1
  FROM public.orgs
  WHERE id = p_org_id
  FOR UPDATE;

  IF NOT public.terminal_org_entitled(p_org_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'terminal_not_entitled');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.terminal_sessions t
    WHERE t.session_key = p_session_key
      AND t.status = 'active'
      AND t.started_at + make_interval(mins => t.max_duration_minutes) > now()
  ) THEN
    RETURN jsonb_build_object('ok', true, 'session_key', p_session_key, 'reused', true);
  END IF;

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

CREATE OR REPLACE FUNCTION public.terminal_session_set_ws_token(
  p_session_key text,
  p_token_hash text,
  p_ttl_seconds integer DEFAULT 300
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.terminal_sessions
  SET ws_connect_token_hash = p_token_hash,
      ws_connect_token_expires_at = now() + make_interval(secs => p_ttl_seconds),
      updated_at = now()
  WHERE session_key = p_session_key
    AND status = 'active';
  RETURN FOUND;
END;
$$;

ALTER FUNCTION public.terminal_session_set_ws_token(text, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.terminal_session_set_ws_token(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminal_session_set_ws_token(text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.terminal_session_set_ws_token(text, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.terminal_session_set_ws_token(text, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.terminal_session_consume_ws_token(
  p_session_key text,
  p_token_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE public.terminal_sessions
  SET ws_connect_token_hash = NULL,
      ws_connect_token_expires_at = NULL,
      updated_at = now()
  WHERE session_key = p_session_key
    AND status = 'active'
    AND ws_connect_token_hash = p_token_hash
    AND ws_connect_token_expires_at IS NOT NULL
    AND ws_connect_token_expires_at > now()
    AND started_at + make_interval(mins => max_duration_minutes) > now()
  RETURNING true INTO v_ok;
  RETURN COALESCE(v_ok, false);
END;
$$;

ALTER FUNCTION public.terminal_session_consume_ws_token(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.terminal_session_consume_ws_token(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminal_session_consume_ws_token(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.terminal_session_consume_ws_token(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.terminal_session_consume_ws_token(text, text) TO service_role;