-- INSERT ... RETURNING on public.groups evaluates groups_select, which calls
-- readable_group_ids(). That helper was STABLE, so Postgres can use a snapshot
-- that does not include the row being inserted. The SELECT policy then fails and
-- PostgREST surfaces 42501 even when groups_insert WITH CHECK passed.
-- VOLATILE forces a fresh read so newly inserted unbound groups are visible.
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
  'Returns direct JWT-member groups plus rank-manageable groups from bounded caller-scoped orgs for statement-level RLS. VOLATILE so INSERT ... RETURNING can see the new row.';
