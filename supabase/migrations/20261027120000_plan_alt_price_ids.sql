-- Plans can bill through more than one Stripe price: one per regional price tier (PPP: a price has a
-- single amount per currency, so countries sharing a currency need separate prices), and replaced
-- prices kept for existing subscriptions (Stripe never lets an existing currency_options amount change).
-- price_m_id / price_y_id (+ _us) stay the full-price tier; regional_price_ids names the other tiers
-- Checkout sells; alt_price_*_ids lists every other price so subscriptions resolve to monthly/yearly.
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS alt_price_m_ids text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS alt_price_y_ids text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS regional_price_ids jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.plans
  DROP CONSTRAINT IF EXISTS plans_regional_price_ids_object,
  ADD CONSTRAINT plans_regional_price_ids_object CHECK (jsonb_typeof(regional_price_ids) = 'object');

COMMENT ON COLUMN public.plans.alt_price_m_ids IS
  'Every other monthly Stripe price ID (EE and US) billed as this plan: regional tiers and replaced prices.';
COMMENT ON COLUMN public.plans.alt_price_y_ids IS
  'Every other yearly Stripe price ID (EE and US) billed as this plan: regional tiers and replaced prices.';
COMMENT ON COLUMN public.plans.regional_price_ids IS
  'Stripe prices per regional price tier: {"<tier>": {"price_m_id", "price_y_id", "price_m_id_us", "price_y_id_us"}}. Tiers absent here sell the full price.';

-- Regional prices always count as this plan, and a replaced one keeps counting: IDs are only ever added.
CREATE OR REPLACE FUNCTION public.plans_sync_alt_price_ids()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  -- Left to the plans_regional_price_ids_object check, which reports it properly.
  IF jsonb_typeof(NEW.regional_price_ids) IS DISTINCT FROM 'object' THEN
    RETURN NEW;
  END IF;
  NEW.alt_price_m_ids := ARRAY(
    SELECT DISTINCT id FROM unnest(
      NEW.alt_price_m_ids
      || ARRAY(SELECT tier.value->>'price_m_id' FROM jsonb_each(NEW.regional_price_ids) AS tier)
      || ARRAY(SELECT tier.value->>'price_m_id_us' FROM jsonb_each(NEW.regional_price_ids) AS tier)
    ) AS id
    WHERE id IS NOT NULL AND id <> ''
  );
  NEW.alt_price_y_ids := ARRAY(
    SELECT DISTINCT id FROM unnest(
      NEW.alt_price_y_ids
      || ARRAY(SELECT tier.value->>'price_y_id' FROM jsonb_each(NEW.regional_price_ids) AS tier)
      || ARRAY(SELECT tier.value->>'price_y_id_us' FROM jsonb_each(NEW.regional_price_ids) AS tier)
    ) AS id
    WHERE id IS NOT NULL AND id <> ''
  );
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.plans_sync_alt_price_ids() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.plans_sync_alt_price_ids() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS plans_sync_alt_price_ids ON public.plans;
CREATE TRIGGER plans_sync_alt_price_ids
  BEFORE INSERT OR UPDATE OF alt_price_m_ids, alt_price_y_ids, regional_price_ids ON public.plans
  FOR EACH ROW
  EXECUTE FUNCTION public.plans_sync_alt_price_ids();

-- Same definitions as 20261016180100_dual_stripe_plan_lookups.sql, also matching alt_price_*_ids.
CREATE OR REPLACE FUNCTION public.get_customer_counts()
 RETURNS TABLE(yearly bigint, monthly bigint, total bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  WITH ActiveSubscriptions AS (
    SELECT DISTINCT ON (customer_id)
      customer_id,
      price_id,
      status,
      trial_at
    FROM public.stripe_info
    WHERE status = 'succeeded'
    ORDER BY customer_id, created_at DESC
  )
  SELECT
    COUNT(CASE WHEN s.price_id IN (SELECT price_y_id FROM public.plans WHERE price_y_id IS NOT NULL UNION ALL SELECT price_y_id_us FROM public.plans WHERE price_y_id_us IS NOT NULL UNION ALL SELECT unnest(alt_price_y_ids) FROM public.plans) THEN 1 END) AS yearly,
    COUNT(CASE WHEN s.price_id IN (SELECT price_m_id FROM public.plans WHERE price_m_id IS NOT NULL UNION ALL SELECT price_m_id_us FROM public.plans WHERE price_m_id_us IS NOT NULL UNION ALL SELECT unnest(alt_price_m_ids) FROM public.plans) THEN 1 END) AS monthly,
    COUNT(*) AS total
  FROM ActiveSubscriptions s;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_org_yearly(orgid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  is_yearly boolean;
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(public.rbac_perm_org_read_billing(), orgid, NULL::character varying, NULL::bigint)
  THEN
    RETURN false;
  END IF;

  SELECT
    CASE
      WHEN si.price_id IN (p.price_y_id, p.price_y_id_us) OR si.price_id = ANY(p.alt_price_y_ids) THEN true
      ELSE false
    END INTO is_yearly
  FROM public.orgs o
  JOIN public.stripe_info si ON o.customer_id = si.customer_id
  JOIN public.plans p ON si.product_id IN (p.stripe_id, p.stripe_id_us)
  WHERE o.id = orgid
  LIMIT 1;

  RETURN COALESCE(is_yearly, false);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_orgs_v7(userid uuid)
 RETURNS TABLE(gid uuid, created_by uuid, created_at timestamp with time zone, logo text, website text, name text, role character varying, is_invite boolean, paying boolean, trial_left integer, can_use_more boolean, is_canceled boolean, app_count bigint, subscription_start timestamp with time zone, subscription_end timestamp with time zone, management_email text, is_yearly boolean, stats_updated_at timestamp without time zone, stats_refresh_requested_at timestamp without time zone, next_stats_update_at timestamp with time zone, credit_available numeric, credit_total numeric, credit_next_expiration timestamp with time zone, enforcing_2fa boolean, "2fa_has_access" boolean, enforce_hashed_api_keys boolean, password_policy_config jsonb, password_has_access boolean, require_apikey_expiration boolean, max_apikey_expiration_days integer, enforce_encrypted_bundles boolean, required_encryption_key character varying)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      -- Hide non-assignable backfill roles from the public role label.
      AND r.is_assignable = true
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
      AND r.is_assignable = true
    WHERE rb.principal_type = public.rbac_principal_group()
      AND gm.user_id = userid
      AND rb.scope_type = public.rbac_scope_org()
      AND rb.org_id IS NOT NULL
      AND (rb.expires_at IS NULL OR rb.expires_at > now())
  ),
  rbac_org_roles AS (
    SELECT org_id,
      (ARRAY_AGG(rbac_role_candidates.name ORDER BY rbac_role_candidates.priority_rank DESC))[1] AS role_name
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
    SELECT ou.org_id,
      COALESCE(ou.rbac_role_name, public.rbac_role_org_member()) AS role_name
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
      cycle.cycle_start,
      cycle.cycle_end
    FROM public.orgs o
    JOIN user_orgs uo ON uo.org_id = o.id
    LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
    CROSS JOIN LATERAL public.billing_cycle_for_anchor(
      si.subscription_anchor_start,
      si.subscription_anchor_end,
      NOW()
    ) AS cycle
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
        public.get_apikey_header()
      ) AS should_redact_billing
    FROM public.orgs o
    JOIN user_orgs uo ON uo.org_id = o.id
  )
  SELECT
    o.id AS gid,
    o.created_by,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password THEN NULL::timestamptz
      ELSE o.created_at
    END AS created_at,
    o.logo,
    o.website,
    o.name,
    COALESCE(
      pi.role_name::varchar,
      ror.role_name::varchar,
      public.rbac_role_org_member()::varchar
    ) AS role,
    (pi.org_id IS NOT NULL) AS is_invite,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN false
      ELSE COALESCE(si.status = 'succeeded', false)
    END AS paying,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN 0
      ELSE GREATEST(COALESCE((si.trial_at::date - NOW()::date), 0), 0)::integer
    END AS trial_left,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN false
      ELSE COALESCE((si.status = 'succeeded' AND si.is_good_plan = true)
        OR (si.trial_at::date - NOW()::date > 0)
        OR COALESCE(ucb.available_credits, 0) > 0, false)
    END AS can_use_more,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN false
      ELSE COALESCE(si.status = 'canceled', false)
    END AS is_canceled,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password THEN 0::bigint
      ELSE COALESCE(ac.cnt, 0)
    END AS app_count,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::timestamptz
      ELSE bc.cycle_start
    END AS subscription_start,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::timestamptz
      ELSE bc.cycle_end
    END AS subscription_end,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::text
      ELSE o.management_email
    END AS management_email,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN false
      ELSE COALESCE(si.price_id IN (p.price_y_id, p.price_y_id_us) OR si.price_id = ANY(p.alt_price_y_ids), false)
    END AS is_yearly,
    CASE
      WHEN refresh_state.org_id IS NULL THEN o.stats_updated_at
      ELSE refresh_state.stats_updated_at
    END AS stats_updated_at,
    CASE
      WHEN refresh_state.org_id IS NULL THEN o.stats_refresh_requested_at
      ELSE GREATEST(
        refresh_state.manual_refresh_requested_at,
        refresh_state.stats_refresh_requested_at
      )
    END AS stats_refresh_requested_at,
    CASE
      WHEN COALESCE(billing_acc.should_redact_billing, true) THEN NULL::timestamptz
      WHEN poo.id IS NOT NULL THEN
        public.get_next_cron_time('0 3 * * *', NOW())
          + make_interval(mins => poo.preceding_count::int * 4)
      ELSE NULL
    END AS next_stats_update_at,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::numeric
      ELSE COALESCE(ucb.available_credits, 0)
    END AS credit_available,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::numeric
      ELSE COALESCE(ucb.total_credits, 0)
    END AS credit_total,
    CASE
      WHEN tfa.should_redact_2fa OR ppa.should_redact_password
        OR COALESCE(billing_acc.should_redact_billing, true) THEN NULL::timestamptz
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
  LEFT JOIN billing_access billing_acc ON billing_acc.org_id = o.id
  LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
  LEFT JOIN public.plans p ON si.product_id IN (p.stripe_id, p.stripe_id_us)
  LEFT JOIN app_counts ac ON ac.owner_org = o.id
  LEFT JOIN public.usage_credit_balances ucb ON ucb.org_id = o.id
  LEFT JOIN paying_orgs_ordered poo ON poo.id = o.id
  LEFT JOIN billing_cycles bc ON bc.org_id = o.id
  LEFT JOIN public.org_stats_refresh_state refresh_state ON refresh_state.org_id = o.id;
END;
$function$
;

-- Switch the live plans to the multi-currency Stripe prices (2026-10). Each price has the same USD amount
-- as before plus ~120 currencies at the market exchange rate.
-- Solo alone is priced by purchasing power: a Stripe price has one amount per currency, so each price
-- tier is its own set of prices, listed in regional_price_ids (country_price_tier.ts maps countries to
-- tiers). Maker, Team and Enterprise cost the same everywhere.
-- The old prices stay active in Stripe for existing subscriptions and are kept in alt_price_*_ids
-- (the plans trigger adds the regional IDs there too).
-- Only rows still on the old live IDs change, so local/test databases and reruns are untouched.

-- Solo
UPDATE public.plans SET
  alt_price_m_ids = ARRAY(SELECT DISTINCT unnest(alt_price_m_ids || ARRAY['price_1KkINoGH46eYKnWwwEi97h1B', 'price_1UDRGPLr632EP5z4ufTRBBzf'])),
  alt_price_y_ids = ARRAY(SELECT DISTINCT unnest(alt_price_y_ids || ARRAY['price_1KjSNTGH46eYKnWwofmXyBZn', 'price_1UDRGULr632EP5z4OcZr5xpe'])),
  price_m_id = 'price_1UUwaeGH46eYKnWwikQlk8Y8',
  price_y_id = 'price_1UUwapGH46eYKnWwXVBNFJsM',
  price_m_id_us = 'price_1UUwcBLr632EP5z4vsqW3Tm3',
  price_y_id_us = 'price_1UUwcMLr632EP5z4pOicTG4d',
  regional_price_ids = '{
    "p85": {"price_m_id": "price_1UUwanGH46eYKnWwKvCMscEf", "price_y_id": "price_1UUwazGH46eYKnWwIMXUE2bK", "price_m_id_us": "price_1UUwcKLr632EP5z4Qpny9Utl", "price_y_id_us": "price_1UUwcVLr632EP5z4b3iWS6mZ"},
    "p70": {"price_m_id": "price_1UUwamGH46eYKnWwHrWIu0pc", "price_y_id": "price_1UUwaxGH46eYKnWwwmPm9ucX", "price_m_id_us": "price_1UUwcILr632EP5z4kKSTSjP0", "price_y_id_us": "price_1UUwcTLr632EP5z4zLghNyFO"},
    "p60": {"price_m_id": "price_1UUwakGH46eYKnWwTqUAhU4F", "price_y_id": "price_1UUwavGH46eYKnWwyAoi81OT", "price_m_id_us": "price_1UUwcGLr632EP5z43hGImJHf", "price_y_id_us": "price_1UUwcRLr632EP5z4hz1v6pNj"},
    "p50": {"price_m_id": "price_1UUwaiGH46eYKnWwRN2sZwtA", "price_y_id": "price_1UUwatGH46eYKnWwDfEM6YiL", "price_m_id_us": "price_1UUwcELr632EP5z413Gk4SQ8", "price_y_id_us": "price_1UUwcPLr632EP5z44C8bYwvE"}
  }'::jsonb,
  updated_at = now()
WHERE stripe_id = 'prod_LQIzwwVu6oMmAz'
  AND price_m_id = 'price_1KkINoGH46eYKnWwwEi97h1B';

-- Maker
UPDATE public.plans SET
  alt_price_m_ids = ARRAY(SELECT DISTINCT unnest(alt_price_m_ids || ARRAY['price_1KjSNPGH46eYKnWwVGG5HI5V', 'price_1UDRGQLr632EP5z4YI3A5cPV'])),
  alt_price_y_ids = ARRAY(SELECT DISTINCT unnest(alt_price_y_ids || ARRAY['price_1NsEbJGH46eYKnWwkOoCqT95', 'price_1UDRGSLr632EP5z45R9qxkU8'])),
  price_m_id = 'price_1UUwaHGH46eYKnWwLIx4RLTA',
  price_y_id = 'price_1UUwaSGH46eYKnWwciOD6FPL',
  price_m_id_us = 'price_1UUwbqLr632EP5z4uNWoVy9j',
  price_y_id_us = 'price_1UUwc0Lr632EP5z4gf5d5SVF',
  updated_at = now()
WHERE stripe_id = 'prod_LQIzozukEwDZDM'
  AND price_m_id = 'price_1KjSNPGH46eYKnWwVGG5HI5V';

-- Team
UPDATE public.plans SET
  alt_price_m_ids = ARRAY(SELECT DISTINCT unnest(alt_price_m_ids || ARRAY['price_1KjSNKGH46eYKnWw32bhz1xX', 'price_1UDRGSLr632EP5z4n0Npf7P1'])),
  alt_price_y_ids = ARRAY(SELECT DISTINCT unnest(alt_price_y_ids || ARRAY['price_1KjSNKGH46eYKnWwx0pSkXE6', 'price_1UDRGSLr632EP5z4jYu6vC42'])),
  price_m_id = 'price_1UUwb1GH46eYKnWwkzg0rWnP',
  price_y_id = 'price_1UUwbDGH46eYKnWwQUX32Fzb',
  price_m_id_us = 'price_1UUwcXLr632EP5z4iew5VirD',
  price_y_id_us = 'price_1UUwciLr632EP5z49j8WcWQk',
  updated_at = now()
WHERE stripe_id = 'prod_LQIzm2NGzayzXi'
  AND price_m_id = 'price_1KjSNKGH46eYKnWw32bhz1xX';

-- Enterprise
UPDATE public.plans SET
  alt_price_m_ids = ARRAY(SELECT DISTINCT unnest(alt_price_m_ids || ARRAY['price_1On9Z7GH46eYKnWws8CBfcHQ', 'price_1UDRGaLr632EP5z4D02F4rLu'])),
  alt_price_y_ids = ARRAY(SELECT DISTINCT unnest(alt_price_y_ids || ARRAY['price_1Sdu3rGH46eYKnWwK9x8sdK4', 'price_1UDRGcLr632EP5z4IxDyZuUK'])),
  price_m_id = 'price_1UUwZuGH46eYKnWwoBF1Wjo9',
  price_y_id = 'price_1UUwa6GH46eYKnWw95XJawmq',
  price_m_id_us = 'price_1UUwbULr632EP5z4Kn9Fe0Zj',
  price_y_id_us = 'price_1UUwbeLr632EP5z4fFSSWXja',
  updated_at = now()
WHERE stripe_id = 'prod_MIy30G5ywsjiUu'
  AND price_m_id = 'price_1On9Z7GH46eYKnWws8CBfcHQ';
