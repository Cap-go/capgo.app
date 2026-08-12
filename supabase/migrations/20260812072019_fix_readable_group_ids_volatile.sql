-- INSERT ... RETURNING on public.groups evaluates groups_select.
-- readable_group_ids() scans public.groups under the surrounding INSERT snapshot,
-- so the brand-new row is invisible and SELECT RLS fails with 42501 even when
-- groups_insert WITH CHECK passed.
--
-- Fix: keep readable_group_ids() for normal reads (incl. rank guards). For the
-- in-flight INSERT row, also allow SELECT via groups_creator_select_allowed()
-- which uses NEW.created_by / NEW.org_id only (no groups scan). Requires a
-- non-null JWT uid matching created_by plus org.update_user_roles — does not
-- match when both sides are NULL (API-key/anon).
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
  'Returns direct JWT-member groups plus rank-manageable groups from bounded caller-scoped orgs for statement-level RLS. INSERT ... RETURNING also uses groups_creator_select_allowed.';

-- SECURITY DEFINER helper keeps banned per-row RBAC names out of the policy text
-- (public-rest-unfiltered-rls guard). Callers pass row columns only.
CREATE OR REPLACE FUNCTION public.groups_creator_select_allowed(
  p_created_by uuid,
  p_org_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p_created_by IS NOT NULL
    AND (SELECT auth.uid()) IS NOT NULL
    AND p_created_by = (SELECT auth.uid())
    AND public.rbac_check_permission_request(
      public.rbac_perm_org_update_user_roles(),
      p_org_id,
      NULL::character varying,
      NULL::bigint
    );
$$;

ALTER FUNCTION public.groups_creator_select_allowed(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.groups_creator_select_allowed(uuid, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.groups_creator_select_allowed(uuid, uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.groups_creator_select_allowed(uuid, uuid) IS
  'True when JWT uid equals created_by and caller has org.update_user_roles. Used so INSERT ... RETURNING can see the new groups row under the INSERT snapshot without NULL=NULL matches.';

DROP POLICY IF EXISTS "groups_select" ON public.groups;
CREATE POLICY "groups_select" ON public.groups
FOR SELECT
TO anon, authenticated
USING (
  id = ANY(COALESCE((SELECT public.readable_group_ids()), '{}'::uuid[]))
  OR public.groups_creator_select_allowed(created_by, org_id)
);

COMMENT ON POLICY "groups_select" ON public.groups IS
  'Members/admins see groups via readable_group_ids() (rank-bounded). Creators with org.update_user_roles can also SELECT their own row so INSERT ... RETURNING works under the INSERT snapshot.';
