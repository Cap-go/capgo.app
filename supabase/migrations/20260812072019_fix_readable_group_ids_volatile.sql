-- INSERT ... RETURNING on public.groups evaluates groups_select.
-- readable_group_ids() scans public.groups under the surrounding INSERT snapshot,
-- so the brand-new row is invisible and SELECT RLS fails with 42501 even when
-- groups_insert WITH CHECK passed. Keep the bounded readable_group_ids() path for
-- normal SELECTs, and allow role managers via org_id (available on NEW) so
-- RETURNING works. Also mark readable_group_ids VOLATILE for consistency.
CREATE OR REPLACE FUNCTION public.readable_group_ids()
RETURNS uuid[]
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH direct_group_ids AS (
    SELECT group_members.group_id
    FROM public.group_members
    WHERE group_members.user_id = (SELECT auth.uid())
  ),
  admin_orgs AS MATERIALIZED (
    SELECT ids.org_id
    FROM pg_catalog.unnest(
      COALESCE((SELECT public.orgs_admin_org_ids()), '{}'::uuid[])
    ) AS ids(org_id)
  ),
  caller_ranks AS MATERIALIZED (
    SELECT admin_orgs.org_id,
      public.request_principal_max_role_priority(admin_orgs.org_id) AS max_priority
    FROM admin_orgs
  ),
  rank_manageable_group_ids AS (
    SELECT groups.id AS group_id
    FROM public.groups
    INNER JOIN caller_ranks
      ON caller_ranks.org_id = groups.org_id
    LEFT JOIN public.role_bindings
      ON role_bindings.principal_type = public.rbac_principal_group()
      AND role_bindings.principal_id = groups.id
      AND role_bindings.org_id = groups.org_id
      AND (role_bindings.expires_at IS NULL OR role_bindings.expires_at > pg_catalog.now())
    LEFT JOIN public.roles
      ON roles.id = role_bindings.role_id
      AND roles.scope_type = role_bindings.scope_type
    GROUP BY groups.id, caller_ranks.max_priority
    HAVING caller_ranks.max_priority >= COALESCE(MAX(roles.priority_rank), 0)
  ),
  allowed_group_ids AS (
    SELECT group_id FROM direct_group_ids
    UNION
    SELECT group_id FROM rank_manageable_group_ids
  )
  SELECT COALESCE(array_agg(DISTINCT allowed_group_ids.group_id), '{}'::uuid[])
  FROM allowed_group_ids
$$;

ALTER FUNCTION public.readable_group_ids() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.readable_group_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.readable_group_ids() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.readable_group_ids() IS
  'Returns direct JWT-member groups plus rank-manageable groups from bounded caller-scoped orgs for statement-level RLS. VOLATILE; INSERT ... RETURNING also relies on groups_select org-role OR.';

DROP POLICY IF EXISTS "groups_select" ON public.groups;
CREATE POLICY "groups_select" ON public.groups
FOR SELECT
TO anon, authenticated
USING (
  id = ANY(COALESCE((SELECT public.readable_group_ids()), '{}'::uuid[]))
  OR public.rbac_check_permission_request(
    public.rbac_perm_org_update_user_roles(),
    org_id,
    NULL::character varying,
    NULL::bigint
  )
);

COMMENT ON POLICY "groups_select" ON public.groups IS
  'Members see their groups via readable_group_ids(); role managers also match by org_id so INSERT ... RETURNING works for new rows invisible to the INSERT snapshot.';
