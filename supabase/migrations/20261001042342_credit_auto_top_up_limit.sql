-- Monthly spending cap for credit auto top-up. 0 means no limit.

ALTER TABLE "public"."orgs"
  ADD COLUMN IF NOT EXISTS "auto_top_up_monthly_limit" numeric(18,6) DEFAULT 0 NOT NULL;

ALTER TABLE "public"."orgs"
  DROP CONSTRAINT IF EXISTS "orgs_auto_top_up_monthly_limit_valid";

ALTER TABLE "public"."orgs"
  ADD CONSTRAINT "orgs_auto_top_up_monthly_limit_valid" CHECK (("auto_top_up_monthly_limit" >= (0)::numeric AND "auto_top_up_monthly_limit" = trunc("auto_top_up_monthly_limit") AND "auto_top_up_monthly_limit" < 'Infinity'::numeric)) NOT VALID;

COMMENT ON COLUMN "public"."orgs"."auto_top_up_monthly_limit" IS 'Maximum credits (USD, 1:1) that auto top-up may buy per calendar month (UTC). 0 means no limit. Auto top-up stops once the next charge would exceed it.';

-- Execution profile (service_role only):
-- Called from try_claim_credit_auto_top_up (plan-check cron, once per org per run) and from
-- the /private/credits/auto-top-up settings endpoint. Reads public.usage_credit_grants by
-- org_id equality (idx_usage_credit_grants_org_expires prefix), filtered to auto top-up
-- grants of the current month. An org holds a handful of grants, so the scan stays tiny.
CREATE OR REPLACE FUNCTION public.get_credit_auto_top_up_month_total(p_org_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(SUM(grants.credits_total), 0)::numeric
  FROM public.usage_credit_grants AS grants
  WHERE grants.org_id = p_org_id
    AND grants.source = 'stripe_top_up'
    AND grants.source_ref ->> 'kind' = 'credit_auto_top_up'
    AND grants.granted_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
$$;

ALTER FUNCTION public.get_credit_auto_top_up_month_total(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_credit_auto_top_up_month_total(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_credit_auto_top_up_month_total(uuid) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.get_credit_auto_top_up_month_total(uuid) TO service_role;

-- Execution profile (service_role RPC from plan-check cron, once per org per run):
-- Locks public.orgs by primary key (id) FOR UPDATE, then reads public.usage_credit_balances
-- by org_id and, when a monthly limit is set, the org's auto top-up grants for this month
-- through get_credit_auto_top_up_month_total. Cardinality is 1 org row, 0-1 balance row and
-- a few grant rows. Not used by RLS.
CREATE OR REPLACE FUNCTION public.try_claim_credit_auto_top_up(p_org_id uuid)
RETURNS TABLE(
  claimed boolean,
  auto_top_up_enabled boolean,
  auto_top_up_threshold numeric,
  customer_id text,
  available_credits numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org public.orgs%ROWTYPE;
  v_available numeric := 0;
BEGIN
  IF p_org_id IS NULL THEN
    RETURN QUERY SELECT false, false, 10::numeric, NULL::text, 0::numeric;
    RETURN;
  END IF;

  SELECT * INTO v_org
  FROM public.orgs
  WHERE id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 10::numeric, NULL::text, 0::numeric;
    RETURN;
  END IF;

  SELECT COALESCE((
    SELECT balances.available_credits
    FROM public.usage_credit_balances AS balances
    WHERE balances.org_id = p_org_id
  ), 0) INTO v_available;

  IF NOT v_org.auto_top_up_enabled THEN
    RETURN QUERY SELECT false, false, v_org.auto_top_up_threshold::numeric, v_org.customer_id::text, v_available;
    RETURN;
  END IF;

  IF v_available >= v_org.auto_top_up_threshold THEN
    RETURN QUERY SELECT false, true, v_org.auto_top_up_threshold::numeric, v_org.customer_id::text, v_available;
    RETURN;
  END IF;

  IF v_org.auto_top_up_last_attempt_at IS NOT NULL
     AND v_org.auto_top_up_last_attempt_at > now() - interval '1 hour' THEN
    RETURN QUERY SELECT false, true, v_org.auto_top_up_threshold::numeric, v_org.customer_id::text, v_available;
    RETURN;
  END IF;

  -- Stop when the next charge would push this month's auto top-ups over the cap.
  IF v_org.auto_top_up_monthly_limit > 0
     AND public.get_credit_auto_top_up_month_total(p_org_id) + v_org.auto_top_up_threshold > v_org.auto_top_up_monthly_limit THEN
    RETURN QUERY SELECT false, true, v_org.auto_top_up_threshold::numeric, v_org.customer_id::text, v_available;
    RETURN;
  END IF;

  UPDATE public.orgs
  SET auto_top_up_last_attempt_at = now()
  WHERE id = p_org_id;

  RETURN QUERY SELECT true, true, v_org.auto_top_up_threshold::numeric, v_org.customer_id::text, v_available;
END;
$$;

ALTER FUNCTION public.try_claim_credit_auto_top_up(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.try_claim_credit_auto_top_up(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.try_claim_credit_auto_top_up(uuid) TO service_role;
