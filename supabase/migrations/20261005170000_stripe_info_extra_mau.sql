-- Enterprise MAU slider: Enterprise orgs can buy MAU above the plan
-- allowance. It is billed as an "extra MAU" item on the Stripe subscription
-- and synced here by the Stripe webhook. It is part of the plan quota, not
-- credits: the org's MAU allowance is plans.mau + stripe_info.extra_mau.

ALTER TABLE public.stripe_info
ADD COLUMN IF NOT EXISTS extra_mau bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.stripe_info.extra_mau IS
'MAU bought on top of the plan allowance (Enterprise extra MAU subscription item). 0 when none.';

-- Usage percentages and plan fit count the extra MAU in the allowance.
-- Enterprise is no longer always a "good plan": above its allowance (plan +
-- extra MAU) it goes through the normal path, credits first, then the
-- exceeded flags block it and the org is notified.

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
        p.mau + COALESCE(si.extra_mau, 0),
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
        p.mau + COALESCE(si.extra_mau, 0),
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
$$;

ALTER FUNCTION "public"."get_plan_usage_and_fit_uncached"("orgid" "uuid") OWNER TO "postgres";

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
    p.mau + COALESCE(si.extra_mau, 0),
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

CREATE OR REPLACE FUNCTION public.get_plan_usage_percent_detailed(orgid uuid, cycle_start date, cycle_end date)
RETURNS TABLE(total_percent double precision, mau_percent double precision, bandwidth_percent double precision, storage_percent double precision, build_time_percent double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
  JOIN public.plans p ON si.product_id = p.stripe_id
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
$$;

ALTER FUNCTION public.get_plan_usage_percent_detailed(uuid, date, date) OWNER TO postgres;

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
  WHERE p.stripe_id = v_product_id;

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
$$;

ALTER FUNCTION public.is_good_plan_v5_org(uuid) OWNER TO postgres;
