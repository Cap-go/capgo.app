-- US Stripe orgs store US product/price ids in stripe_info. Plan lookups must
-- match either account's ids (product and price ids are unique across accounts).

CREATE OR REPLACE FUNCTION public.count_all_plans_v2()
 RETURNS TABLE(plan_name character varying, count bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RETURN QUERY
  WITH ActiveSubscriptions AS (
    SELECT DISTINCT ON (si.customer_id)
      p.name AS product_name,
      si.customer_id
    FROM public.stripe_info si
    INNER JOIN public.plans p ON si.product_id IN (p.stripe_id, p.stripe_id_us)
    WHERE si.status = 'succeeded'
    ORDER BY si.customer_id, si.created_at DESC
  ),
  TrialUsers AS (
    SELECT DISTINCT ON (si.customer_id)
      'Trial'::character varying AS product_name,
      si.customer_id
    FROM public.stripe_info si
    WHERE si.trial_at > NOW()
      AND si.status IS DISTINCT FROM 'succeeded'
      AND NOT EXISTS (
        SELECT 1
        FROM ActiveSubscriptions a
        WHERE a.customer_id = si.customer_id
      )
    ORDER BY si.customer_id, si.created_at DESC
  )
  SELECT product_name, COUNT(*) AS count
  FROM (
    SELECT product_name FROM ActiveSubscriptions
    UNION ALL
    SELECT product_name FROM TrialUsers
  ) combined
  GROUP BY product_name;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_current_plan_max_org(orgid uuid)
 RETURNS TABLE(mau bigint, bandwidth bigint, storage bigint, build_time_unit bigint, native_build_concurrency integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_org_read_billing(),
      get_current_plan_max_org.orgid,
      NULL::character varying,
      NULL::bigint
    )
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.mau,
    p.bandwidth,
    p.storage,
    p.build_time_unit,
    p.native_build_concurrency
  FROM public.orgs o
  JOIN public.stripe_info si ON o.customer_id = si.customer_id
  JOIN public.plans p ON si.product_id IN (p.stripe_id, p.stripe_id_us)
  WHERE o.id = orgid;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_current_plan_name_org(orgid uuid)
 RETURNS character varying
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_org_read_billing(),
      get_current_plan_name_org.orgid,
      NULL::character varying,
      NULL::bigint
    )
  THEN
    RETURN NULL;
  END IF;

  RETURN (
    SELECT p.name
    FROM public.orgs o
    JOIN public.stripe_info si ON o.customer_id = si.customer_id
    JOIN public.plans p ON si.product_id IN (p.stripe_id, p.stripe_id_us)
    WHERE o.id = orgid
    LIMIT 1
  );
END;
$function$

;

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
    COUNT(CASE WHEN s.price_id IN (SELECT price_y_id FROM public.plans WHERE price_y_id IS NOT NULL UNION ALL SELECT price_y_id_us FROM public.plans WHERE price_y_id_us IS NOT NULL) THEN 1 END) AS yearly,
    COUNT(CASE WHEN s.price_id IN (SELECT price_m_id FROM public.plans WHERE price_m_id IS NOT NULL UNION ALL SELECT price_m_id_us FROM public.plans WHERE price_m_id_us IS NOT NULL) THEN 1 END) AS monthly,
    COUNT(*) AS total
  FROM ActiveSubscriptions s;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_plan_usage_and_fit(orgid uuid)
 RETURNS TABLE(is_good_plan boolean, total_percent double precision, mau_percent double precision, bandwidth_percent double precision, storage_percent double precision, build_time_percent double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_start_date date;
    v_end_date date;
    v_plan_mau bigint;
    v_plan_bandwidth bigint;
    v_plan_storage bigint;
    v_plan_build_time bigint;
    v_plan_name text;
    total_stats RECORD;
    percent_mau double precision;
    percent_bandwidth double precision;
    percent_storage double precision;
    percent_build_time double precision;
    v_is_good_plan boolean;
BEGIN
    SELECT
        p.mau + COALESCE(si.extra_mau, 0),
        p.bandwidth,
        p.storage,
        p.build_time_unit,
        p.name
    INTO v_plan_mau, v_plan_bandwidth, v_plan_storage, v_plan_build_time, v_plan_name
    FROM public.orgs o
    LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
    LEFT JOIN public.plans p ON si.product_id IN (p.stripe_id, p.stripe_id_us)
    WHERE o.id = orgid;

    SELECT
        (cycle.cycle_start AT TIME ZONE 'UTC')::date,
        (cycle.cycle_end AT TIME ZONE 'UTC')::date
    INTO v_start_date, v_end_date
    FROM public.get_org_billing_cycle(orgid) AS cycle;

    SELECT * INTO total_stats
    FROM public.get_total_metrics(orgid, v_start_date, v_end_date);

    percent_mau := public.convert_number_to_percent(total_stats.mau, v_plan_mau);
    percent_bandwidth := public.convert_number_to_percent(total_stats.bandwidth, v_plan_bandwidth);
    percent_storage := public.convert_number_to_percent(total_stats.storage, v_plan_storage);
    percent_build_time := public.convert_number_to_percent(total_stats.build_time_unit, v_plan_build_time);

    IF v_plan_name IS NULL THEN
        v_is_good_plan := FALSE;
    ELSE
        v_is_good_plan := v_plan_mau >= total_stats.mau
            AND v_plan_bandwidth >= total_stats.bandwidth
            AND v_plan_storage >= total_stats.storage
            AND v_plan_build_time >= COALESCE(total_stats.build_time_unit, 0);
    END IF;

    RETURN QUERY SELECT
        v_is_good_plan,
        GREATEST(percent_mau, percent_bandwidth, percent_storage, percent_build_time),
        percent_mau,
        percent_bandwidth,
        percent_storage,
        percent_build_time;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_plan_usage_and_fit_uncached(orgid uuid)
 RETURNS TABLE(is_good_plan boolean, total_percent double precision, mau_percent double precision, bandwidth_percent double precision, storage_percent double precision, build_time_percent double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_start_date date;
    v_end_date date;
    v_plan_mau bigint;
    v_plan_bandwidth bigint;
    v_plan_storage bigint;
    v_plan_build_time bigint;
    v_plan_name text;
    total_stats RECORD;
    percent_mau double precision;
    percent_bandwidth double precision;
    percent_storage double precision;
    percent_build_time double precision;
    v_is_good_plan boolean;
BEGIN
    SELECT
        p.mau + COALESCE(si.extra_mau, 0),
        p.bandwidth,
        p.storage,
        p.build_time_unit,
        p.name
    INTO v_plan_mau, v_plan_bandwidth, v_plan_storage, v_plan_build_time, v_plan_name
    FROM public.orgs o
    LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
    LEFT JOIN public.plans p ON si.product_id IN (p.stripe_id, p.stripe_id_us)
    WHERE o.id = orgid;

    SELECT
        (cycle.cycle_start AT TIME ZONE 'UTC')::date,
        (cycle.cycle_end AT TIME ZONE 'UTC')::date
    INTO v_start_date, v_end_date
    FROM public.get_org_billing_cycle(orgid) AS cycle;

    SELECT * INTO total_stats
    FROM public.seed_org_metrics_cache(orgid, v_start_date, v_end_date);

    percent_mau := public.convert_number_to_percent(total_stats.mau, v_plan_mau);
    percent_bandwidth := public.convert_number_to_percent(total_stats.bandwidth, v_plan_bandwidth);
    percent_storage := public.convert_number_to_percent(total_stats.storage, v_plan_storage);
    percent_build_time := public.convert_number_to_percent(total_stats.build_time_unit, v_plan_build_time);

    IF v_plan_name IS NULL THEN
        v_is_good_plan := FALSE;
    ELSE
        v_is_good_plan := v_plan_mau >= total_stats.mau
            AND v_plan_bandwidth >= total_stats.bandwidth
            AND v_plan_storage >= total_stats.storage
            AND v_plan_build_time >= COALESCE(total_stats.build_time_unit, 0);
    END IF;

    RETURN QUERY SELECT
        v_is_good_plan,
        GREATEST(percent_mau, percent_bandwidth, percent_storage, percent_build_time),
        percent_mau,
        percent_bandwidth,
        percent_storage,
        percent_build_time;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_plan_usage_percent_detailed(orgid uuid)
 RETURNS TABLE(total_percent double precision, mau_percent double precision, bandwidth_percent double precision, storage_percent double precision, build_time_percent double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_start_date date;
  v_end_date date;
  v_plan_mau bigint;
  v_plan_bandwidth bigint;
  v_plan_storage bigint;
  v_plan_build_time bigint;
  total_stats record;
  percent_mau double precision;
  percent_bandwidth double precision;
  percent_storage double precision;
  percent_build_time double precision;
  v_tx_read_only boolean := current_setting('transaction_read_only') = 'on';
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_org_read_billing(),
      get_plan_usage_percent_detailed.orgid,
      NULL::character varying,
      NULL::bigint
    )
  THEN
    RETURN;
  END IF;

  SELECT
    p.mau + COALESCE(si.extra_mau, 0),
    p.bandwidth,
    p.storage,
    p.build_time_unit
  INTO v_plan_mau, v_plan_bandwidth, v_plan_storage, v_plan_build_time
  FROM public.orgs o
  LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
  LEFT JOIN public.plans p ON si.product_id IN (p.stripe_id, p.stripe_id_us)
  WHERE o.id = orgid;

  SELECT
    (cycle.cycle_start AT TIME ZONE 'UTC')::date,
    (cycle.cycle_end AT TIME ZONE 'UTC')::date
  INTO v_start_date, v_end_date
  FROM public.get_org_billing_cycle(orgid) AS cycle;

  IF v_tx_read_only THEN
    SELECT * INTO total_stats
    FROM public.calculate_org_metrics_cache_entry(orgid, v_start_date, v_end_date);
  ELSE
    SELECT * INTO total_stats
    FROM public.get_total_metrics(orgid, v_start_date, v_end_date);
  END IF;

  percent_mau := public.convert_number_to_percent(total_stats.mau, v_plan_mau);
  percent_bandwidth := public.convert_number_to_percent(total_stats.bandwidth, v_plan_bandwidth);
  percent_storage := public.convert_number_to_percent(total_stats.storage, v_plan_storage);
  percent_build_time := public.convert_number_to_percent(total_stats.build_time_unit, v_plan_build_time);

  RETURN QUERY
  SELECT
    GREATEST(percent_mau, percent_bandwidth, percent_storage, percent_build_time),
    percent_mau,
    percent_bandwidth,
    percent_storage,
    percent_build_time;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_plan_usage_percent_detailed(orgid uuid, cycle_start date, cycle_end date)
 RETURNS TABLE(total_percent double precision, mau_percent double precision, bandwidth_percent double precision, storage_percent double precision, build_time_percent double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_plan_mau bigint;
  v_plan_bandwidth bigint;
  v_plan_storage bigint;
  v_plan_build_time bigint;
  total_stats record;
  percent_mau double precision;
  percent_bandwidth double precision;
  percent_storage double precision;
  percent_build_time double precision;
  v_tx_read_only boolean := current_setting('transaction_read_only') = 'on';
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_org_read_billing(),
      get_plan_usage_percent_detailed.orgid,
      NULL::character varying,
      NULL::bigint
    )
  THEN
    RETURN;
  END IF;

  SELECT p.mau + COALESCE(si.extra_mau, 0), p.bandwidth, p.storage, p.build_time_unit
  INTO v_plan_mau, v_plan_bandwidth, v_plan_storage, v_plan_build_time
  FROM public.orgs o
  JOIN public.stripe_info si ON o.customer_id = si.customer_id
  JOIN public.plans p ON si.product_id IN (p.stripe_id, p.stripe_id_us)
  WHERE o.id = orgid;

  IF v_tx_read_only THEN
    SELECT * INTO total_stats
    FROM public.calculate_org_metrics_cache_entry(orgid, cycle_start, cycle_end);
  ELSE
    SELECT * INTO total_stats
    FROM public.get_total_metrics(orgid, cycle_start, cycle_end);
  END IF;

  percent_mau := public.convert_number_to_percent(total_stats.mau, v_plan_mau);
  percent_bandwidth := public.convert_number_to_percent(total_stats.bandwidth, v_plan_bandwidth);
  percent_storage := public.convert_number_to_percent(total_stats.storage, v_plan_storage);
  percent_build_time := public.convert_number_to_percent(total_stats.build_time_unit, v_plan_build_time);

  RETURN QUERY
  SELECT
    GREATEST(percent_mau, percent_bandwidth, percent_storage, percent_build_time),
    percent_mau,
    percent_bandwidth,
    percent_storage,
    percent_build_time;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.is_good_plan_v5_org(orgid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_product_id text;
  v_start_date date;
  v_end_date date;
  v_plan_name text;
  v_extra_mau bigint;
  total_metrics record;
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(public.rbac_perm_org_read(), orgid, NULL::character varying, NULL::bigint)
  THEN
    RETURN false;
  END IF;

  SELECT si.product_id, COALESCE(si.extra_mau, 0)
  INTO v_product_id, v_extra_mau
  FROM public.orgs o
  LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
  WHERE o.id = orgid;

  SELECT
    (cycle.cycle_start AT TIME ZONE 'UTC')::date,
    (cycle.cycle_end AT TIME ZONE 'UTC')::date
  INTO v_start_date, v_end_date
  FROM public.get_org_billing_cycle(orgid) AS cycle;

  SELECT p.name INTO v_plan_name
  FROM public.plans p
  WHERE v_product_id IN (p.stripe_id, p.stripe_id_us);

  SELECT * INTO total_metrics
  FROM public.get_total_metrics(orgid, v_start_date, v_end_date);

  RETURN EXISTS (
    SELECT 1
    FROM public.plans p
    WHERE p.name = v_plan_name
      AND p.mau + v_extra_mau >= total_metrics.mau
      AND p.bandwidth >= total_metrics.bandwidth
      AND p.storage >= total_metrics.storage
      AND p.build_time_unit >= COALESCE(total_metrics.build_time_unit, 0)
  );
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
      WHEN si.price_id IN (p.price_y_id, p.price_y_id_us) THEN true
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
      ELSE COALESCE(si.price_id IN (p.price_y_id, p.price_y_id_us), false)
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

