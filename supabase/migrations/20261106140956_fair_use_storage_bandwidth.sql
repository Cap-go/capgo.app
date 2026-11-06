-- Storage and bandwidth move to fair use on paid plans.
--
-- Paid plans no longer have a storage or bandwidth limit: plan fit, plan
-- recommendations and total plan usage only count MAU and build time.
-- plans.storage / plans.bandwidth stay as the internal fair-use reference, so
-- storage_percent / bandwidth_percent keep reporting usage against it for
-- monitoring, but they no longer decide is_good_plan or total_percent.
-- Credit-only orgs (no plan) still pay storage and bandwidth with credits; that
-- path lives in the backend and does not read these functions.

CREATE OR REPLACE FUNCTION public.find_best_plan_v3(
  mau bigint,
  bandwidth double precision,
  storage double precision,
  build_time_unit bigint DEFAULT 0
) RETURNS character varying
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  -- bandwidth and storage stay in the signature for existing callers but are
  -- fair use: they never push an org to a bigger plan.
  RETURN (
    SELECT plans.name
    FROM public.plans
    WHERE (
      plans.mau >= find_best_plan_v3.mau
      AND plans.build_time_unit >= find_best_plan_v3.build_time_unit
    ) OR plans.name = 'Enterprise'
    ORDER BY plans.mau
    LIMIT 1
  );
END;
$$;

COMMENT ON FUNCTION public.find_best_plan_v3(bigint, double precision, double precision, bigint) IS
'Smallest plan that fits the given MAU and build time. bandwidth and storage are accepted for compatibility and ignored: they are fair use on paid plans.';

CREATE OR REPLACE FUNCTION public.find_fit_plan_v3(
  mau bigint,
  bandwidth bigint,
  storage bigint,
  build_time_unit bigint DEFAULT 0
) RETURNS TABLE (name character varying)
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
BEGIN
  -- bandwidth and storage are fair use: only MAU and build time decide fit.
  RETURN QUERY (
    SELECT plans.name
    FROM public.plans
    WHERE (
      plans.mau >= find_fit_plan_v3.mau
      AND plans.build_time_unit >= find_fit_plan_v3.build_time_unit
    ) OR plans.name = 'Enterprise'
    ORDER BY plans.mau
  );
END;
$$;

COMMENT ON FUNCTION public.find_fit_plan_v3(bigint, bigint, bigint, bigint) IS
'Plans that fit the given MAU and build time. bandwidth and storage are accepted for compatibility and ignored: they are fair use on paid plans.';

CREATE OR REPLACE FUNCTION public.get_plan_usage_and_fit(orgid uuid)
RETURNS TABLE (
  is_good_plan boolean,
  total_percent double precision,
  mau_percent double precision,
  bandwidth_percent double precision,
  storage_percent double precision,
  build_time_percent double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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
    -- Fair-use reference only: reported, never part of the plan fit.
    percent_bandwidth := public.convert_number_to_percent(total_stats.bandwidth, v_plan_bandwidth);
    percent_storage := public.convert_number_to_percent(total_stats.storage, v_plan_storage);
    percent_build_time := public.convert_number_to_percent(total_stats.build_time_unit, v_plan_build_time);

    IF v_plan_name IS NULL THEN
        v_is_good_plan := FALSE;
    ELSE
        v_is_good_plan := v_plan_mau >= total_stats.mau
            AND v_plan_build_time >= COALESCE(total_stats.build_time_unit, 0);
    END IF;

    RETURN QUERY SELECT
        v_is_good_plan,
        GREATEST(percent_mau, percent_build_time),
        percent_mau,
        percent_bandwidth,
        percent_storage,
        percent_build_time;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_plan_usage_and_fit_uncached(orgid uuid)
RETURNS TABLE (
  is_good_plan boolean,
  total_percent double precision,
  mau_percent double precision,
  bandwidth_percent double precision,
  storage_percent double precision,
  build_time_percent double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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
    -- Fair-use reference only: reported, never part of the plan fit.
    percent_bandwidth := public.convert_number_to_percent(total_stats.bandwidth, v_plan_bandwidth);
    percent_storage := public.convert_number_to_percent(total_stats.storage, v_plan_storage);
    percent_build_time := public.convert_number_to_percent(total_stats.build_time_unit, v_plan_build_time);

    IF v_plan_name IS NULL THEN
        v_is_good_plan := FALSE;
    ELSE
        v_is_good_plan := v_plan_mau >= total_stats.mau
            AND v_plan_build_time >= COALESCE(total_stats.build_time_unit, 0);
    END IF;

    RETURN QUERY SELECT
        v_is_good_plan,
        GREATEST(percent_mau, percent_build_time),
        percent_mau,
        percent_bandwidth,
        percent_storage,
        percent_build_time;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_plan_usage_percent_detailed(orgid uuid)
RETURNS TABLE (
  total_percent double precision,
  mau_percent double precision,
  bandwidth_percent double precision,
  storage_percent double precision,
  build_time_percent double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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
  -- Fair-use reference only: reported, never part of total_percent.
  percent_bandwidth := public.convert_number_to_percent(total_stats.bandwidth, v_plan_bandwidth);
  percent_storage := public.convert_number_to_percent(total_stats.storage, v_plan_storage);
  percent_build_time := public.convert_number_to_percent(total_stats.build_time_unit, v_plan_build_time);

  RETURN QUERY
  SELECT
    GREATEST(percent_mau, percent_build_time),
    percent_mau,
    percent_bandwidth,
    percent_storage,
    percent_build_time;
END;
$$;

COMMENT ON FUNCTION public.get_plan_usage_percent_detailed(uuid) IS
'Return current-cycle plan usage percentages for the supplied organization while respecting read permissions and delegating to cached metrics when running in read-only transactions. total_percent covers MAU and build time; storage and bandwidth are fair use and their percentages are against the internal fair-use reference.';

CREATE OR REPLACE FUNCTION public.get_plan_usage_percent_detailed(
  orgid uuid,
  cycle_start date,
  cycle_end date
) RETURNS TABLE (
  total_percent double precision,
  mau_percent double precision,
  bandwidth_percent double precision,
  storage_percent double precision,
  build_time_percent double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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
  -- Fair-use reference only: reported, never part of total_percent.
  percent_bandwidth := public.convert_number_to_percent(total_stats.bandwidth, v_plan_bandwidth);
  percent_storage := public.convert_number_to_percent(total_stats.storage, v_plan_storage);
  percent_build_time := public.convert_number_to_percent(total_stats.build_time_unit, v_plan_build_time);

  RETURN QUERY
  SELECT
    GREATEST(percent_mau, percent_build_time),
    percent_mau,
    percent_bandwidth,
    percent_storage,
    percent_build_time;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_good_plan_v5_org(orgid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
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
  WHERE v_product_id IN (p.stripe_id, p.stripe_id_us);

  SELECT * INTO total_metrics
  FROM public.get_total_metrics(orgid, v_start_date, v_end_date);

  -- Storage and bandwidth are fair use: only MAU and build time decide fit.
  RETURN EXISTS (
    SELECT 1
    FROM public.plans p
    WHERE p.name = v_plan_name
      AND p.mau + v_extra_mau >= total_metrics.mau
      AND p.build_time_unit >= COALESCE(total_metrics.build_time_unit, 0)
  );
END;
$$;

-- Unblock paid orgs flagged under the old storage/bandwidth limits. The plan
-- cron no longer sets these flags for orgs on a plan. Credit-only orgs keep
-- theirs: they still pay storage and bandwidth with credits.
UPDATE public.stripe_info AS si
SET
  storage_exceeded = false,
  bandwidth_exceeded = false
WHERE si.status = 'succeeded'
  AND (si.storage_exceeded OR si.bandwidth_exceeded)
  AND EXISTS (
    SELECT 1
    FROM public.plans AS p
    WHERE si.product_id IN (p.stripe_id, p.stripe_id_us)
  );
