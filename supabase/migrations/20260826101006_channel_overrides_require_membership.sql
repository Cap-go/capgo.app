-- GHSA-626c-p6fq-3whq: channel permission overrides must target a principal
-- that already belongs to the channel's owner org. Caller still needs
-- app.update_user_roles. Membership matches rbac_principal_has_org_binding
-- (any non-expired org/app/channel binding, or user via group binding, or
-- group in org). SECURITY DEFINER wrapper so the check is not filtered by
-- groups/role_bindings RLS (app-scoped admins cannot SELECT those rows).
-- Join channels -> apps for owner_org, same as the previous policies.

CREATE SCHEMA IF NOT EXISTS rbac_internal;

CREATE OR REPLACE FUNCTION rbac_internal.channel_override_principal_in_org(
  p_principal_type text,
  p_principal_id uuid,
  p_org_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.rbac_principal_has_org_binding(
    p_principal_type,
    p_principal_id,
    p_org_id
  );
$$;

ALTER FUNCTION rbac_internal.channel_override_principal_in_org(text, uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION rbac_internal.channel_override_principal_in_org(text, uuid, uuid)
  FROM PUBLIC;
GRANT USAGE ON SCHEMA rbac_internal TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION rbac_internal.channel_override_principal_in_org(text, uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION rbac_internal.channel_override_principal_in_org(text, uuid, uuid) IS
  'RLS helper: delegates to rbac_principal_has_org_binding (any scope binding, '
  'group membership, or group in org). Called from channel_permission_overrides '
  'INSERT/UPDATE policies and cleanup DELETE (once per written row, '
  'authenticated only). SECURITY DEFINER so app-scoped admins are not blocked '
  'by groups/role_bindings SELECT RLS. Lives in rbac_internal (not '
  'PostgREST-exposed).';

DROP FUNCTION IF EXISTS public.channel_override_principal_in_org(text, uuid, uuid);

DELETE FROM public.channel_permission_overrides AS overrides
USING public.channels AS channels
JOIN public.apps AS apps
  ON channels.app_id::text = apps.app_id::text
WHERE overrides.channel_id = channels.id
  AND NOT rbac_internal.channel_override_principal_in_org(
    overrides.principal_type,
    overrides.principal_id,
    apps.owner_org
  );

DROP POLICY IF EXISTS "channel_permission_overrides_admin_insert"
  ON public.channel_permission_overrides;
CREATE POLICY "channel_permission_overrides_admin_insert"
ON public.channel_permission_overrides
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.channels
    JOIN public.apps
      ON channels.app_id::text = apps.app_id::text
    WHERE channels.id = channel_permission_overrides.channel_id
      AND public.rbac_check_permission(
        public.rbac_perm_app_update_user_roles(),
        apps.owner_org,
        apps.app_id,
        NULL::bigint
      )
      AND rbac_internal.channel_override_principal_in_org(
        channel_permission_overrides.principal_type,
        channel_permission_overrides.principal_id,
        apps.owner_org
      )
  )
);

COMMENT ON POLICY "channel_permission_overrides_admin_insert"
  ON public.channel_permission_overrides IS
  'Authenticated app admins can insert channel permission overrides only for '
  'principals that belong to the channel org.';

DROP POLICY IF EXISTS "channel_permission_overrides_admin_update"
  ON public.channel_permission_overrides;
CREATE POLICY "channel_permission_overrides_admin_update"
ON public.channel_permission_overrides
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.channels
    JOIN public.apps
      ON channels.app_id::text = apps.app_id::text
    WHERE channels.id = channel_permission_overrides.channel_id
      AND public.rbac_check_permission(
        public.rbac_perm_app_update_user_roles(),
        apps.owner_org,
        apps.app_id,
        NULL::bigint
      )
      AND rbac_internal.channel_override_principal_in_org(
        channel_permission_overrides.principal_type,
        channel_permission_overrides.principal_id,
        apps.owner_org
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.channels
    JOIN public.apps
      ON channels.app_id::text = apps.app_id::text
    WHERE channels.id = channel_permission_overrides.channel_id
      AND public.rbac_check_permission(
        public.rbac_perm_app_update_user_roles(),
        apps.owner_org,
        apps.app_id,
        NULL::bigint
      )
      AND rbac_internal.channel_override_principal_in_org(
        channel_permission_overrides.principal_type,
        channel_permission_overrides.principal_id,
        apps.owner_org
      )
  )
);

COMMENT ON POLICY "channel_permission_overrides_admin_update"
  ON public.channel_permission_overrides IS
  'Authenticated app admins can update channel permission overrides only for '
  'principals that belong to the channel org. Legacy outsider rows are deleted '
  'by this migration; remaining rows must still target org members.';
