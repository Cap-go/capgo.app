-- Fix billing cycle drift: one source of truth for the current billing cycle.
--
-- stripe_info.subscription_anchor_start/end hold Stripe's
-- current_period_start/current_period_end and are rewritten every period.
-- The old SQL derived the cycle from the day-of-month offset of the stored
-- period start, so a 29-31 anchor drifted after a short month: Stripe period
-- Feb 28 -> Mar 31 stored anchor "day 28", our cycle rolled on Mar 28 (three
-- days before Stripe) and again on Mar 31. Other callers clamped
-- EXTRACT(DAY), and the backend fell back to the calendar month, so the same
-- org could get up to four different cycle keys.
--
-- New rules (billing_cycle_for_anchor):
--   1. If the stored Stripe period is monthly-sized and covers now, return it
--      as-is (this is exactly Stripe's period).
--   2. Otherwise (webhook lag -> stale, yearly plan, future start) roll
--      forward monthly from the ORIGINAL anchor day using fixed-anchor month
--      arithmetic (anchor + n months, never iterating from a clamped date),
--      so day 31 -> Feb 28/29 -> Mar 31 -> Apr 30.
--   3. No Stripe period -> UTC calendar month.
--
-- Every SQL cycle consumer now calls this helper.

-- -------------------------------------------------------------------------
-- billing_cycle_anchor: canonical anchor timestamp (January 2000, UTC) whose
-- day-of-month is the real Stripe billing anchor day and whose time of day is
-- the Stripe anchor time. A monthly Stripe period is clamped on at most one
-- side (Jan 31 -> Feb 28, Feb 28 -> Mar 31), so the anchor day is the larger
-- of the two UTC days-of-month.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_cycle_anchor(
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_period_start IS NULL THEN NULL::timestamptz
    ELSE (
      '2000-01-01 00:00:00'::timestamp
      + pg_catalog.make_interval(
        days => GREATEST(
          EXTRACT(DAY FROM (p_period_start AT TIME ZONE 'UTC'))::integer,
          COALESCE(EXTRACT(DAY FROM (p_period_end AT TIME ZONE 'UTC'))::integer, 1)
        ) - 1
      )
      + (
        (p_period_start AT TIME ZONE 'UTC')
        - pg_catalog.date_trunc('day', p_period_start AT TIME ZONE 'UTC')
      )
    ) AT TIME ZONE 'UTC'
  END;
$$;

ALTER FUNCTION public.billing_cycle_anchor(timestamptz, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.billing_cycle_anchor(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_cycle_anchor(timestamptz, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.billing_cycle_anchor(timestamptz, timestamptz) FROM authenticated;
GRANT ALL ON FUNCTION public.billing_cycle_anchor(timestamptz, timestamptz) TO service_role;

COMMENT ON FUNCTION public.billing_cycle_anchor(timestamptz, timestamptz)
IS 'Internal: canonical Stripe billing anchor (Jan 2000 UTC, real anchor day-of-month and time) derived from a stored Stripe period.';

-- -------------------------------------------------------------------------
-- billing_cycle_for_anchor: the single billing-cycle calculation.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_cycle_for_anchor(
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  cycle_start timestamptz,
  cycle_end timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := COALESCE(p_now, now());
  v_now_utc timestamp;
  v_anchor_utc timestamp;
  v_months integer;
  v_start_utc timestamp;
BEGIN
  -- Stripe's stored period is authoritative while it is current and monthly.
  IF p_period_start IS NOT NULL
    AND p_period_end IS NOT NULL
    AND p_period_start <= v_now
    AND v_now < p_period_end
    AND p_period_end - p_period_start <= INTERVAL '32 days'
  THEN
    cycle_start := p_period_start;
    cycle_end := p_period_end;
    RETURN NEXT;
    RETURN;
  END IF;

  v_now_utc := v_now AT TIME ZONE 'UTC';

  -- No Stripe period: calendar month (UTC).
  IF p_period_start IS NULL THEN
    cycle_start := pg_catalog.date_trunc('month', v_now_utc) AT TIME ZONE 'UTC';
    cycle_end := (pg_catalog.date_trunc('month', v_now_utc) + INTERVAL '1 month') AT TIME ZONE 'UTC';
    RETURN NEXT;
    RETURN;
  END IF;

  -- Stale or yearly period: roll monthly from the fixed original anchor.
  -- timestamp + n months clamps to the month end without losing the anchor
  -- day for later months (Jan 31 + 1 = Feb 29/28, Jan 31 + 2 = Mar 31).
  v_anchor_utc := public.billing_cycle_anchor(p_period_start, p_period_end) AT TIME ZONE 'UTC';
  v_months := (EXTRACT(YEAR FROM v_now_utc)::integer - 2000) * 12
    + EXTRACT(MONTH FROM v_now_utc)::integer - 1;
  v_start_utc := v_anchor_utc + pg_catalog.make_interval(months => v_months);
  IF v_start_utc > v_now_utc THEN
    v_months := v_months - 1;
    v_start_utc := v_anchor_utc + pg_catalog.make_interval(months => v_months);
  END IF;

  cycle_start := v_start_utc AT TIME ZONE 'UTC';
  cycle_end := (v_anchor_utc + pg_catalog.make_interval(months => v_months + 1)) AT TIME ZONE 'UTC';
  RETURN NEXT;
END;
$$;

ALTER FUNCTION public.billing_cycle_for_anchor(timestamptz, timestamptz, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.billing_cycle_for_anchor(timestamptz, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_cycle_for_anchor(timestamptz, timestamptz, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.billing_cycle_for_anchor(timestamptz, timestamptz, timestamptz) FROM authenticated;
GRANT ALL ON FUNCTION public.billing_cycle_for_anchor(timestamptz, timestamptz, timestamptz) TO service_role;

COMMENT ON FUNCTION public.billing_cycle_for_anchor(timestamptz, timestamptz, timestamptz)
IS 'Internal: the single billing cycle calculation. Returns the stored Stripe period while current, otherwise rolls monthly from the original anchor day, otherwise the UTC calendar month.';

-- -------------------------------------------------------------------------
-- get_org_billing_cycle: org lookup wrapper. Always returns exactly one row
-- (calendar month when the org has no Stripe period or does not exist), like
-- get_cycle_info_org always did. No RBAC check inside: internal only.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_org_billing_cycle(orgid uuid)
RETURNS TABLE (
  cycle_start timestamptz,
  cycle_end timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT cycle.cycle_start, cycle.cycle_end
  FROM (SELECT 1) AS single_row
  LEFT JOIN public.orgs o ON o.id = get_org_billing_cycle.orgid
  LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
  CROSS JOIN LATERAL public.billing_cycle_for_anchor(
    si.subscription_anchor_start,
    si.subscription_anchor_end,
    now()
  ) AS cycle
  LIMIT 1;
$$;

ALTER FUNCTION public.get_org_billing_cycle(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_org_billing_cycle(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_org_billing_cycle(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_org_billing_cycle(uuid) FROM authenticated;
GRANT ALL ON FUNCTION public.get_org_billing_cycle(uuid) TO service_role;

COMMENT ON FUNCTION public.get_org_billing_cycle(uuid)
IS 'Internal: current billing cycle for an org (single source of truth). No RBAC; call through get_cycle_info_org from clients.';

-- -------------------------------------------------------------------------
-- get_cycle_info_org: same signature, RBAC check, and grants.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cycle_info_org(orgid uuid)
RETURNS TABLE(subscription_anchor_start timestamp with time zone, subscription_anchor_end timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(
      public.rbac_perm_org_read(),
      get_cycle_info_org.orgid,
      NULL::character varying,
      NULL::bigint
    )
  THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT cycle.cycle_start, cycle.cycle_end
  FROM public.get_org_billing_cycle(get_cycle_info_org.orgid) AS cycle;
END;
$$;

ALTER FUNCTION public.get_cycle_info_org(uuid) OWNER TO postgres;

-- -------------------------------------------------------------------------
-- get_total_metrics(org_id)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."get_total_metrics"("org_id" "uuid") RETURNS TABLE("mau" bigint, "storage" bigint, "bandwidth" bigint, "build_time_unit" bigint, "get" bigint, "fail" bigint, "install" bigint, "uninstall" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_start_date date;
  v_end_date date;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.orgs o
    WHERE o.id = get_total_metrics.org_id
  ) THEN
    RETURN;
  END IF;

  SELECT
    (cycle.cycle_start AT TIME ZONE 'UTC')::date,
    (cycle.cycle_end AT TIME ZONE 'UTC')::date
  INTO v_start_date, v_end_date
  FROM public.get_org_billing_cycle(get_total_metrics.org_id) AS cycle;

  RETURN QUERY
  SELECT
    metrics.mau,
    metrics.storage,
    metrics.bandwidth,
    metrics.build_time_unit,
    metrics.get,
    metrics.fail,
    metrics.install,
    metrics.uninstall
  FROM public.get_total_metrics(org_id, v_start_date, v_end_date) AS metrics;
END;
$$;

ALTER FUNCTION "public"."get_total_metrics"("org_id" "uuid") OWNER TO "postgres";

-- -------------------------------------------------------------------------
-- is_good_plan_v5_org
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_good_plan_v5_org(orgid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product_id text;
  v_start_date date;
  v_end_date date;
  v_plan_name text;
  total_metrics record;
BEGIN
  IF NOT public.is_internal_request_role(public.current_request_role())
    AND NOT public.rbac_check_permission_request(public.rbac_perm_org_read(), orgid, NULL::character varying, NULL::bigint)
  THEN
    RETURN false;
  END IF;

  SELECT si.product_id
  INTO v_product_id
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
  WHERE p.stripe_id = v_product_id;

  IF v_plan_name = 'Enterprise' THEN
    RETURN true;
  END IF;

  SELECT * INTO total_metrics
  FROM public.get_total_metrics(orgid, v_start_date, v_end_date);

  RETURN EXISTS (
    SELECT 1
    FROM public.plans p
    WHERE p.name = v_plan_name
      AND p.mau >= total_metrics.mau
      AND p.bandwidth >= total_metrics.bandwidth
      AND p.storage >= total_metrics.storage
      AND p.build_time_unit >= COALESCE(total_metrics.build_time_unit, 0)
  );
END;
$$;

ALTER FUNCTION public.is_good_plan_v5_org(uuid) OWNER TO postgres;

-- -------------------------------------------------------------------------
-- get_plan_usage_and_fit / get_plan_usage_and_fit_uncached
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."get_plan_usage_and_fit"("orgid" "uuid") RETURNS TABLE("is_good_plan" boolean, "total_percent" double precision, "mau_percent" double precision, "bandwidth_percent" double precision, "storage_percent" double precision, "build_time_percent" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
        p.mau,
        p.bandwidth,
        p.storage,
        p.build_time_unit,
        p.name
    INTO v_plan_mau, v_plan_bandwidth, v_plan_storage, v_plan_build_time, v_plan_name
    FROM public.orgs o
    LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
    LEFT JOIN public.plans p ON si.product_id = p.stripe_id
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

    IF v_plan_name = 'Enterprise' THEN
        v_is_good_plan := TRUE;
    ELSIF v_plan_name IS NULL THEN
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
$$;

ALTER FUNCTION "public"."get_plan_usage_and_fit"("orgid" "uuid") OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_plan_usage_and_fit_uncached"("orgid" "uuid") RETURNS TABLE("is_good_plan" boolean, "total_percent" double precision, "mau_percent" double precision, "bandwidth_percent" double precision, "storage_percent" double precision, "build_time_percent" double precision)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
        p.mau,
        p.bandwidth,
        p.storage,
        p.build_time_unit,
        p.name
    INTO v_plan_mau, v_plan_bandwidth, v_plan_storage, v_plan_build_time, v_plan_name
    FROM public.orgs o
    LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
    LEFT JOIN public.plans p ON si.product_id = p.stripe_id
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

    IF v_plan_name = 'Enterprise' THEN
        v_is_good_plan := TRUE;
    ELSIF v_plan_name IS NULL THEN
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
$$;

ALTER FUNCTION "public"."get_plan_usage_and_fit_uncached"("orgid" "uuid") OWNER TO "postgres";

-- -------------------------------------------------------------------------
-- get_plan_usage_percent_detailed(orgid)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_plan_usage_percent_detailed(orgid uuid)
RETURNS TABLE(total_percent double precision, mau_percent double precision, bandwidth_percent double precision, storage_percent double precision, build_time_percent double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
    p.mau,
    p.bandwidth,
    p.storage,
    p.build_time_unit
  INTO v_plan_mau, v_plan_bandwidth, v_plan_storage, v_plan_build_time
  FROM public.orgs o
  LEFT JOIN public.stripe_info si ON o.customer_id = si.customer_id
  LEFT JOIN public.plans p ON si.product_id = p.stripe_id
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
$$;

ALTER FUNCTION public.get_plan_usage_percent_detailed(uuid) OWNER TO postgres;

-- -------------------------------------------------------------------------
-- process_billing_period_stats_email: detect the anniversary from the real
-- Stripe anchor day instead of the (clamped, rewritten) period start day, so
-- the completed-cycle email fires on the same day the cycle helper rolls.
-- billing_period_completed_cycle(anchor, as_of) keeps its signature and
-- math: it already clamps from a fixed anchor day.
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_billing_period_stats_email()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  org_record RECORD;
  v_cycle RECORD;
BEGIN
  FOR org_record IN (
    SELECT
      o.id AS org_id,
      o.management_email,
      public.billing_cycle_anchor(
        si.subscription_anchor_start,
        si.subscription_anchor_end
      ) AS billing_anchor
    FROM public.orgs o
    JOIN public.stripe_info si ON o.customer_id = si.customer_id
    WHERE si.status = 'succeeded'
      AND o.management_email IS NOT NULL
  )
  LOOP
    SELECT *
    INTO v_cycle
    FROM public.billing_period_completed_cycle(
      org_record.billing_anchor,
      (now() AT TIME ZONE 'UTC')::date
    );

    IF v_cycle.is_anniversary THEN
      PERFORM pgmq.send(
        'cron_email',
        jsonb_build_object(
          'function_name', 'cron_email',
          'function_type', 'cloudflare',
          'payload', jsonb_build_object(
            'email', org_record.management_email,
            'orgId', org_record.org_id,
            'type', 'billing_period_stats',
            'cycleStart', v_cycle.cycle_start,
            'cycleEnd', v_cycle.cycle_end
          )
        )
      );
    END IF;
  END LOOP;
END;
$$;

ALTER FUNCTION public.process_billing_period_stats_email() OWNER TO postgres;

-- -------------------------------------------------------------------------
-- get_orgs_v7: subscription_start/end now come from the same helper
-- (latest definition: 20260927125611_migrate_org_stats_refresh_reads.sql;
-- only the billing_cycles CTE and subscription_end changed).
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."get_orgs_v7"("userid" uuid)
RETURNS TABLE("gid" uuid, "created_by" uuid, "created_at" timestamp with time zone,
  "logo" text, "website" text, "name" text, "role" character varying, "is_invite" boolean,
  "paying" boolean, "trial_left" integer, "can_use_more" boolean, "is_canceled" boolean,
  "app_count" bigint, "subscription_start" timestamp with time zone,
  "subscription_end" timestamp with time zone, "management_email" text, "is_yearly" boolean,
  "stats_updated_at" timestamp without time zone,
  "stats_refresh_requested_at" timestamp without time zone,
  "next_stats_update_at" timestamp with time zone, "credit_available" numeric,
  "credit_total" numeric, "credit_next_expiration" timestamp with time zone,
  "enforcing_2fa" boolean, "2fa_has_access" boolean, "enforce_hashed_api_keys" boolean,
  "password_policy_config" jsonb, "password_has_access" boolean,
  "require_apikey_expiration" boolean, "max_apikey_expiration_days" integer,
  "enforce_encrypted_bundles" boolean, "required_encryption_key" character varying)
LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" TO '' AS $$
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
      ELSE COALESCE(si.price_id = p.price_y_id, false)
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
  LEFT JOIN public.plans p ON si.product_id = p.stripe_id
  LEFT JOIN app_counts ac ON ac.owner_org = o.id
  LEFT JOIN public.usage_credit_balances ucb ON ucb.org_id = o.id
  LEFT JOIN paying_orgs_ordered poo ON poo.id = o.id
  LEFT JOIN billing_cycles bc ON bc.org_id = o.id
  LEFT JOIN public.org_stats_refresh_state refresh_state ON refresh_state.org_id = o.id;
END;
$$;
ALTER FUNCTION "public"."get_orgs_v7"(uuid) OWNER TO "postgres";
COMMENT ON FUNCTION "public"."get_orgs_v7"(uuid)
IS 'Org membership list for a user. Billing/plan/credit fields are null/false when the user lacks org.read_billing for that org.';
