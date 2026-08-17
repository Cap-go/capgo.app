-- Split MFA session assurance from email OTP first-factor checks.
-- `aal2` is the source of truth for completed MFA. Email OTP can be an
-- `aal1` login method, so it must not satisfy the MFA gate used by
-- RLS/admin checks (including platform admins).
-- Re-applies the fix from 20260608114543 lost in the prod baseline
-- squash.
--
-- Support spoof of MFA-enforced customers: /private/log_as registers
-- minted sessions in platform_impersonation_sessions so verify_mfa
-- can allow those sessions without restoring a global OTP bypass.

CREATE TABLE IF NOT EXISTS public.platform_impersonation_sessions (
  session_id uuid PRIMARY KEY,
  target_user_id uuid NOT NULL,
  admin_user_id uuid NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.platform_impersonation_sessions IS
'Short-lived sessions minted by platform-admin /private/log_as. '
'Allows verify_mfa during support spoof of MFA-enforced users.';

ALTER TABLE public.platform_impersonation_sessions OWNER TO postgres;

-- Regular index: CONCURRENTLY is not allowed inside migration txs.
CREATE INDEX IF NOT EXISTS platform_impersonation_sessions_expires_at_idx
  ON public.platform_impersonation_sessions (expires_at);

ALTER TABLE public.platform_impersonation_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny select on platform_impersonation_sessions"
  ON public.platform_impersonation_sessions;
CREATE POLICY "Deny select on platform_impersonation_sessions"
  ON public.platform_impersonation_sessions
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated, anon
  USING (false);

DROP POLICY IF EXISTS "Deny insert on platform_impersonation_sessions"
  ON public.platform_impersonation_sessions;
CREATE POLICY "Deny insert on platform_impersonation_sessions"
  ON public.platform_impersonation_sessions
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny update on platform_impersonation_sessions"
  ON public.platform_impersonation_sessions;
CREATE POLICY "Deny update on platform_impersonation_sessions"
  ON public.platform_impersonation_sessions
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "Deny delete on platform_impersonation_sessions"
  ON public.platform_impersonation_sessions;
CREATE POLICY "Deny delete on platform_impersonation_sessions"
  ON public.platform_impersonation_sessions
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated, anon
  USING (false);

GRANT ALL ON TABLE public.platform_impersonation_sessions TO postgres;
GRANT ALL ON TABLE public.platform_impersonation_sessions TO service_role;
REVOKE ALL ON TABLE public.platform_impersonation_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.platform_impersonation_sessions FROM anon;
REVOKE ALL ON TABLE public.platform_impersonation_sessions
  FROM authenticated;

CREATE OR REPLACE FUNCTION public.is_active_platform_impersonation()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.platform_impersonation_sessions AS s
    WHERE s.target_user_id = (SELECT auth.uid())
      AND s.expires_at > now()
      AND s.session_id = (
        CASE
          WHEN ((SELECT auth.jwt()) ->> 'session_id')
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN ((SELECT auth.jwt()) ->> 'session_id')::uuid
          ELSE NULL
        END
      )
  );
$$;

COMMENT ON FUNCTION public.is_active_platform_impersonation() IS
'True when the current JWT session_id was registered by platform-admin '
'log_as and has not expired.';

ALTER FUNCTION public.is_active_platform_impersonation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_active_platform_impersonation()
  FROM PUBLIC;
-- Invoked from verify_mfa (SECURITY DEFINER) only
GRANT EXECUTE ON FUNCTION public.is_active_platform_impersonation()
  TO service_role;

CREATE OR REPLACE FUNCTION public.verify_mfa()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    array[(SELECT COALESCE(auth.jwt()->>'aal', 'aal1'))] <@ (
      SELECT
        CASE
          WHEN count(id) > 0 THEN array['aal2']
          ELSE array['aal1', 'aal2']
        END AS aal
      FROM auth.mfa_factors
      WHERE (SELECT auth.uid()) = user_id
        AND status = 'verified'
    )
    -- Scalar SELECT keeps the impersonation lookup statement-level
    -- under RLS rather than once-per-row.
    OR (SELECT public.is_active_platform_impersonation());
$$;

COMMENT ON FUNCTION public.verify_mfa() IS
'Returns true when the current session satisfies Supabase MFA '
'assurance. Users with verified MFA factors require aal2; users '
'without verified factors may use aal1 or aal2. Active '
'platform-admin impersonation sessions (log_as) also pass so '
'support spoof of MFA users works without an OTP MFA bypass.';

ALTER FUNCTION public.verify_mfa() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.verify_mfa() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_mfa() TO anon;
GRANT EXECUTE ON FUNCTION public.verify_mfa() TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_mfa() TO service_role;

CREATE OR REPLACE FUNCTION public.verify_email_otp_auth()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH jwt_claims AS (
    SELECT auth.jwt() AS claims
  ),
  amr AS (
    SELECT
      CASE
        WHEN pg_catalog.jsonb_typeof(claims->'amr') = 'array'
          THEN claims->'amr'
        ELSE '[]'::jsonb
      END AS entries
    FROM jwt_claims
  )
  SELECT EXISTS (
    SELECT 1
    FROM amr, pg_catalog.jsonb_array_elements(amr.entries) AS amr_elem
    WHERE amr_elem->>'method' = 'otp'
  );
$$;

COMMENT ON FUNCTION public.verify_email_otp_auth() IS
'Returns true when the current JWT authentication-method reference '
'includes OTP. This is first-factor/email OTP evidence and must not '
'be used as MFA assurance.';

ALTER FUNCTION public.verify_email_otp_auth() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.verify_email_otp_auth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_email_otp_auth()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_email_otp_auth()
  TO service_role;

CREATE OR REPLACE FUNCTION
  public.cleanup_expired_platform_impersonation_sessions(
    batch_size integer DEFAULT 1000
  )
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count bigint;
  v_batch_size integer := GREATEST(1, COALESCE(batch_size, 1000));
BEGIN
  DELETE FROM public.platform_impersonation_sessions
  WHERE session_id IN (
    SELECT session_id
    FROM public.platform_impersonation_sessions
    WHERE expires_at <= now()
    ORDER BY expires_at
    LIMIT v_batch_size
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE
    'cleanup_expired_platform_impersonation_sessions: deleted %',
    deleted_count;
END;
$$;

COMMENT ON FUNCTION
  public.cleanup_expired_platform_impersonation_sessions(integer) IS
'Deletes a bounded batch of expired platform-admin log_as '
'impersonation session rows; later cron ticks drain any remainder.';

ALTER FUNCTION
  public.cleanup_expired_platform_impersonation_sessions(integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.cleanup_expired_platform_impersonation_sessions(integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.cleanup_expired_platform_impersonation_sessions(integer)
  TO service_role;

INSERT INTO public.cron_tasks (
  name,
  description,
  task_type,
  target,
  batch_size,
  payload,
  second_interval,
  minute_interval,
  hour_interval,
  run_at_hour,
  run_at_minute,
  run_at_second,
  run_on_dow,
  run_on_day,
  enabled
)
SELECT
  'cleanup_expired_platform_impersonation_sessions',
  'Delete expired platform-admin log_as impersonation sessions',
  'function',
  'public.cleanup_expired_platform_impersonation_sessions(1000)',
  1000,
  NULL,
  NULL,
  5,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  true
WHERE NOT EXISTS (
  SELECT 1
  FROM public.cron_tasks
  WHERE name = 'cleanup_expired_platform_impersonation_sessions'
);

UPDATE public.cron_tasks
SET
  target = 'public.cleanup_expired_platform_impersonation_sessions(1000)',
  batch_size = 1000,
  description = 'Delete expired platform-admin log_as impersonation sessions',
  updated_at = now()
WHERE name = 'cleanup_expired_platform_impersonation_sessions';
