-- Plan-based native build queue priority (base priority; builder applies aging).

ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS native_build_queue_priority integer NOT NULL DEFAULT 10;

ALTER TABLE public.plans
  DROP CONSTRAINT IF EXISTS plans_native_build_queue_priority_positive;

ALTER TABLE public.plans
  ADD CONSTRAINT plans_native_build_queue_priority_positive
  CHECK (native_build_queue_priority > 0);

COMMENT ON COLUMN public.plans.native_build_queue_priority IS
  'Base native build queue priority for this plan. Higher values start sooner when the builder queue is busy. Enterprise and custom plans should use the highest tier.';

UPDATE public.plans
SET native_build_queue_priority = CASE name
  WHEN 'Solo' THEN 10
  WHEN 'Maker' THEN 20
  WHEN 'Team' THEN 40
  WHEN 'Enterprise' THEN 100
  ELSE native_build_queue_priority
END
WHERE name IN ('Solo', 'Maker', 'Team', 'Enterprise');

ALTER TABLE public.build_requests
  ADD COLUMN IF NOT EXISTS queue_priority integer;

COMMENT ON COLUMN public.build_requests.queue_priority IS
  'Plan base queue priority captured when the build job was created. Used for support and status APIs; the builder stores its own copy on the job.';

-- Aging constants (documented contract shared with capgo_builder).
CREATE OR REPLACE FUNCTION public.native_build_queue_aging_interval_seconds()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 300;
$$;

ALTER FUNCTION public.native_build_queue_aging_interval_seconds() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.native_build_queue_aging_interval_seconds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.native_build_queue_aging_interval_seconds() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.native_build_queue_max_aging_bonus()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 90;
$$;

ALTER FUNCTION public.native_build_queue_max_aging_bonus() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.native_build_queue_max_aging_bonus() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.native_build_queue_max_aging_bonus() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.native_build_queue_aging_points_per_interval()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 1;
$$;

ALTER FUNCTION public.native_build_queue_aging_points_per_interval() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.native_build_queue_aging_points_per_interval() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.native_build_queue_aging_points_per_interval() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.native_build_queue_aging_bonus(p_enqueued_at timestamp with time zone)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT LEAST(
    public.native_build_queue_max_aging_bonus(),
    GREATEST(
      0,
      (
        FLOOR(
          EXTRACT(EPOCH FROM (pg_catalog.now() - p_enqueued_at))
          / public.native_build_queue_aging_interval_seconds()::numeric
        )
      )::integer * public.native_build_queue_aging_points_per_interval()
    )
  );
$$;

ALTER FUNCTION public.native_build_queue_aging_bonus(timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.native_build_queue_aging_bonus(timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.native_build_queue_aging_bonus(timestamp with time zone) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.native_build_effective_queue_priority(
  p_base_priority integer,
  p_enqueued_at timestamp with time zone
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_base_priority + public.native_build_queue_aging_bonus(p_enqueued_at);
$$;

ALTER FUNCTION public.native_build_effective_queue_priority(integer, timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.native_build_effective_queue_priority(integer, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.native_build_effective_queue_priority(integer, timestamp with time zone) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.native_build_queue_tier_from_priority(p_priority integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_priority >= 100 THEN 'highest'
    WHEN p_priority >= 40 THEN 'high'
    WHEN p_priority >= 20 THEN 'elevated'
    ELSE 'standard'
  END;
$$;

ALTER FUNCTION public.native_build_queue_tier_from_priority(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.native_build_queue_tier_from_priority(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.native_build_queue_tier_from_priority(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_org_native_build_queue_priority(p_org_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(current_plan.native_build_queue_priority, solo_plan.native_build_queue_priority, 10)
  FROM public.orgs AS o
  LEFT JOIN public.stripe_info AS si ON o.customer_id = si.customer_id
  LEFT JOIN public.plans AS current_plan ON si.product_id = current_plan.stripe_id
  LEFT JOIN public.plans AS solo_plan ON solo_plan.name = 'Solo'
  WHERE o.id = p_org_id
  LIMIT 1;
$$;

ALTER FUNCTION public.get_org_native_build_queue_priority(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_org_native_build_queue_priority(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_org_native_build_queue_priority(uuid) TO service_role;

DROP FUNCTION IF EXISTS public.get_current_plan_max_org(uuid);

CREATE OR REPLACE FUNCTION public.get_current_plan_max_org(orgid uuid)
RETURNS TABLE(
  mau bigint,
  bandwidth bigint,
  storage bigint,
  build_time_unit bigint,
  native_build_concurrency integer,
  native_build_queue_priority integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
    p.native_build_concurrency,
    p.native_build_queue_priority
  FROM public.orgs o
  JOIN public.stripe_info si ON o.customer_id = si.customer_id
  JOIN public.plans p ON si.product_id = p.stripe_id
  WHERE o.id = orgid;
END;
$$;

ALTER FUNCTION public.get_current_plan_max_org(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_current_plan_max_org(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_current_plan_max_org(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_current_plan_max_org(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_plan_max_org(uuid) TO service_role;
