-- Revoke anonymous execute on SECURITY DEFINER RPCs that leak distinguishable
-- outcomes (org/app/key existence) to unauthenticated PostgREST callers.
-- Authenticated JWT and service_role callers keep access for console, CLI,
-- and edge.

REVOKE ALL ON FUNCTION
  public.invite_user_to_org_rbac(character varying, uuid, text)
FROM anon;
REVOKE ALL ON FUNCTION public.get_user_id(text) FROM anon;
REVOKE ALL ON FUNCTION public.get_user_id(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.get_org_perm_for_apikey(text, text) FROM anon;
REVOKE ALL ON FUNCTION
  public.get_org_perm_for_apikey_v2(text, text)
FROM anon;

GRANT EXECUTE ON FUNCTION
  public.invite_user_to_org_rbac(character varying, uuid, text)
TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.invite_user_to_org_rbac(character varying, uuid, text)
TO service_role;

GRANT EXECUTE ON FUNCTION public.get_user_id(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_user_id(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id(text, text) TO service_role;

GRANT EXECUTE ON FUNCTION
  public.get_org_perm_for_apikey(text, text)
TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.get_org_perm_for_apikey(text, text)
TO service_role;
GRANT EXECUTE ON FUNCTION
  public.get_org_perm_for_apikey_v2(text, text)
TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.get_org_perm_for_apikey_v2(text, text)
TO service_role;
