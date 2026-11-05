-- check_org_encrypted_bundle_enforcement(uuid, text) is a SECURITY DEFINER
-- helper that reads orgs.enforce_encrypted_bundles without any caller
-- authorization check. It is only meant for internal/service-role use (the
-- insert-time enforcement runs through the check_encrypted_bundle_on_insert
-- trigger), so align its grants with check_org_hashed_key_enforcement and
-- remove EXECUTE from PUBLIC, anon and authenticated.

REVOKE ALL ON FUNCTION public.check_org_encrypted_bundle_enforcement(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_org_encrypted_bundle_enforcement(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.check_org_encrypted_bundle_enforcement(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_org_encrypted_bundle_enforcement(uuid, text) TO service_role;
