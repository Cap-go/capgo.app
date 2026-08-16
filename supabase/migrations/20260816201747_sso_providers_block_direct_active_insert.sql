-- Block direct PostgREST inserts of already-active / enforce_sso SSO providers.
-- Private create path uses the user JWT client and only inserts pending_verification.
-- Status promotion (verified -> active) and enforce_sso flips stay on the private API
-- UPDATE path. DNS verification (status=verified, dns_verified_at) stays on
-- service_role / postgres via /private/sso/verify-dns.

DROP POLICY IF EXISTS "allow_org_admins_insert_sso_providers" ON public.sso_providers;
CREATE POLICY "allow_org_admins_insert_sso_providers"
ON public.sso_providers
FOR INSERT
TO anon, authenticated
WITH CHECK (
  public.rbac_check_permission_request(
    public.rbac_perm_org_update_settings(),
    org_id,
    NULL::character varying,
    NULL::bigint
  )
  AND status = 'pending_verification'
  AND enforce_sso IS NOT TRUE
  AND dns_verified_at IS NULL
);

CREATE OR REPLACE FUNCTION public.enforce_sso_provider_client_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_request_role text := public.current_request_role();
BEGIN
  -- service_role / postgres / supabase_admin keep full write access (verify-dns, tests).
  IF public.is_internal_request_role(v_request_role) THEN
    RETURN NEW;
  END IF;

  IF NEW.dns_verified_at IS DISTINCT FROM OLD.dns_verified_at THEN
    RAISE EXCEPTION 'SSO_PROVIDER_DNS_VERIFICATION_CLIENT_WRITE_DENIED'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'pending_verification'
      OR NOT (
        (OLD.status = 'verified' AND NEW.status = 'active')
        OR (OLD.status = 'active' AND NEW.status = 'disabled')
        OR (OLD.status = 'disabled' AND NEW.status = 'active')
      )
    THEN
      RAISE EXCEPTION 'SSO_PROVIDER_STATUS_PROMOTION_DENIED'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.enforce_sso IS TRUE AND NEW.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'SSO_PROVIDER_ENFORCE_SSO_DENIED'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_sso_provider_client_update_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_sso_provider_client_update_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_sso_provider_client_update_guard() TO service_role;

COMMENT ON FUNCTION public.enforce_sso_provider_client_update_guard() IS
  'Stops authenticated/anon PostgREST updates from forging DNS verification, skipping pending_verification, or enabling enforce_sso on a non-active provider.';

DROP TRIGGER IF EXISTS enforce_sso_provider_client_update_guard ON public.sso_providers;
CREATE TRIGGER enforce_sso_provider_client_update_guard
BEFORE UPDATE ON public.sso_providers
FOR EACH ROW
EXECUTE FUNCTION public.enforce_sso_provider_client_update_guard();
