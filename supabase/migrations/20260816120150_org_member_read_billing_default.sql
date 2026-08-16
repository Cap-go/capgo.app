-- Default org.read_billing for org_member, redact billing when missing,
-- gate stripe_info on billing read, and backfill existing users so they keep
-- the billing visibility the previous get_orgs_v7 leak already exposed.

-- 1) Default role: every org_member can read plan/usage unless an org removes it.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key = public.rbac_perm_org_read_billing()
WHERE r.name = public.rbac_role_org_member()
ON CONFLICT DO NOTHING;

-- 2) Legacy backfill role for users who previously saw billing via get_orgs_v7
-- without holding org.read_billing (typically app/channel-only membership).
INSERT INTO public.roles (name, scope_type, description, priority_rank, is_assignable, created_by)
VALUES (
  'org_billing_reader',
  public.rbac_scope_org(),
  'Legacy billing read access preserved for users who already saw plan/usage before org.read_billing was enforced',
  5,
  false,
  NULL
)
ON CONFLICT (name) DO UPDATE
SET
  scope_type = EXCLUDED.scope_type,
  description = EXCLUDED.description,
  priority_rank = EXCLUDED.priority_rank,
  is_assignable = EXCLUDED.is_assignable;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key = public.rbac_perm_org_read_billing()
WHERE r.name = 'org_billing_reader'
ON CONFLICT DO NOTHING;

-- 3) Backfill users who can reach an org but still lack org.read_billing.
-- role_bindings allows only one org-scoped binding per principal/org, so:
--   - extend existing org-scoped roles that lack the permission
--   - otherwise attach the non-assignable org_billing_reader role
CREATE TABLE public._tmp_needs_org_read_billing AS
WITH users_with_billing AS (
  SELECT DISTINCT rb.principal_id AS user_id, rb.org_id
  FROM public.role_bindings rb
  JOIN public.role_permissions rp ON rp.role_id = rb.role_id
  JOIN public.permissions p ON p.id = rp.permission_id
    AND p.key = public.rbac_perm_org_read_billing()
  WHERE rb.principal_type = public.rbac_principal_user()
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT DISTINCT gm.user_id, rb.org_id
  FROM public.role_bindings rb
  JOIN public.group_members gm ON gm.group_id = rb.principal_id
  JOIN public.role_permissions rp ON rp.role_id = rb.role_id
  JOIN public.permissions p ON p.id = rp.permission_id
    AND p.key = public.rbac_perm_org_read_billing()
  WHERE rb.principal_type = public.rbac_principal_group()
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())
),
org_reach AS (
  SELECT DISTINCT rb.principal_id AS user_id, rb.org_id
  FROM public.role_bindings rb
  WHERE rb.principal_type = public.rbac_principal_user()
    AND rb.scope_type = public.rbac_scope_org()
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT DISTINCT gm.user_id, rb.org_id
  FROM public.role_bindings rb
  JOIN public.group_members gm ON gm.group_id = rb.principal_id
  WHERE rb.principal_type = public.rbac_principal_group()
    AND rb.scope_type = public.rbac_scope_org()
    AND rb.org_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT DISTINCT rb.principal_id AS user_id, apps.owner_org AS org_id
  FROM public.role_bindings rb
  JOIN public.apps ON apps.id = rb.app_id
  WHERE rb.principal_type = public.rbac_principal_user()
    AND rb.app_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT DISTINCT gm.user_id, apps.owner_org AS org_id
  FROM public.role_bindings rb
  JOIN public.group_members gm ON gm.group_id = rb.principal_id
  JOIN public.apps ON apps.id = rb.app_id
  WHERE rb.principal_type = public.rbac_principal_group()
    AND rb.app_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT DISTINCT rb.principal_id AS user_id, apps.owner_org AS org_id
  FROM public.role_bindings rb
  JOIN public.channels ch ON ch.rbac_id = rb.channel_id
  JOIN public.apps ON apps.app_id = ch.app_id
  WHERE rb.principal_type = public.rbac_principal_user()
    AND rb.channel_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT DISTINCT gm.user_id, apps.owner_org AS org_id
  FROM public.role_bindings rb
  JOIN public.group_members gm ON gm.group_id = rb.principal_id
  JOIN public.channels ch ON ch.rbac_id = rb.channel_id
  JOIN public.apps ON apps.app_id = ch.app_id
  WHERE rb.principal_type = public.rbac_principal_group()
    AND rb.channel_id IS NOT NULL
    AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT DISTINCT ou.user_id, ou.org_id
  FROM public.org_users ou
  WHERE ou.user_id IS NOT NULL
    AND ou.org_id IS NOT NULL
    AND COALESCE(ou.is_invite, false) = false
)
SELECT org_reach.user_id, org_reach.org_id
FROM org_reach
LEFT JOIN users_with_billing uwb
  ON uwb.user_id = org_reach.user_id
 AND uwb.org_id = org_reach.org_id
WHERE uwb.user_id IS NULL;

CREATE INDEX ON public._tmp_needs_org_read_billing (user_id, org_id);

-- 3a) Extend existing org-scoped roles (one binding per principal/org).
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT DISTINCT src.role_id, p.id
FROM (
  SELECT rb.role_id
  FROM public._tmp_needs_org_read_billing nb
  JOIN public.role_bindings rb
    ON rb.principal_type = public.rbac_principal_user()
   AND rb.principal_id = nb.user_id
   AND rb.org_id = nb.org_id
   AND rb.scope_type = public.rbac_scope_org()
   AND (rb.expires_at IS NULL OR rb.expires_at > now())

  UNION

  SELECT rb.role_id
  FROM public._tmp_needs_org_read_billing nb
  JOIN public.group_members gm ON gm.user_id = nb.user_id
  JOIN public.role_bindings rb
    ON rb.principal_type = public.rbac_principal_group()
   AND rb.principal_id = gm.group_id
   AND rb.org_id = nb.org_id
   AND rb.scope_type = public.rbac_scope_org()
   AND (rb.expires_at IS NULL OR rb.expires_at > now())
) src
JOIN public.permissions p ON p.key = public.rbac_perm_org_read_billing()
ON CONFLICT DO NOTHING;

-- 3b) App/channel-only users: attach org_billing_reader when no org binding exists.
INSERT INTO public.role_bindings (
  principal_type,
  principal_id,
  role_id,
  scope_type,
  org_id,
  granted_by,
  reason,
  is_direct
)
SELECT
  public.rbac_principal_user(),
  nb.user_id,
  roles.id,
  public.rbac_scope_org(),
  nb.org_id,
  nb.user_id,
  'Backfill org.read_billing for users who previously saw billing without the permission',
  true
FROM public._tmp_needs_org_read_billing nb
JOIN public.roles ON roles.name = 'org_billing_reader'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.role_bindings existing
  WHERE existing.principal_type = public.rbac_principal_user()
    AND existing.principal_id = nb.user_id
    AND existing.scope_type = public.rbac_scope_org()
    AND existing.org_id = nb.org_id
    AND (existing.expires_at IS NULL OR existing.expires_at > now())
)
AND NOT EXISTS (
  SELECT 1
  FROM public.group_members gm
  JOIN public.role_bindings existing
    ON existing.principal_type = public.rbac_principal_group()
   AND existing.principal_id = gm.group_id
   AND existing.scope_type = public.rbac_scope_org()
   AND existing.org_id = nb.org_id
   AND (existing.expires_at IS NULL OR existing.expires_at > now())
  WHERE gm.user_id = nb.user_id
);

DROP TABLE public._tmp_needs_org_read_billing;

-- 4) stripe_info SELECT follows org.read_billing, not bare org.read.
CREATE OR REPLACE FUNCTION public.readable_org_customer_ids()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(DISTINCT orgs.customer_id::text), '{}'::text[])
  FROM public.orgs
  WHERE orgs.customer_id IS NOT NULL
    AND orgs.id = ANY(COALESCE(
      (SELECT public.rbac_org_ids_for_permission(public.rbac_perm_org_read_billing())),
      '{}'::uuid[]
    ))
$$;

COMMENT ON FUNCTION public.readable_org_customer_ids() IS
  'Customer IDs whose stripe_info rows are readable by the caller through org.read_billing.';

-- 5) Redact billing fields in get_orgs_v7 when the user lacks org.read_billing.
CREATE OR REPLACE FUNCTION "public"."get_orgs_v7"("userid" "uuid") RETURNS TABLE("gid" "uuid", "created_by" "uuid", "created_at" timestamp with time zone, "logo" "text", "website" "text", "name" "text", "role" character varying, "is_invite" boolean, "paying" boolean, "trial_left" integer, "can_use_more" boolean, "is_canceled" boolean, "app_count" bigint, "subscription_start" timestamp with time zone, "subscription_end" timestamp with time zone, "management_email" "text", "is_yearly" boolean, "stats_updated_at" timestamp without time zone, "stats_refresh_requested_at" timestamp without time zone, "next_stats_update_at" timestamp with time zone, "credit_available" numeric, "credit_total" numeric, "credit_next_expiration" timestamp with time zone, "enforcing_2fa" boolean, "2fa_has_access" boolean, "enforce_hashed_api_keys" boolean, "password_policy_config" "jsonb", "password_has_access" boolean, "require_apikey_expiration" boolean, "max_apikey_expiration_days" integer, "enforce_encrypted_bundles" boolean, "required_encryption_key" character varying)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  RETURN QUERY
  WITH app_counts AS (
    SELECT owner_org, COUNT(*) AS cnt
    FROM public.apps
    GROUP BY owner_org
  ),
  rbac_role_candidates AS (
    SELECT rb.org_id, r.name, r.priority_rank
    FROM public.role_bindings rb
    JOIN public.roles r ON rb.role_id = r.id
      AND r.scope_type = rb.scope_type
    WHERE rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = userid
      AND rb.scope_type = public.rbac_scope_org()
      AND rb.org_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION ALL
    SELECT rb.org_id, r.name, r.priority_rank
    FROM public.role_bindings rb
    JOIN public.group_members gm ON gm.group_id = rb.principal_id
    JOIN public.roles r ON rb.role_id = r.id
      AND r.scope_type = rb.scope_type
    WHERE rb.principal_type = public.rbac_principal_group()
      AND gm.user_id = userid
      AND rb.scope_type = public.rbac_scope_org()
      AND rb.org_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
  ),
  rbac_org_roles AS (
    SELECT org_id, (ARRAY_AGG(rbac_role_candidates.name ORDER BY rbac_role_candidates.priority_rank DESC))[1] AS role_name
    FROM rbac_role_candidates
    GROUP BY org_id
  ),
  rbac_org_ids AS (
    SELECT org_id
    FROM rbac_org_roles
    UNION
    SELECT apps.owner_org
    FROM public.role_bindings rb
    JOIN public.apps ON apps.id = rb.app_id
    WHERE rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = userid
      AND rb.app_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION
    SELECT apps.owner_org
    FROM public.role_bindings rb
    JOIN public.channels ch ON ch.rbac_id = rb.channel_id
    JOIN public.apps ON apps.app_id = ch.app_id
    WHERE rb.principal_type = public.rbac_principal_user()
      AND rb.principal_id = userid
      AND rb.channel_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION
    SELECT rb.org_id
    FROM public.role_bindings rb
    JOIN public.group_members gm ON gm.group_id = rb.principal_id
    WHERE rb.principal_type = public.rbac_principal_group()
      AND gm.user_id = userid
      AND rb.org_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION
    SELECT apps.owner_org
    FROM public.role_bindings rb
    JOIN public.group_members gm ON gm.group_id = rb.principal_id
    JOIN public.apps ON apps.id = rb.app_id
    WHERE rb.principal_type = public.rbac_principal_group()
      AND gm.user_id = userid
      AND rb.app_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
    UNION
    SELECT apps.owner_org
    FROM public.role_bindings rb
    JOIN public.group_members gm ON gm.group_id = rb.principal_id
    JOIN public.channels ch ON ch.rbac_id = rb.channel_id
    JOIN public.apps ON apps.app_id = ch.app_id
    WHERE rb.principal_type = public.rbac_principal_group()
      AND gm.user_id = userid
      AND rb.channel_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
  ),
  pending_invites AS (
    SELECT ou.org_id, COALESCE(ou.rbac_role_name, public.rbac_role_org_member()) AS role_name
    FROM public.org_users ou
    WHERE ou.user_id = userid
      AND ou.is_invite IS TRUE
  ),
  user_orgs AS (
    SELECT rbac_org_ids.org_id
    FROM rbac_org_ids
    WHERE rbac_org_ids.org_id IS NOT NULL
    UNION
    SELECT pending_invites.org_id
    FROM pending_invites
  ),
  time_constants AS (
    SELECT
      NOW() AS current_time,
      date_trunc('MONTH', NOW()) AS current_month_start,
      '0 DAYS'::INTERVAL AS zero_day_interval
  ),
  paying_orgs_ordered AS (
    SELECT
      o.id,
      ROW_NUMBER() OVER (ORDER BY o.id ASC) - 1 AS preceding_count
    FROM public.orgs o
    JOIN public.stripe_info si ON o.customer_id = si.customer_id
    CROSS JOIN time_constants tc
    WHERE (
      (si.status = 'succeeded'
        AND (si.canceled_at IS NULL OR si.canceled_at > tc.current_time)
        AND si.subscription_anchor_end > tc.current_time)
      OR si.trial_at > tc.current_time
    )
  ),
  billing_cycles AS (
    SELECT
      o.id AS org_id,
      CASE
        WHEN COALESCE(si.subscription_anchor_start - date_trunc('MONTH', si.subscription_anchor_start), tc.zero_day_interval)
             > tc.current_time - tc.current_month_start
        THEN date_trunc('MONTH', tc.current_time - INTERVAL '1 MONTH')
             + COALESCE(si.subscription_anchor_start - date_trunc('MONTH', si.subscription_anchor_start), tc.zero_day_interval)
        ELSE tc.current_month_start
             + COALESCE(si.subscription_anchor_start - date_trunc('MONTH', si.subscription_anchor_start), tc.zero_day_interval)
      END AS cycle_start
    FROM public.orgs o
    CROSS JOIN time_constants tc
    LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
  ),
  two_fa_access AS (
    SELECT
      o.id AS org_id,
      o.enforcing_2fa,
      CASE
        WHEN o.enforcing_2fa = false THEN true
        ELSE public.has_2fa_enabled(userid)
      END AS "2fa_has_access",
      (o.enforcing_2fa = true AND NOT public.has_2fa_enabled(userid)) AS should_redact_2fa
    FROM public.orgs o
    JOIN user_orgs uo ON uo.org_id = o.id
  ),
  password_policy_access AS (
    SELECT
      o.id AS org_id,
      o.password_policy_config,
      public.user_meets_password_policy(userid, o.id) AS password_has_access,
      NOT public.user_meets_password_policy(userid, o.id) AS should_redact_password
    FROM public.orgs o
    JOIN user_orgs uo ON uo.org_id = o.id
  ),
  billing_access AS (
    SELECT
      o.id AS org_id,
      NOT public.rbac_check_permission_direct(
        public.rbac_perm_org_read_billing(),
        userid,
        o.id,
        NULL::character varying,
        NULL::bigint,
        NULL
      ) AS should_redact_billing
    FROM public.orgs o
    JOIN user_orgs uo ON uo.org_id = o.id
  )
  SELECT
    o.id AS gid,
    o.created_by,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN NULL::timestamptz
      ELSE o.created_at
    END AS created_at,
    o.logo,
    o.website,
    o.name,
    COALESCE(pi.role_name::varchar, ror.role_name::varchar, public.rbac_role_org_member()::varchar) AS role,
    (pi.org_id IS NOT NULL) AS is_invite,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN false
      ELSE COALESCE(si.status = 'succeeded', false)
    END AS paying,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN 0
      ELSE GREATEST(COALESCE((si.trial_at::date - NOW()::date), 0), 0)::integer
    END AS trial_left,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN false
      ELSE COALESCE((si.status = 'succeeded' AND si.is_good_plan = true)
        OR (si.trial_at::date - NOW()::date > 0)
        OR COALESCE(ucb.available_credits, 0) > 0, false)
    END AS can_use_more,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN false
      ELSE COALESCE(si.status = 'canceled', false)
    END AS is_canceled,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN 0::bigint
      ELSE COALESCE(ac.cnt, 0)
    END AS app_count,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN NULL::timestamptz
      ELSE bc.cycle_start
    END AS subscription_start,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN NULL::timestamptz
      ELSE (bc.cycle_start + INTERVAL '1 MONTH')
    END AS subscription_end,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN NULL::text
      ELSE o.management_email
    END AS management_email,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN false
      ELSE COALESCE(si.price_id = p.price_y_id, false)
    END AS is_yearly,
    o.stats_updated_at,
    o.stats_refresh_requested_at,
    CASE
      WHEN poo.id IS NOT NULL THEN
        public.get_next_cron_time('0 3 * * *', NOW()) + make_interval(mins => poo.preceding_count::int * 4)
      ELSE NULL
    END AS next_stats_update_at,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN NULL::numeric
      ELSE COALESCE(ucb.available_credits, 0)
    END AS credit_available,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN NULL::numeric
      ELSE COALESCE(ucb.total_credits, 0)
    END AS credit_total,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password OR ba.should_redact_billing THEN NULL::timestamptz
      ELSE ucb.next_expiration
    END AS credit_next_expiration,
    tfa.enforcing_2fa,
    tfa."2fa_has_access",
    o.enforce_hashed_api_keys,
    ppa.password_policy_config,
    ppa.password_has_access,
    o.require_apikey_expiration,
    o.max_apikey_expiration_days,
    o.enforce_encrypted_bundles,
    o.required_encryption_key
  FROM public.orgs o
  JOIN user_orgs uo ON uo.org_id = o.id
  LEFT JOIN pending_invites pi ON pi.org_id = o.id
  LEFT JOIN rbac_org_roles ror ON ror.org_id = o.id
  LEFT JOIN two_fa_access tfa ON tfa.org_id = o.id
  LEFT JOIN password_policy_access ppa ON ppa.org_id = o.id
  LEFT JOIN billing_access ba ON ba.org_id = o.id
  LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
  LEFT JOIN public.plans p ON si.product_id = p.stripe_id
  LEFT JOIN app_counts ac ON ac.owner_org = o.id
  LEFT JOIN public.usage_credit_balances ucb ON ucb.org_id = o.id
  LEFT JOIN paying_orgs_ordered poo ON poo.id = o.id
  LEFT JOIN billing_cycles bc ON bc.org_id = o.id;
END;
$$;

COMMENT ON FUNCTION public.get_orgs_v7(uuid) IS
  'Org membership list for a user. Billing/plan/credit fields are null/false when the user lacks org.read_billing for that org.';
