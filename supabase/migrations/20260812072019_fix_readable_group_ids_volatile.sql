-- INSERT ... RETURNING on public.groups evaluates groups_select.
-- readable_group_ids() scans public.groups under the surrounding INSERT snapshot,
-- so the brand-new row is invisible and SELECT RLS fails with 42501 even when
-- groups_insert WITH CHECK passed.
--
-- Fix: BEFORE INSERT marks the new id in a transaction-local GUC. SELECT allows
-- that id only while the marker matches and created_by = auth.uid() (non-null).
-- No lasting rank bypass, no per-row RBAC on listings. Helper is VOLATILE so it
-- sees the same-command set_config (STABLE would miss it).
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
  'Returns direct JWT-member groups plus rank-manageable groups from bounded caller-scoped orgs for statement-level RLS.';

CREATE OR REPLACE FUNCTION public.groups_mark_inserting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.set_config('capgo.groups_inserting', NEW.id::text, true);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.groups_mark_inserting() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.groups_mark_inserting() FROM PUBLIC;

COMMENT ON FUNCTION public.groups_mark_inserting() IS
  'BEFORE INSERT: store new group id in a transaction-local GUC for INSERT ... RETURNING SELECT RLS.';

DROP TRIGGER IF EXISTS groups_mark_inserting ON public.groups;
CREATE TRIGGER groups_mark_inserting
BEFORE INSERT ON public.groups
FOR EACH ROW
EXECUTE FUNCTION public.groups_mark_inserting();

CREATE OR REPLACE FUNCTION public.groups_is_insert_returning_row(
  p_id uuid,
  p_created_by uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  marker text;
  uid uuid;
BEGIN
  uid := (SELECT auth.uid());
  IF p_id IS NULL OR p_created_by IS NULL OR uid IS NULL OR p_created_by IS DISTINCT FROM uid THEN
    RETURN false;
  END IF;
  marker := pg_catalog.current_setting('capgo.groups_inserting', true);
  RETURN marker IS NOT NULL AND marker <> '' AND marker = p_id::text;
END;
$$;

ALTER FUNCTION public.groups_is_insert_returning_row(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.groups_is_insert_returning_row(uuid, uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.groups_is_insert_returning_row(uuid, uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.groups_is_insert_returning_row(uuid, uuid) IS
  'VOLATILE: true only for the in-flight INSERT row marked by groups_mark_inserting when created_by matches JWT uid.';

-- Drop prior PR iteration helper if present on a reset DB mid-review.
DROP FUNCTION IF EXISTS public.groups_creator_select_allowed(uuid, uuid);

DROP POLICY IF EXISTS "groups_select" ON public.groups;
CREATE POLICY "groups_select" ON public.groups
FOR SELECT
TO anon, authenticated
USING (
  id = ANY(COALESCE((SELECT public.readable_group_ids()), '{}'::uuid[]))
  OR public.groups_is_insert_returning_row(id, created_by)
);

COMMENT ON POLICY "groups_select" ON public.groups IS
  'Members/admins see groups via readable_group_ids() (rank-bounded). INSERT ... RETURNING also allows the transaction-local insert marker for the creator row.';
