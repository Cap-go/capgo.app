-- Restore anonymous execute on get_user_id for published CLI versions that still
-- call rpc/get_user_id with { apikey }. Require the same key in the capgkey header
-- for anon callers so arbitrary keys cannot be probed from the RPC body alone.
-- Keep get_org_perm_for_apikey*, invite_user_to_org_rbac revoked for anon.

CREATE OR REPLACE FUNCTION public.get_user_id(apikey text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  api_key public.apikeys%ROWTYPE;
  header_key text;
BEGIN
  IF apikey IS NULL OR btrim(apikey) = '' THEN
    RETURN NULL;
  END IF;

  IF (SELECT auth.role()) = 'anon' THEN
    header_key := public.get_apikey_header();
    IF header_key IS NULL OR header_key <> apikey THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT *
  INTO api_key
  FROM public.find_apikey_by_value(apikey)
  LIMIT 1;

  IF api_key.id IS NULL OR public.is_apikey_expired(api_key.expires_at) THEN
    RETURN NULL;
  END IF;

  RETURN api_key.user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_id(apikey text, app_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  real_user_id uuid;
BEGIN
  PERFORM app_id;
  SELECT public.get_user_id(apikey) INTO real_user_id;
  RETURN real_user_id;
END;
$$;

ALTER FUNCTION public.get_user_id(text) OWNER TO postgres;
ALTER FUNCTION public.get_user_id(text, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_user_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_id(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_user_id(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id(text) TO service_role;

REVOKE ALL ON FUNCTION public.get_user_id(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_id(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_user_id(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id(text, text) TO service_role;

COMMENT ON FUNCTION public.get_user_id(text) IS
  'Compatibility RPC for published CLIs. Anonymous callers must pass the same API key in capgkey and apikey; invalid or mismatched keys return NULL without org/app oracle signals.';

COMMENT ON FUNCTION public.get_user_id(text, text) IS
  'Compatibility RPC for published CLIs. The app_id argument is ignored; write authorization must be checked through RBAC.';
