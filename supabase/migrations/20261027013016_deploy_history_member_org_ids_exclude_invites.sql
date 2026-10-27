-- current_user_member_org_ids() scopes the deploy_history SELECT policy.
-- A raw org_users row is not an authorization: pending invitations
-- (is_invite = true) and memberships whose role bindings were removed or
-- expired must not count as membership. Only return orgs where the caller has
-- an accepted membership backed by an active RBAC role binding in that org,
-- either directly or through one of the org's groups.
CREATE OR REPLACE FUNCTION public.current_user_member_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(DISTINCT org_users.org_id), '{}'::uuid[])
  FROM public.org_users
  WHERE org_users.user_id = (SELECT auth.uid())
    AND org_users.is_invite IS FALSE
    AND (
      EXISTS (
        SELECT 1
        FROM public.role_bindings
        WHERE role_bindings.principal_type = public.rbac_principal_user()
          AND role_bindings.principal_id = org_users.user_id
          AND role_bindings.org_id = org_users.org_id
          AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > now())
      )
      OR EXISTS (
        SELECT 1
        FROM public.group_members
        INNER JOIN public.groups
          ON groups.id = group_members.group_id
        INNER JOIN public.role_bindings
          ON role_bindings.principal_type = public.rbac_principal_group()
          AND role_bindings.principal_id = group_members.group_id
          AND role_bindings.org_id = groups.org_id
          AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > now())
        WHERE group_members.user_id = org_users.user_id
          AND groups.org_id = org_users.org_id
      )
    )
$$;

ALTER FUNCTION public.current_user_member_org_ids() OWNER TO postgres;

COMMENT ON FUNCTION public.current_user_member_org_ids() IS
'Returns org IDs where the current user is an accepted member with an '
'active RBAC role binding. Pending invitations and memberships without '
'an active binding are excluded.';

REVOKE ALL ON FUNCTION public.current_user_member_org_ids() FROM public;
REVOKE ALL ON FUNCTION public.current_user_member_org_ids() FROM anon;
GRANT EXECUTE ON FUNCTION public.current_user_member_org_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_member_org_ids() TO service_role;
