-- GHSA-4h9w-86j7-q2p3
-- Public PostgREST RPC regenerate_hashed_apikey(bigint) previously only checked
-- that the caller shared user_id with the target key, then returned plaintext.
-- Any capgkey (including read-only) could rotate a sibling key and steal its
-- privileges. HTTP PUT /apikey already requires org.manage_apikeys and uses
-- the service-role helper. This RPC stays granted to anon+authenticated so
-- capgkey PostgREST can call it, but fail-closed unless the caller has
-- org.manage_apikeys on every org the target key is bound to.
--
-- Execution model (console / CLI RPC, not plugin /updates and not RLS):
-- - Runs once per RPC call.
-- - Roles: anon + authenticated (capgkey uses anon) + service_role.
-- - Lookups: apikeys by PK id; active role_bindings by
--   (principal_type, principal_id) via role_bindings_principal_scope_idx;
--   then rbac_check_permission_direct once per distinct active org_id.
-- - Worst-case cardinality: console-scale API keys rarely exceed a handful of
--   active org bindings per key; the loop is bounded by that small distinct
--   org_id count, not plugin-hot tables.
-- - Indexes: apikeys_pkey(id); role_bindings_principal_scope_idx
--   (principal_type, principal_id, scope_type, org_id, app_id, channel_id);
--   role_bindings lookups use Index Scan on local seed data in EXPLAIN
--   (ANALYZE, BUFFERS); rbac_check_permission_direct stays indexed per org.

CREATE OR REPLACE FUNCTION public.lock_rbac_apikey_principal(p_rbac_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_rbac_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('rbac_apikey_principal'),
    pg_catalog.hashtext(p_rbac_id::text)
  );
END;
$$;

ALTER FUNCTION public.lock_rbac_apikey_principal(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_rbac_apikey_principal(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_rbac_apikey_principal(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.lock_rbac_apikey_principal_on_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.principal_type = public.rbac_principal_apikey() THEN
      PERFORM public.lock_rbac_apikey_principal(OLD.principal_id);
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.principal_type = public.rbac_principal_apikey()
      AND NEW.principal_type = public.rbac_principal_apikey()
      AND OLD.principal_id IS NOT NULL
      AND NEW.principal_id IS NOT NULL
    THEN
      IF OLD.principal_id = NEW.principal_id THEN
        PERFORM public.lock_rbac_apikey_principal(OLD.principal_id);
      ELSIF OLD.principal_id < NEW.principal_id THEN
        PERFORM public.lock_rbac_apikey_principal(OLD.principal_id);
        PERFORM public.lock_rbac_apikey_principal(NEW.principal_id);
      ELSE
        PERFORM public.lock_rbac_apikey_principal(NEW.principal_id);
        PERFORM public.lock_rbac_apikey_principal(OLD.principal_id);
      END IF;
    ELSE
      IF OLD.principal_type = public.rbac_principal_apikey() THEN
        PERFORM public.lock_rbac_apikey_principal(OLD.principal_id);
      END IF;
      IF NEW.principal_type = public.rbac_principal_apikey() THEN
        PERFORM public.lock_rbac_apikey_principal(NEW.principal_id);
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.principal_type = public.rbac_principal_apikey() THEN
    PERFORM public.lock_rbac_apikey_principal(NEW.principal_id);
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.lock_rbac_apikey_principal_on_binding()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_rbac_apikey_principal_on_binding()
  FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_rbac_apikey_principal_on_binding()
  TO service_role;

DROP TRIGGER IF EXISTS lock_rbac_apikey_principal_on_binding
  ON public.role_bindings;
CREATE TRIGGER lock_rbac_apikey_principal_on_binding
BEFORE INSERT OR UPDATE OR DELETE ON public.role_bindings
FOR EACH ROW
EXECUTE FUNCTION public.lock_rbac_apikey_principal_on_binding();

CREATE OR REPLACE FUNCTION public.regenerate_hashed_apikey(p_apikey_id bigint)
RETURNS public.apikeys
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_target public.apikeys%ROWTYPE;
  v_org_id uuid;
  v_has_org_binding boolean := false;
  v_caller_apikey text;
BEGIN
  v_user_id := public.request_actor_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No authentication provided';
  END IF;

  SELECT *
  INTO v_target
  FROM public.apikeys
  WHERE public.apikeys.id = p_apikey_id
    AND public.apikeys.user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apikey_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Serialize binding mutations and rotation for this API-key principal.
  PERFORM public.lock_rbac_apikey_principal(v_target.rbac_id);

  -- Prefer the request capgkey so a read-only key cannot inherit the owner's
  -- user-level manage_apikeys. JWT callers still resolve as the user principal
  -- inside rbac_check_permission_direct.
  v_caller_apikey := public.get_apikey_header();

  FOR v_org_id IN
    SELECT DISTINCT role_bindings.org_id
    FROM public.role_bindings
    WHERE role_bindings.principal_type = public.rbac_principal_apikey()
      AND role_bindings.principal_id = v_target.rbac_id
      AND role_bindings.org_id IS NOT NULL
      AND (
        role_bindings.expires_at IS NULL
        OR role_bindings.expires_at > pg_catalog.now()
      )
  LOOP
    v_has_org_binding := true;
    IF NOT public.rbac_check_permission_direct(
      public.rbac_perm_org_manage_apikeys(),
      v_user_id,
      v_org_id,
      NULL::character varying,
      NULL::bigint,
      v_caller_apikey
    ) THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_MANAGE_APIKEYS'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Unbound keys have no org to authorize against. Deny instead of treating
  -- "no bindings" as an empty all-pass.
  IF NOT v_has_org_binding THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_MANAGE_APIKEYS'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.regenerate_hashed_apikey_for_user(p_apikey_id, v_user_id);
END;
$$;

ALTER FUNCTION public.regenerate_hashed_apikey(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.regenerate_hashed_apikey(bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.regenerate_hashed_apikey(bigint) TO service_role;
GRANT ALL ON FUNCTION public.regenerate_hashed_apikey(bigint) TO anon;
GRANT ALL ON FUNCTION public.regenerate_hashed_apikey(bigint) TO authenticated;

COMMENT ON FUNCTION public.regenerate_hashed_apikey(bigint) IS
  'Public compatibility RPC for hashed API key rotation. Resolves the caller '
  'from JWT or capgkey, requires org.manage_apikeys on every active org the '
  'target key is bound to, serializes binding mutations via '
  'lock_rbac_apikey_principal, then returns plaintext via the service-owned '
  'helper. Granted to anon+authenticated so capgkey PostgREST can call it; '
  'fail-closed unless the caller has manage_apikeys so a read-only sibling '
  'key cannot steal privileges (GHSA-4h9w-86j7-q2p3).';
