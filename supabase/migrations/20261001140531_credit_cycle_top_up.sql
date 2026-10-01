-- Scheduled credit top-up: buy a fixed amount of credits once per billing cycle.
-- Works alongside (or instead of) the threshold auto top-up.

ALTER TABLE "public"."orgs"
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_enabled" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_amount" numeric(18,6) DEFAULT 10 NOT NULL,
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_paid_for" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_last_attempt_at" timestamp with time zone;

ALTER TABLE "public"."orgs"
  DROP CONSTRAINT IF EXISTS "orgs_auto_top_up_cycle_amount_min";

ALTER TABLE "public"."orgs"
  ADD CONSTRAINT "orgs_auto_top_up_cycle_amount_min" CHECK (("auto_top_up_cycle_amount" >= (10)::numeric AND "auto_top_up_cycle_amount" = trunc("auto_top_up_cycle_amount") AND "auto_top_up_cycle_amount" < 'Infinity'::numeric)) NOT VALID;

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_enabled" IS 'When true, the plan-check cron buys auto_top_up_cycle_amount credits once per billing cycle with the saved card. Default false.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_amount" IS 'Credits (USD, 1:1) bought at the start of each billing cycle when auto_top_up_cycle_enabled is true. Minimum 10.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_paid_for" IS 'Start of the billing cycle whose scheduled top-up was claimed. Prevents a second charge in the same cycle.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_last_attempt_at" IS 'Last scheduled top-up attempt. Used as a retry cooldown after a failed charge.';

-- Execution profile (service_role RPC from plan-check cron, once per org per run):
-- Locks public.orgs by primary key FOR UPDATE, then resolves the current cycle with
-- get_org_billing_cycle (1 org row + 1 stripe_info row by customer_id). Not used by RLS.
-- Claiming reserves the cycle (auto_top_up_cycle_paid_for) so concurrent runs cannot charge twice.
CREATE OR REPLACE FUNCTION public.try_claim_credit_cycle_top_up(p_org_id uuid)
RETURNS TABLE(
  claimed boolean,
  amount numeric,
  customer_id text,
  cycle_start timestamp with time zone,
  previous_paid_for timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org public.orgs%ROWTYPE;
  v_cycle_start timestamptz;
BEGIN
  IF p_org_id IS NULL THEN
    RETURN QUERY SELECT false, 0::numeric, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_org
  FROM public.orgs
  WHERE id = p_org_id
  FOR UPDATE;

  IF NOT FOUND OR NOT v_org.auto_top_up_cycle_enabled OR v_org.customer_id IS NULL THEN
    RETURN QUERY SELECT false, 0::numeric, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT cycle.cycle_start INTO v_cycle_start
  FROM public.get_org_billing_cycle(p_org_id) AS cycle;

  IF v_cycle_start IS NULL THEN
    RETURN QUERY SELECT false, v_org.auto_top_up_cycle_amount::numeric, v_org.customer_id::text, NULL::timestamptz, v_org.auto_top_up_cycle_paid_for;
    RETURN;
  END IF;

  -- Already bought for this cycle.
  IF v_org.auto_top_up_cycle_paid_for IS NOT NULL
     AND v_org.auto_top_up_cycle_paid_for >= v_cycle_start THEN
    RETURN QUERY SELECT false, v_org.auto_top_up_cycle_amount::numeric, v_org.customer_id::text, v_cycle_start, v_org.auto_top_up_cycle_paid_for;
    RETURN;
  END IF;

  -- Retry a failed charge at most every 6 hours.
  IF v_org.auto_top_up_cycle_last_attempt_at IS NOT NULL
     AND v_org.auto_top_up_cycle_last_attempt_at > now() - interval '6 hours' THEN
    RETURN QUERY SELECT false, v_org.auto_top_up_cycle_amount::numeric, v_org.customer_id::text, v_cycle_start, v_org.auto_top_up_cycle_paid_for;
    RETURN;
  END IF;

  UPDATE public.orgs
  SET
    auto_top_up_cycle_paid_for = v_cycle_start,
    auto_top_up_cycle_last_attempt_at = now()
  WHERE id = p_org_id;

  RETURN QUERY SELECT true, v_org.auto_top_up_cycle_amount::numeric, v_org.customer_id::text, v_cycle_start, v_org.auto_top_up_cycle_paid_for;
END;
$$;

ALTER FUNCTION public.try_claim_credit_cycle_top_up(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.try_claim_credit_cycle_top_up(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_claim_credit_cycle_top_up(uuid) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.try_claim_credit_cycle_top_up(uuid) TO service_role;

-- Execution profile (service_role RPC from plan-check cron, only after a failed charge):
-- Single primary-key UPDATE on public.orgs. Restores the previous paid-for cycle so the
-- next run (after the retry cooldown) tries again. No-op if another claim moved on.
CREATE OR REPLACE FUNCTION public.release_credit_cycle_top_up(
  p_org_id uuid,
  p_cycle_start timestamp with time zone,
  p_previous_paid_for timestamp with time zone DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.orgs
  SET auto_top_up_cycle_paid_for = p_previous_paid_for
  WHERE id = p_org_id
    AND auto_top_up_cycle_paid_for = p_cycle_start;
$$;

ALTER FUNCTION public.release_credit_cycle_top_up(uuid, timestamp with time zone, timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_credit_cycle_top_up(uuid, timestamp with time zone, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_credit_cycle_top_up(uuid, timestamp with time zone, timestamp with time zone) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.release_credit_cycle_top_up(uuid, timestamp with time zone, timestamp with time zone) TO service_role;
