-- Restore anon execute on get_user_id(text) for published CLI 8.42.x.
-- Keep get_user_id(text,text), get_org_perm_for_apikey*, invite_user_to_org_rbac
-- revoked for anon (see 20260824144021_revoke_anon_oracle_rpc_execute.sql).

GRANT EXECUTE ON FUNCTION public.get_user_id(text) TO anon;
