-- Auto top-up settings on orgs, plus apply remaining credits after a partial debit.

ALTER TABLE "public"."orgs"
  ADD COLUMN IF NOT EXISTS "auto_top_up_enabled" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "auto_top_up_threshold" numeric(18,6) DEFAULT 10 NOT NULL,
  ADD COLUMN IF NOT EXISTS "auto_top_up_last_attempt_at" timestamp with time zone;

ALTER TABLE "public"."orgs"
  DROP CONSTRAINT IF EXISTS "orgs_auto_top_up_threshold_min";

ALTER TABLE "public"."orgs"
  ADD CONSTRAINT "orgs_auto_top_up_threshold_min" CHECK (("auto_top_up_threshold" >= (10)::numeric));

COMMENT ON COLUMN "public"."orgs"."auto_top_up_enabled" IS 'When true, the plan-check cron charges the saved card if available credits fall below auto_top_up_threshold. Default false.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_threshold" IS 'Credit balance (USD/credits, 1:1) that triggers an automatic top-up of this same amount. Minimum 10.';

COMMENT ON COLUMN "public"."orgs"."auto_top_up_last_attempt_at" IS 'Last automatic top-up attempt. Used as a cooldown so cron does not create overlapping charges.';

CREATE OR REPLACE FUNCTION "public"."apply_usage_overage"("p_org_id" "uuid", "p_metric" "public"."credit_metric_type", "p_overage_amount" numeric, "p_billing_cycle_start" timestamp with time zone, "p_billing_cycle_end" timestamp with time zone, "p_details" "jsonb" DEFAULT NULL::"jsonb") RETURNS TABLE("overage_amount" numeric, "credits_required" numeric, "credits_applied" numeric, "credits_remaining" numeric, "credit_step_id" bigint, "overage_covered" numeric, "overage_unpaid" numeric, "overage_event_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_calc RECORD;
  v_event_id uuid;
  v_remaining numeric := 0;
  v_applied numeric := 0;
  v_per_unit numeric := 0;
  v_available numeric;
  v_use numeric;
  v_balance numeric;
  v_overage_paid numeric := 0;
  v_existing_credits_debited numeric := 0;
  v_required numeric := 0;
  v_credits_to_apply numeric := 0;
  v_credits_available numeric := 0;
  v_latest_event_id uuid;
  v_latest_overage_amount numeric;
  v_needs_new_record boolean := false;
  grant_rec public.usage_credit_grants%ROWTYPE;
BEGIN
  -- Early exit for invalid input
  IF p_overage_amount IS NULL OR p_overage_amount <= 0 THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric, 0::numeric, 0::numeric, NULL::bigint, 0::numeric, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  -- Calculate credit cost for this overage
  SELECT *
  INTO v_calc
  FROM public.calculate_credit_cost(p_metric, p_overage_amount)
  LIMIT 1;

  -- If no pricing step found, create a single record and exit
  IF v_calc.credit_step_id IS NULL THEN
    -- Check if we already have a record for this cycle with NULL step
    SELECT uoe.id, uoe.overage_amount INTO v_latest_event_id, v_latest_overage_amount
    FROM public.usage_overage_events uoe
    WHERE uoe.org_id = p_org_id
      AND uoe.metric = p_metric
      AND uoe.credit_step_id IS NULL
      AND (uoe.billing_cycle_start IS NOT DISTINCT FROM p_billing_cycle_start::date)
      AND (uoe.billing_cycle_end IS NOT DISTINCT FROM p_billing_cycle_end::date)
    ORDER BY uoe.created_at DESC
    LIMIT 1;

    -- Only create new record if overage amount changed significantly (more than 1% or first record)
    IF v_latest_event_id IS NULL OR ABS(v_latest_overage_amount - p_overage_amount) / NULLIF(v_latest_overage_amount, 0) > 0.01 THEN
      INSERT INTO public.usage_overage_events (
        org_id,
        metric,
        overage_amount,
        credits_estimated,
        credits_debited,
        credit_step_id,
        billing_cycle_start,
        billing_cycle_end,
        details
      )
      VALUES (
        p_org_id,
        p_metric,
        p_overage_amount,
        0,
        0,
        NULL,
        p_billing_cycle_start,
        p_billing_cycle_end,
        p_details
      )
      RETURNING id INTO v_event_id;
    ELSE
      -- Reuse existing event
      v_event_id := v_latest_event_id;
    END IF;

    RETURN QUERY SELECT p_overage_amount, 0::numeric, 0::numeric, 0::numeric, NULL::bigint, 0::numeric, p_overage_amount, v_event_id;
    RETURN;
  END IF;

  v_per_unit := v_calc.credit_cost_per_unit;
  v_required := v_calc.credits_required;

  -- Get the most recent event for this cycle
  SELECT uoe.id, uoe.overage_amount
  INTO v_latest_event_id, v_latest_overage_amount
  FROM public.usage_overage_events uoe
  WHERE uoe.org_id = p_org_id
    AND uoe.metric = p_metric
    AND (uoe.billing_cycle_start IS NOT DISTINCT FROM p_billing_cycle_start::date)
    AND (uoe.billing_cycle_end IS NOT DISTINCT FROM p_billing_cycle_end::date)
  ORDER BY uoe.created_at DESC
  LIMIT 1;

  -- Calculate how many credits we can still try to apply
  -- Use credits_debited for this since it reflects actual consumption
  SELECT COALESCE(SUM(credits_debited), 0)
  INTO v_existing_credits_debited
  FROM public.usage_overage_events
  WHERE org_id = p_org_id
    AND metric = p_metric
    AND (billing_cycle_start IS NOT DISTINCT FROM p_billing_cycle_start::date)
    AND (billing_cycle_end IS NOT DISTINCT FROM p_billing_cycle_end::date);

  v_credits_to_apply := GREATEST(v_required - v_existing_credits_debited, 0);
  v_remaining := v_credits_to_apply;

  -- Check if there are any credits available in grants
  SELECT COALESCE(SUM(GREATEST(credits_total - credits_consumed, 0)), 0)
  INTO v_credits_available
  FROM public.usage_credit_grants
  WHERE org_id = p_org_id
    AND expires_at >= now();

  -- Determine if we need a new record:
  -- 1. No existing record for this cycle (first overage)
  -- 2. Overage amount changed significantly (more than 1%)
  -- 3. Unpaid credits remain AND the org still has grants to apply
  --    (including grants added after a partial debit in the same cycle)
  v_needs_new_record := v_latest_event_id IS NULL
    OR (v_latest_overage_amount IS NOT NULL
        AND ABS(v_latest_overage_amount - p_overage_amount) / NULLIF(v_latest_overage_amount, 0) > 0.01)
    OR (v_credits_to_apply > 0 AND v_credits_available > 0);

  -- Only create new record if needed
  IF v_needs_new_record THEN
    INSERT INTO public.usage_overage_events (
      org_id,
      metric,
      overage_amount,
      credits_estimated,
      credits_debited,
      credit_step_id,
      billing_cycle_start,
      billing_cycle_end,
      details
    )
    VALUES (
      p_org_id,
      p_metric,
      p_overage_amount,
      v_required,
      0,
      v_calc.credit_step_id,
      p_billing_cycle_start,
      p_billing_cycle_end,
      p_details
    )
    RETURNING id INTO v_event_id;

    -- Apply credits from available grants if any
    IF v_credits_to_apply > 0 THEN
      FOR grant_rec IN
        SELECT *
        FROM public.usage_credit_grants
        WHERE org_id = p_org_id
          AND expires_at >= now()
          AND credits_consumed < credits_total
        ORDER BY expires_at ASC, granted_at ASC
        FOR UPDATE
      LOOP
        EXIT WHEN v_remaining <= 0;

        v_available := grant_rec.credits_total - grant_rec.credits_consumed;
        IF v_available <= 0 THEN
          CONTINUE;
        END IF;

        v_use := LEAST(v_available, v_remaining);
        v_remaining := v_remaining - v_use;
        v_applied := v_applied + v_use;

        UPDATE public.usage_credit_grants
        SET credits_consumed = credits_consumed + v_use
        WHERE id = grant_rec.id;

        INSERT INTO public.usage_credit_consumptions (
          grant_id,
          org_id,
          overage_event_id,
          metric,
          credits_used
        )
        VALUES (
          grant_rec.id,
          p_org_id,
          v_event_id,
          p_metric,
          v_use
        );

        SELECT COALESCE(SUM(GREATEST(credits_total - credits_consumed, 0)), 0)
        INTO v_balance
        FROM public.usage_credit_grants
        WHERE org_id = p_org_id
          AND expires_at >= now();

        INSERT INTO public.usage_credit_transactions (
          org_id,
          grant_id,
          transaction_type,
          amount,
          balance_after,
          occurred_at,
          description,
          source_ref
        )
        VALUES (
          p_org_id,
          grant_rec.id,
          'deduction',
          -v_use,
          v_balance,
          now(),
          format('Overage deduction for %s usage', p_metric::text),
          jsonb_build_object('overage_event_id', v_event_id, 'metric', p_metric::text)
        );
      END LOOP;

      -- Update the event with actual credits applied
      UPDATE public.usage_overage_events
      SET credits_debited = v_applied
      WHERE id = v_event_id;
    END IF;
  ELSE
    -- Reuse latest event ID, no new record needed
    v_event_id := v_latest_event_id;
  END IF;

  -- Calculate how much overage is covered by credits
  IF v_per_unit > 0 THEN
    v_overage_paid := LEAST(p_overage_amount, (v_applied + v_existing_credits_debited) / v_per_unit);
  ELSE
    v_overage_paid := p_overage_amount;
  END IF;

  RETURN QUERY SELECT
    p_overage_amount,
    v_required,
    v_applied,
    GREATEST(v_required - v_existing_credits_debited - v_applied, 0),
    v_calc.credit_step_id,
    v_overage_paid,
    GREATEST(p_overage_amount - v_overage_paid, 0),
    v_event_id;
END;
$$;

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

  SELECT COALESCE(balances.available_credits, 0) INTO v_available
  FROM public.usage_credit_balances AS balances
  WHERE balances.org_id = p_org_id;

  IF NOT v_org.auto_top_up_enabled THEN
    RETURN QUERY SELECT false, false, v_org.auto_top_up_threshold, v_org.customer_id, v_available;
    RETURN;
  END IF;

  IF v_available >= v_org.auto_top_up_threshold THEN
    RETURN QUERY SELECT false, true, v_org.auto_top_up_threshold, v_org.customer_id, v_available;
    RETURN;
  END IF;

  IF v_org.auto_top_up_last_attempt_at IS NOT NULL
     AND v_org.auto_top_up_last_attempt_at > now() - interval '1 hour' THEN
    RETURN QUERY SELECT false, true, v_org.auto_top_up_threshold, v_org.customer_id, v_available;
    RETURN;
  END IF;

  UPDATE public.orgs
  SET auto_top_up_last_attempt_at = now()
  WHERE id = p_org_id;

  RETURN QUERY SELECT true, true, v_org.auto_top_up_threshold, v_org.customer_id, v_available;
END;
$$;

ALTER FUNCTION public.try_claim_credit_auto_top_up(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.try_claim_credit_auto_top_up(uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.try_claim_credit_auto_top_up(uuid) TO service_role;

