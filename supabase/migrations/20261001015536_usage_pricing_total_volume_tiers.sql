-- Usage pricing: tiers follow total volume, not overage volume.
--
-- capgo_credits_steps tiers used to be applied to the overage amount
-- starting at 0, for every plan. A plan that includes 1M MAU paid the most
-- expensive tier ($0.003/MAU) on its first extra MAU, about 12x its own
-- plan rate, so going from 1M to 2M MAU cost 13x more. Bandwidth, storage
-- and build time had the same cliff.
--
-- Tiers now describe total usage. Overage is priced on the slice of the
-- ladder it covers: [included, included + overage). Plans whose limits sit
-- in the first tier pay what they paid before; larger plans continue on
-- the cheaper tiers above their limit. Credit-only orgs include 0, so they
-- keep pricing from the bottom of the ladder.
--
-- The MAU tiers above 1M and the bandwidth tiers above 100 TB are
-- re-priced so price per unit keeps going down with volume. These public
-- tiers are the full price at every volume.

-- ---------------------------------------------------------------------------
-- 1. calculate_credit_cost over a slice of the tier ladder
-- ---------------------------------------------------------------------------
--
-- Billing has no org parameter, so it only reads the global tiers
-- (org_id IS NULL). An org-scoped row must never change another org's price.

CREATE FUNCTION public.calculate_credit_cost(
    p_metric public.credit_metric_type,
    p_overage_amount numeric,
    p_included_amount numeric
)
RETURNS TABLE (
    credit_step_id bigint,
    credit_cost_per_unit numeric,
    credits_required numeric
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_step public.capgo_credits_steps%ROWTYPE;
  v_highest public.capgo_credits_steps%ROWTYPE;
  v_start numeric;
  v_end numeric;
  v_covered numeric := 0;
  v_slice numeric;
  v_units numeric;
  v_unit_factor numeric;
  v_total_credits numeric := 0;
  v_last_step_id bigint := NULL;
BEGIN
  IF p_overage_amount IS NULL OR p_overage_amount <= 0 THEN
    RETURN QUERY SELECT NULL::bigint, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  v_start := GREATEST(COALESCE(p_included_amount, 0), 0);
  v_end := v_start + p_overage_amount;

  SELECT *
  INTO v_highest
  FROM public.capgo_credits_steps
  WHERE type = p_metric::text
    AND org_id IS NULL
  ORDER BY step_max DESC, step_min DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE WARNING 'No pricing steps found for metric: %', p_metric::text;
    RETURN QUERY SELECT NULL::bigint, 0::numeric, 0::numeric;
    RETURN;
  END IF;

  FOR v_step IN
    SELECT *
    FROM public.capgo_credits_steps
    WHERE type = p_metric::text
      AND org_id IS NULL
      AND step_max > v_start
      AND step_min < v_end
    ORDER BY step_min ASC
  LOOP
    v_slice := LEAST(v_end, v_step.step_max::numeric) - GREATEST(v_start, v_step.step_min::numeric);

    IF v_slice <= 0 THEN
      CONTINUE;
    END IF;

    v_unit_factor := GREATEST(NULLIF(v_step.unit_factor, 0), 1)::numeric;
    v_units := CEILING(v_slice / v_unit_factor);
    v_total_credits := v_total_credits + (v_units * v_step.price_per_unit::numeric);
    v_covered := v_covered + v_slice;
    v_last_step_id := v_step.id;
  END LOOP;

  -- Usage outside every tier range (gaps or above the top tier) is billed
  -- at the top tier price.
  IF v_covered < p_overage_amount THEN
    v_unit_factor := GREATEST(NULLIF(v_highest.unit_factor, 0), 1)::numeric;
    v_units := CEILING((p_overage_amount - v_covered) / v_unit_factor);
    v_total_credits := v_total_credits + (v_units * v_highest.price_per_unit::numeric);
    v_last_step_id := COALESCE(v_last_step_id, v_highest.id);
  END IF;

  RETURN QUERY SELECT
    v_last_step_id,
    v_total_credits / p_overage_amount,
    v_total_credits;
END;
$$;

ALTER FUNCTION public.calculate_credit_cost(public.credit_metric_type, numeric, numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.calculate_credit_cost(public.credit_metric_type, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calculate_credit_cost(public.credit_metric_type, numeric, numeric) FROM anon, authenticated, service_role;

-- The two-argument form prices from the bottom of the ladder (nothing
-- included), which is the credit-only org case.
CREATE OR REPLACE FUNCTION public.calculate_credit_cost(
    p_metric public.credit_metric_type,
    p_overage_amount numeric
)
RETURNS TABLE (
    credit_step_id bigint,
    credit_cost_per_unit numeric,
    credits_required numeric
)
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT *
  FROM public.calculate_credit_cost(p_metric, p_overage_amount, 0::numeric);
$$;

-- ---------------------------------------------------------------------------
-- 2. apply_usage_overage takes the plan's included amount
-- ---------------------------------------------------------------------------
--
-- Same body as 20260930094441 except the credit cost call and the
-- covered-usage walk. The new parameter defaults to 0 so a backend
-- deployed before this migration keeps working with the old (bottom of
-- the ladder) pricing.

DROP FUNCTION public.apply_usage_overage(
    uuid,
    public.credit_metric_type,
    numeric,
    timestamp with time zone,
    timestamp with time zone,
    jsonb
);

CREATE FUNCTION public.apply_usage_overage(
    p_org_id uuid,
    p_metric public.credit_metric_type,
    p_overage_amount numeric,
    p_billing_cycle_start timestamp with time zone,
    p_billing_cycle_end timestamp with time zone,
    p_details jsonb DEFAULT NULL,
    p_included_amount numeric DEFAULT 0
)
RETURNS TABLE (
    overage_amount numeric,
    credits_required numeric,
    credits_applied numeric,
    credits_remaining numeric,
    credit_step_id bigint,
    overage_covered numeric,
    overage_unpaid numeric,
    overage_event_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
  v_latest_event_id uuid;
  v_latest_overage_amount numeric;
  v_needs_new_record boolean := false;
  v_budget numeric;
  v_start numeric;
  v_end numeric;
  v_slice numeric;
  v_slice_cost numeric;
  v_unit_factor numeric;
  step_rec public.capgo_credits_steps%ROWTYPE;
  grant_rec public.usage_credit_grants%ROWTYPE;
BEGIN
  -- Early exit for invalid input
  IF p_overage_amount IS NULL OR p_overage_amount <= 0 THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric, 0::numeric, 0::numeric, NULL::bigint, 0::numeric, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  -- Serialize concurrent calls for the same org + metric so the debited total
  -- read below always reflects committed debits from other callers.
  PERFORM pg_advisory_xact_lock(hashtextextended('apply_usage_overage:' || p_org_id::text || ':' || p_metric::text, 0));

  -- Price the overage at the tiers of the total volume it sits in:
  -- [p_included_amount, p_included_amount + p_overage_amount).
  SELECT *
  INTO v_calc
  FROM public.calculate_credit_cost(p_metric, p_overage_amount, COALESCE(p_included_amount, 0))
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

  -- Determine if we need a new record:
  -- 1. No existing record for this cycle (first overage)
  -- 2. Overage amount changed significantly (more than 1%)
  -- 3. Unpaid credits remain AND a grant row can actually be consumed
  --    (same predicate as the apply loop: unexpired and not fully consumed)
  v_needs_new_record := v_latest_event_id IS NULL
    OR (v_latest_overage_amount IS NOT NULL
        AND ABS(v_latest_overage_amount - p_overage_amount) / NULLIF(v_latest_overage_amount, 0) > 0.01)
    OR (
      v_credits_to_apply > 0
      AND EXISTS (
        SELECT 1
        FROM public.usage_credit_grants
        WHERE org_id = p_org_id
          AND expires_at >= now()
          AND credits_consumed < credits_total
      )
    );

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

  -- Calculate how much overage is covered by credits. Walk the same tier
  -- slices as calculate_credit_cost: a blended rate would overstate the
  -- usage partial credits cover, since the cheaper tiers come last.
  v_budget := v_applied + v_existing_credits_debited;
  IF v_per_unit <= 0 OR v_budget >= v_required THEN
    v_overage_paid := p_overage_amount;
  ELSE
    v_start := GREATEST(COALESCE(p_included_amount, 0), 0);
    v_end := v_start + p_overage_amount;
    FOR step_rec IN
      SELECT *
      FROM public.capgo_credits_steps
      WHERE type = p_metric::text
        AND org_id IS NULL
        AND step_max > v_start
        AND step_min < v_end
      ORDER BY step_min ASC
    LOOP
      EXIT WHEN v_budget <= 0;

      v_slice := LEAST(v_end, step_rec.step_max::numeric) - GREATEST(v_start, step_rec.step_min::numeric);
      CONTINUE WHEN v_slice <= 0 OR step_rec.price_per_unit <= 0;

      v_unit_factor := GREATEST(NULLIF(step_rec.unit_factor, 0), 1)::numeric;
      v_slice_cost := CEILING(v_slice / v_unit_factor) * step_rec.price_per_unit::numeric;

      IF v_budget >= v_slice_cost THEN
        v_overage_paid := v_overage_paid + v_slice;
        v_budget := v_budget - v_slice_cost;
      ELSE
        v_overage_paid := v_overage_paid
          + FLOOR(v_budget / step_rec.price_per_unit::numeric) * v_unit_factor;
        v_budget := 0;
      END IF;
    END LOOP;
    v_overage_paid := LEAST(v_overage_paid, p_overage_amount);
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

ALTER FUNCTION public.apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamp with time zone, timestamp with time zone, jsonb, numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamp with time zone, timestamp with time zone, jsonb, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamp with time zone, timestamp with time zone, jsonb, numeric) FROM anon, authenticated;
GRANT ALL ON FUNCTION public.apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamp with time zone, timestamp with time zone, jsonb, numeric) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Re-price the high-volume tiers
-- ---------------------------------------------------------------------------

-- Rows are re-priced in place (matched by position) so existing
-- usage_overage_events.credit_step_id references keep their row; extra old
-- rows are deleted and missing ones inserted.
CREATE TEMP TABLE new_credit_tiers (
    type text NOT NULL,
    from_step_min bigint NOT NULL,
    position integer NOT NULL,
    step_min bigint NOT NULL,
    step_max bigint NOT NULL,
    price_per_unit double precision NOT NULL,
    unit_factor bigint NOT NULL
) ON COMMIT DROP;

-- MAU: 0-1M stays at $0.003. Above 1M, per 1k MAU: $0.60 up to 3M,
-- $0.45 up to 6M, $0.35 up to 10M, $0.25 up to 25M, $0.18 up to 100M,
-- then $0.12.
-- Bandwidth: tiers up to 63 TB stay. 63-100 TB stays at $0.015/GiB.
-- Above 100 TB: $0.008/GiB up to 250 TB, $0.006 up to 500 TB, $0.005 up
-- to 1 PB, then $0.004.
INSERT INTO new_credit_tiers (
    type, from_step_min, position, step_min, step_max, price_per_unit, unit_factor
)
VALUES
    ('mau', 1000000, 1, 1000000, 3000000, 0.0006, 1),
    ('mau', 1000000, 2, 3000000, 6000000, 0.00045, 1),
    ('mau', 1000000, 3, 6000000, 10000000, 0.00035, 1),
    ('mau', 1000000, 4, 10000000, 25000000, 0.00025, 1),
    ('mau', 1000000, 5, 25000000, 100000000, 0.00018, 1),
    ('mau', 1000000, 6, 100000000, 9223372036854775807, 0.00012, 1),
    ('bandwidth', 69269232549888, 1, 69269232549888, 109951162777600, 0.015, 1073741824),
    ('bandwidth', 69269232549888, 2, 109951162777600, 274877906944000, 0.008, 1073741824),
    ('bandwidth', 69269232549888, 3, 274877906944000, 549755813888000, 0.006, 1073741824),
    ('bandwidth', 69269232549888, 4, 549755813888000, 1125899906842624, 0.005, 1073741824),
    ('bandwidth', 69269232549888, 5, 1125899906842624, 9223372036854775807, 0.004, 1073741824);

CREATE TEMP TABLE old_credit_tiers ON COMMIT DROP AS
SELECT
    s.id,
    s.type,
    row_number() OVER (PARTITION BY s.type ORDER BY s.step_min, s.id)::integer AS position
FROM public.capgo_credits_steps AS s
WHERE
    s.org_id IS NULL
    AND s.step_min >= (
        SELECT min(n.from_step_min)
        FROM new_credit_tiers AS n
        WHERE n.type = s.type
    );

DELETE FROM public.capgo_credits_steps AS s
USING old_credit_tiers AS o
WHERE
    s.id = o.id
    AND NOT EXISTS (
        SELECT 1
        FROM new_credit_tiers AS n
        WHERE n.type = o.type AND n.position = o.position
    );

UPDATE public.capgo_credits_steps AS s
SET
    step_min = n.step_min,
    step_max = n.step_max,
    price_per_unit = n.price_per_unit,
    unit_factor = n.unit_factor
FROM old_credit_tiers AS o
INNER JOIN new_credit_tiers AS n
    ON o.type = n.type AND o.position = n.position
WHERE s.id = o.id;

INSERT INTO public.capgo_credits_steps (
    type, step_min, step_max, price_per_unit, unit_factor, org_id
)
SELECT
    n.type,
    n.step_min,
    n.step_max,
    n.price_per_unit,
    n.unit_factor,
    NULL
FROM new_credit_tiers AS n
WHERE NOT EXISTS (
    SELECT 1
    FROM old_credit_tiers AS o
    WHERE o.type = n.type AND o.position = n.position
);
