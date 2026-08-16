-- Split MFA session assurance from email OTP first-factor checks.
-- `aal2` is the source of truth for completed MFA. Email OTP can be an `aal1`
-- login method, so it must not satisfy the MFA gate used by RLS/admin checks.
-- Re-applies the fix from 20260608114543 that was lost in the prod baseline squash.

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
    );
$$;

COMMENT ON FUNCTION public.verify_mfa() IS
'Returns true when the current session satisfies Supabase MFA assurance. Users with verified MFA factors require aal2; users without verified factors may use aal1 or aal2.';

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
        WHEN pg_catalog.jsonb_typeof(claims->'amr') = 'array' THEN claims->'amr'
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
'Returns true when the current JWT authentication-method reference includes OTP. This is first-factor/email OTP evidence and must not be used as MFA assurance.';

ALTER FUNCTION public.verify_email_otp_auth() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.verify_email_otp_auth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_email_otp_auth() TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_email_otp_auth() TO service_role;
