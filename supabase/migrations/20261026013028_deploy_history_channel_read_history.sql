-- Honor channel.read_history on direct deploy_history reads.
--
-- The deploy_history SELECT policy only checked org membership, so any org
-- member could read the history of every channel, even without a
-- channel.read_history grant (for example org_member with only an app_uploader
-- or app_preview binding) or with an explicit deny override on the channel.
-- Keep the membership predicate unchanged and AND it with the caller's
-- effective channel.read_history permission on the row's org, app and channel.
--
-- Effective permission matches rbac_check_permission_direct with a concrete
-- channel. Role permissions are a union over the org, app and channel scopes,
-- and a channel override replaces the result for that channel, so a row is
-- readable when its channel is not denied by an override and the permission is
-- granted at its org, app or channel scope.
--
-- Every helper starts from caller-scoped, indexed identity data (the caller's
-- org memberships, role bindings, group memberships and permission overrides)
-- and runs rbac_check_permission_direct only for those candidates. None of them
-- scans the apps or channels of an org. Each helper runs once per statement as
-- an InitPlan, and the policy then filters rows by their own owner_org, app_id
-- and channel_id.
--
-- The helpers live in rbac_internal, which PostgREST does not expose, so they
-- are callable from RLS but not as public RPCs.

-- Member orgs where the caller holds channel.read_history at org scope.
CREATE OR REPLACE FUNCTION rbac_internal.deploy_history_allowed_org_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(member.org_id), '{}'::uuid[])
  FROM unnest(public.current_user_member_org_ids()) AS member(org_id)
  WHERE public.rbac_check_permission_direct(
    public.rbac_perm_channel_read_history(),
    (SELECT auth.uid()),
    member.org_id,
    NULL::character varying,
    NULL::bigint,
    NULL::text
  )
$$;

-- Apps bound to the caller (directly or through a group) at app scope where
-- the caller holds channel.read_history.
CREATE OR REPLACE FUNCTION rbac_internal.deploy_history_allowed_app_ids() RETURNS character varying[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  WITH caller AS (
    SELECT (SELECT auth.uid()) AS user_id
  ),
  bound_apps AS (
    SELECT rb.app_id
    FROM caller
    INNER JOIN public.role_bindings AS rb
      ON rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = caller.user_id
      AND rb.scope_type = public.rbac_scope_app()

    UNION

    SELECT rb.app_id
    FROM caller
    INNER JOIN public.group_members AS gm ON gm.user_id = caller.user_id
    INNER JOIN public.role_bindings AS rb
      ON rb.principal_type = public.rbac_principal_group()
      AND rb.principal_id = gm.group_id
      AND rb.scope_type = public.rbac_scope_app()
  )
  SELECT COALESCE(array_agg(a.app_id), '{}'::character varying[])
  FROM bound_apps
  INNER JOIN public.apps AS a ON a.id = bound_apps.app_id
  CROSS JOIN caller
  WHERE a.owner_org = ANY(public.current_user_member_org_ids())
    AND public.rbac_check_permission_direct(
      public.rbac_perm_channel_read_history(),
      caller.user_id,
      a.owner_org,
      a.app_id,
      NULL::bigint,
      NULL::text
    )
$$;

-- Channels bound to the caller (directly or through a group) at channel scope,
-- or carrying one of the caller's channel.read_history overrides.
CREATE OR REPLACE FUNCTION rbac_internal.deploy_history_channel_candidates() RETURNS TABLE (
    channel_id bigint, allowed boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  WITH caller AS (
    SELECT (SELECT auth.uid()) AS user_id
  ),
  candidates AS (
    SELECT ch.id
    FROM caller
    INNER JOIN public.role_bindings AS rb
      ON rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = caller.user_id
      AND rb.scope_type = public.rbac_scope_channel()
    INNER JOIN public.channels AS ch ON ch.rbac_id = rb.channel_id

    UNION

    SELECT ch.id
    FROM caller
    INNER JOIN public.group_members AS gm ON gm.user_id = caller.user_id
    INNER JOIN public.role_bindings AS rb
      ON rb.principal_type = public.rbac_principal_group()
      AND rb.principal_id = gm.group_id
      AND rb.scope_type = public.rbac_scope_channel()
    INNER JOIN public.channels AS ch ON ch.rbac_id = rb.channel_id

    UNION

    SELECT o.channel_id
    FROM caller
    INNER JOIN public.channel_permission_overrides AS o
      ON o.principal_type = public.rbac_principal_user()
      AND o.principal_id = caller.user_id
      AND o.permission_key = public.rbac_perm_channel_read_history()
  )
  SELECT
    ch.id AS channel_id,
    public.rbac_check_permission_direct(
      public.rbac_perm_channel_read_history(),
      caller.user_id,
      ch.owner_org,
      ch.app_id,
      ch.id,
      NULL::text
    ) AS allowed
  FROM candidates
  INNER JOIN public.channels AS ch ON ch.id = candidates.id
  CROSS JOIN caller
  WHERE ch.owner_org = ANY(public.current_user_member_org_ids())
$$;

CREATE OR REPLACE FUNCTION rbac_internal.deploy_history_allowed_channel_ids() RETURNS bigint[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(c.channel_id), '{}'::bigint[])
  FROM rbac_internal.deploy_history_channel_candidates() AS c
  WHERE c.allowed
$$;

-- Channels where an override (or any other channel-level rule) leaves the
-- caller without channel.read_history. Only candidate channels can be denied
-- while their org or app grants the permission.
CREATE OR REPLACE FUNCTION rbac_internal.deploy_history_denied_channel_ids() RETURNS bigint[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(c.channel_id), '{}'::bigint[])
  FROM rbac_internal.deploy_history_channel_candidates() AS c
  WHERE NOT c.allowed
$$;

ALTER FUNCTION rbac_internal.deploy_history_allowed_org_ids() OWNER TO postgres;
ALTER FUNCTION rbac_internal.deploy_history_allowed_app_ids() OWNER TO postgres;
ALTER FUNCTION rbac_internal.deploy_history_channel_candidates() OWNER TO postgres;
ALTER FUNCTION rbac_internal.deploy_history_allowed_channel_ids() OWNER TO postgres;
ALTER FUNCTION rbac_internal.deploy_history_denied_channel_ids() OWNER TO postgres;

COMMENT ON FUNCTION rbac_internal.deploy_history_allowed_org_ids() IS 'RLS helper: member orgs where the caller holds channel.read_history at org scope. Used by the deploy_history SELECT policy.';
COMMENT ON FUNCTION rbac_internal.deploy_history_allowed_app_ids() IS 'RLS helper: apps bound to the caller at app scope where the caller holds channel.read_history. Used by the deploy_history SELECT policy.';
COMMENT ON FUNCTION rbac_internal.deploy_history_channel_candidates() IS 'RLS helper: channels bound to the caller at channel scope or carrying a caller channel.read_history override, with the effective permission for each.';
COMMENT ON FUNCTION rbac_internal.deploy_history_allowed_channel_ids() IS 'RLS helper: candidate channels where the caller holds channel.read_history. Used by the deploy_history SELECT policy.';
COMMENT ON FUNCTION rbac_internal.deploy_history_denied_channel_ids() IS 'RLS helper: candidate channels where the caller lacks channel.read_history (for example an explicit deny override). Used by the deploy_history SELECT policy.';

REVOKE ALL ON FUNCTION rbac_internal.deploy_history_allowed_org_ids() FROM public;
REVOKE ALL ON FUNCTION rbac_internal.deploy_history_allowed_app_ids() FROM public;
REVOKE ALL ON FUNCTION rbac_internal.deploy_history_channel_candidates() FROM public;
REVOKE ALL ON FUNCTION rbac_internal.deploy_history_allowed_channel_ids() FROM public;
REVOKE ALL ON FUNCTION rbac_internal.deploy_history_denied_channel_ids() FROM public;
GRANT ALL ON FUNCTION rbac_internal.deploy_history_allowed_org_ids() TO authenticated,
service_role;
GRANT ALL ON FUNCTION rbac_internal.deploy_history_allowed_app_ids() TO authenticated,
service_role;
GRANT ALL ON FUNCTION rbac_internal.deploy_history_channel_candidates() TO authenticated,
service_role;
GRANT ALL ON FUNCTION rbac_internal.deploy_history_allowed_channel_ids() TO authenticated,
service_role;
GRANT ALL ON FUNCTION rbac_internal.deploy_history_denied_channel_ids() TO authenticated,
service_role;

DROP POLICY IF EXISTS "Allow users to view deploy history for their org" ON public.deploy_history;

CREATE POLICY "Allow users to view deploy history for their org" ON public.deploy_history
FOR SELECT
TO authenticated
USING (
    (
        owner_org
        = ANY(
            COALESCE(
                (
                    SELECT
                        public.current_user_member_org_ids()
                            AS current_user_member_org_ids
                ),
                '{}'::uuid[]
            )
        )
    )
    AND NOT (
        channel_id
        = ANY(
            COALESCE(
                (
                    SELECT
                        rbac_internal.deploy_history_denied_channel_ids()
                            AS deploy_history_denied_channel_ids
                ),
                '{}'::bigint[]
            )
        )
    )
    AND (
        (
            owner_org
            = ANY(
                COALESCE(
                    (
                        SELECT
                            rbac_internal.deploy_history_allowed_org_ids()
                                AS deploy_history_allowed_org_ids
                    ),
                    '{}'::uuid[]
                )
            )
        )
        OR (
            app_id
            = ANY(
                COALESCE(
                    (
                        SELECT
                            rbac_internal.deploy_history_allowed_app_ids()
                                AS deploy_history_allowed_app_ids
                    ),
                    '{}'::character varying[]
                )
            )
        )
        OR (
            channel_id
            = ANY(
                COALESCE(
                    (
                        SELECT
                            rbac_internal.deploy_history_allowed_channel_ids()
                                AS deploy_history_allowed_channel_ids
                    ),
                    '{}'::bigint[]
                )
            )
        )
    )
);
