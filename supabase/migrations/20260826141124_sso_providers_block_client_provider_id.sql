-- Block client PostgREST writes to provider_id on public.sso_providers.
-- provider_id binds a Capgo SSO row to a Supabase Auth SSO provider and must
-- only be set by service_role / internal paths (private API create, tests).
-- Complements 20260826100000_sso_providers_block_direct_active_insert.sql.

DROP POLICY IF EXISTS "allow_org_admins_insert_sso_providers"
  ON public.sso_providers;
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
  AND provider_id IS NULL
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
  -- service_role / postgres / supabase_admin keep full write access
  -- (verify-dns, private API PATCH, tests).
  IF public.is_internal_request_role(v_request_role) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.provider_id IS NOT NULL THEN
      RAISE EXCEPTION 'SSO_PROVIDER_PROVIDER_ID_CLIENT_WRITE_DENIED'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.provider_id IS DISTINCT FROM OLD.provider_id THEN
    RAISE EXCEPTION 'SSO_PROVIDER_PROVIDER_ID_CLIENT_WRITE_DENIED'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.dns_verified_at IS DISTINCT FROM OLD.dns_verified_at THEN
    RAISE EXCEPTION 'SSO_PROVIDER_DNS_VERIFICATION_CLIENT_WRITE_DENIED'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.domain IS DISTINCT FROM OLD.domain THEN
    RAISE EXCEPTION 'SSO_PROVIDER_DOMAIN_CHANGE_DENIED'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'SSO_PROVIDER_STATUS_PROMOTION_DENIED'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.enforce_sso IS DISTINCT FROM OLD.enforce_sso THEN
    RAISE EXCEPTION 'SSO_PROVIDER_ENFORCE_SSO_DENIED'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_sso_provider_client_update_guard()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_sso_provider_client_update_guard()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_sso_provider_client_update_guard()
  TO service_role;

COMMENT ON FUNCTION public.enforce_sso_provider_client_update_guard() IS
  'BEFORE INSERT/UPDATE trigger on public.sso_providers (per row). Runs on '
  'every client write; internal roles (service_role, postgres, supabase_admin) '
  'bypass. Client roles cannot set or change provider_id, dns_verified_at, '
  'domain, status, or enforce_sso. Executing roles: anon, authenticated via '
  'PostgREST; internal roles for verify-dns and /private/sso/providers '
  'create/PATCH. Table cardinality: low per org (typically 1-5 rows); trigger '
  'touches only the inserted/updated row. Indexes: sso_providers_pkey for '
  'UPDATE by id. Worst-case EXPLAIN (ANALYZE, BUFFERS) on local seed (org '
  'JWT, Demo org 046a36ac): INSERT pending_verification without provider_id -> '
  'Insert on sso_providers with enforce_sso_provider_client_insert_guard '
  '(~0.7ms trigger); UPDATE metadata_url by id -> Index Scan on '
  'sso_providers_pkey plus rbac_check_permission_request; no seq scan. Blocked '
  'provider_id INSERT/UPDATE raise before plan completes.';

DROP TRIGGER IF EXISTS enforce_sso_provider_client_insert_guard
  ON public.sso_providers;
CREATE TRIGGER enforce_sso_provider_client_insert_guard
BEFORE INSERT ON public.sso_providers
FOR EACH ROW
EXECUTE FUNCTION public.enforce_sso_provider_client_update_guard();
