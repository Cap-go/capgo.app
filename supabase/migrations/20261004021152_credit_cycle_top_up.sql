-- Scheduled credit top-up: buy a fixed amount of credits once per billing cycle.
-- Works alongside (or instead of) the threshold auto top-up.

ALTER TABLE "public"."orgs"
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_enabled" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_amount" numeric(18,6) DEFAULT 10 NOT NULL,
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_paid_for" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_last_attempt_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_attempt" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_pending_intent_id" text,
  ADD COLUMN IF NOT EXISTS "auto_top_up_cycle_unknown_since" timestamp with time zone;

ALTER TABLE "public"."orgs"
  DROP CONSTRAINT IF EXISTS "orgs_auto_top_up_cycle_amount_min";

ALTER TABLE "public"."orgs"
  ADD CONSTRAINT "orgs_auto_top_up_cycle_amount_min" CHECK (("auto_top_up_cycle_amount" >= (10)::numeric AND "auto_top_up_cycle_amount" = trunc("auto_top_up_cycle_amount") AND "auto_top_up_cycle_amount" < 'Infinity'::numeric)) NOT VALID;

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_enabled" IS 'When true, the plan-check cron buys auto_top_up_cycle_amount credits once per billing cycle with the saved card. Default false.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_amount" IS 'Credits (USD, 1:1) bought at the start of each billing cycle when auto_top_up_cycle_enabled is true. Minimum 10.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_paid_for" IS 'Start of the billing cycle whose scheduled top-up was claimed. Prevents a second charge in the same cycle.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_last_attempt_at" IS 'Last scheduled top-up attempt. Used as a retry cooldown after a failed charge.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_attempt" IS 'Attempt counter in the Stripe idempotency key. Bumped only after a charge is confirmed not taken, so retries after an unknown outcome replay the same PaymentIntent.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_pending_intent_id" IS 'Scheduled top-up PaymentIntent whose outcome is not settled yet (processing, or granted credits not recorded). Reconciled by the plan-check cron; blocks new top-up charges while set.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_cycle_unknown_since" IS 'Set when a scheduled charge request had an unknown outcome (no PaymentIntent returned). The cycle stays reserved until the cron finds the PaymentIntent in Stripe or confirms none was created.';

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
  attempt integer
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
    RETURN QUERY SELECT false, 0::numeric, NULL::text, NULL::timestamptz, 0;
    RETURN;
  END IF;

  SELECT * INTO v_org
  FROM public.orgs
  WHERE id = p_org_id
  FOR UPDATE;

  -- A charge whose outcome is still unknown must be reconciled first.
  IF NOT FOUND
     OR NOT v_org.auto_top_up_cycle_enabled
     OR v_org.customer_id IS NULL
     OR v_org.auto_top_up_cycle_pending_intent_id IS NOT NULL
     OR v_org.auto_top_up_cycle_unknown_since IS NOT NULL THEN
    RETURN QUERY SELECT false, 0::numeric, NULL::text, NULL::timestamptz, 0;
    RETURN;
  END IF;

  SELECT cycle.cycle_start INTO v_cycle_start
  FROM public.get_org_billing_cycle(p_org_id) AS cycle;

  IF v_cycle_start IS NULL THEN
    RETURN QUERY SELECT false, v_org.auto_top_up_cycle_amount::numeric, v_org.customer_id::text, NULL::timestamptz, v_org.auto_top_up_cycle_attempt;
    RETURN;
  END IF;

  -- Already bought for this cycle.
  IF v_org.auto_top_up_cycle_paid_for IS NOT NULL
     AND v_org.auto_top_up_cycle_paid_for >= v_cycle_start THEN
    RETURN QUERY SELECT false, v_org.auto_top_up_cycle_amount::numeric, v_org.customer_id::text, v_cycle_start, v_org.auto_top_up_cycle_attempt;
    RETURN;
  END IF;

  -- Retry a failed charge at most every 6 hours.
  IF v_org.auto_top_up_cycle_last_attempt_at IS NOT NULL
     AND v_org.auto_top_up_cycle_last_attempt_at > now() - interval '6 hours' THEN
    RETURN QUERY SELECT false, v_org.auto_top_up_cycle_amount::numeric, v_org.customer_id::text, v_cycle_start, v_org.auto_top_up_cycle_attempt;
    RETURN;
  END IF;

  UPDATE public.orgs
  SET
    auto_top_up_cycle_paid_for = v_cycle_start,
    auto_top_up_cycle_last_attempt_at = now()
  WHERE id = p_org_id;

  RETURN QUERY SELECT true, v_org.auto_top_up_cycle_amount::numeric, v_org.customer_id::text, v_cycle_start, v_org.auto_top_up_cycle_attempt;
END;
$$;

ALTER FUNCTION public.try_claim_credit_cycle_top_up(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.try_claim_credit_cycle_top_up(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_claim_credit_cycle_top_up(uuid) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.try_claim_credit_cycle_top_up(uuid) TO service_role;

-- Execution profile (service_role RPC from plan-check cron, only after a charge did not go through):
-- Single primary-key UPDATE on public.orgs. Frees the reserved cycle so the next run (after the
-- retry cooldown) tries again, and clears any pending PaymentIntent. p_new_attempt rotates the
-- Stripe idempotency key; pass it only when Stripe confirmed no money moved.
-- No-op if the org already moved to another cycle.
CREATE OR REPLACE FUNCTION public.release_credit_cycle_top_up(
  p_org_id uuid,
  p_cycle_start timestamp with time zone,
  p_new_attempt boolean DEFAULT false
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.orgs
  SET
    auto_top_up_cycle_paid_for = NULL,
    auto_top_up_cycle_pending_intent_id = NULL,
    auto_top_up_cycle_unknown_since = NULL,
    auto_top_up_cycle_attempt = auto_top_up_cycle_attempt + CASE WHEN p_new_attempt THEN 1 ELSE 0 END
  WHERE id = p_org_id
    AND auto_top_up_cycle_paid_for = p_cycle_start;
$$;

ALTER FUNCTION public.release_credit_cycle_top_up(uuid, timestamp with time zone, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_credit_cycle_top_up(uuid, timestamp with time zone, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_credit_cycle_top_up(uuid, timestamp with time zone, boolean) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.release_credit_cycle_top_up(uuid, timestamp with time zone, boolean) TO service_role;
