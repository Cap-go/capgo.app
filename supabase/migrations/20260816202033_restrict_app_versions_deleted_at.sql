-- Upload-scoped principals have app.upload_bundle and can UPDATE non-deleted
-- app_versions, including deleted_at. Setting deleted_at enqueues storage
-- deletion. Require bundle.delete for user-context soft-deletes. Internal
-- service_role paths keep working.

CREATE OR REPLACE FUNCTION public.enforce_app_versions_delete_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Prefer current_request_role over auth.role()/session_user: pgTAP and
  -- PostgREST API-key traffic set the role GUC (and/or JWT role) to anon while
  -- session_user stays postgres. Falling back to session_user would skip the
  -- guard for those callers.
  v_request_role text := public.current_request_role();
BEGIN
  IF NOT (
    (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL)
    OR (NEW.deleted IS TRUE AND OLD.deleted IS NOT TRUE)
  ) THEN
    RETURN NEW;
  END IF;

  IF public.is_internal_request_role(v_request_role) THEN
    RETURN NEW;
  END IF;

  IF v_request_role IS DISTINCT FROM 'anon' AND v_request_role IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_BUNDLE_DELETE'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.rbac_check_permission_request(
    public.rbac_perm_bundle_delete(),
    NEW.owner_org,
    NEW.app_id,
    NULL::bigint
  ) THEN
    RAISE EXCEPTION 'PERMISSION_DENIED_BUNDLE_DELETE'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_app_versions_delete_permission() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_app_versions_delete_permission() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_app_versions_delete_permission() TO service_role;

DROP TRIGGER IF EXISTS enforce_app_versions_delete_permission ON public.app_versions;
CREATE TRIGGER enforce_app_versions_delete_permission
BEFORE UPDATE OF deleted, deleted_at ON public.app_versions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_app_versions_delete_permission();

COMMENT ON FUNCTION public.enforce_app_versions_delete_permission() IS
  'Requires bundle.delete when a user-context write sets app_versions.deleted or deleted_at.';
