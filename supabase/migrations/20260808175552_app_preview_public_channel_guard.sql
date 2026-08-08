-- A public/default channel changes app delivery settings. App-preview keys may
-- bootstrap private channels, but must not create or flip a channel to public.
-- INSERT RLS blocks public creates. UPDATE uses a BEFORE trigger so the check
-- only applies on private -> public transitions; channel-scoped admins can still
-- edit already-public channels. The channel endpoint mirrors the same guard.
DROP POLICY IF EXISTS "Allow RBAC channels insert" ON public.channels;
CREATE POLICY "Allow RBAC channels insert"
ON public.channels
FOR INSERT
TO anon, authenticated
WITH CHECK (
  public.rbac_check_permission_request(
    public.rbac_perm_app_create_channel(),
    owner_org,
    app_id,
    NULL::bigint
  )
  AND (
    "public" IS FALSE
    OR public.rbac_check_permission_request(
      public.rbac_perm_app_update_settings(),
      owner_org,
      app_id,
      NULL::bigint
    )
  )
  AND (
    (version IS NULL AND rollout_version IS NULL)
    OR public.rbac_check_permission_request(
      public.rbac_perm_channel_promote_bundle(),
      owner_org,
      app_id,
      NULL::bigint
    )
  )
);

-- Keep UPDATE RLS channel-scoped. Requiring app.update_settings whenever the
-- NEW row is public would block legitimate edits to already-public channels.
DROP POLICY IF EXISTS "Allow RBAC channels update" ON public.channels;
CREATE POLICY "Allow RBAC channels update"
ON public.channels
FOR UPDATE
TO anon, authenticated
USING (
  public.rbac_check_permission_request(
    public.rbac_perm_channel_update_settings(),
    owner_org,
    app_id,
    id
  )
)
WITH CHECK (
  public.rbac_check_permission_request(
    public.rbac_perm_channel_update_settings(),
    owner_org,
    app_id,
    id
  )
);

CREATE OR REPLACE FUNCTION public.enforce_public_channel_app_settings_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Prefer current_request_role over auth.role()/session_user: pgTAP and
  -- PostgREST API-key traffic set the role GUC (and/or JWT role) to anon while
  -- session_user stays postgres. Falling back to session_user would skip the
  -- private -> public guard for those callers.
  v_request_role text := public.current_request_role();
BEGIN
  -- Only gate private -> public transitions. Internal/service-role paths
  -- enforce the matching app.update_settings check in application code.
  IF NEW.public IS TRUE
    AND OLD.public IS NOT TRUE
    AND NOT public.is_internal_request_role(v_request_role)
  THEN
    IF v_request_role IS DISTINCT FROM 'anon' AND v_request_role IS DISTINCT FROM 'authenticated' THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_APP_UPDATE_SETTINGS'
        USING ERRCODE = '42501';
    END IF;

    IF NOT public.rbac_check_permission_request(
      public.rbac_perm_app_update_settings(),
      NEW.owner_org,
      NEW.app_id,
      NULL::bigint
    ) THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_APP_UPDATE_SETTINGS'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_public_channel_app_settings_permission() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_public_channel_app_settings_permission() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_public_channel_app_settings_permission() TO service_role;

DROP TRIGGER IF EXISTS enforce_public_channel_app_settings_permission ON public.channels;
CREATE TRIGGER enforce_public_channel_app_settings_permission
BEFORE UPDATE OF "public" ON public.channels
FOR EACH ROW
EXECUTE FUNCTION public.enforce_public_channel_app_settings_permission();

COMMENT ON FUNCTION public.enforce_public_channel_app_settings_permission() IS
  'Requires app.update_settings when a user-context write flips a channel from private to public.';
