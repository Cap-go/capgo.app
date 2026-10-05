-- Billing usage fixes:
--   1. Serialize apply_usage_overage per (org, metric) to stop double
--      credit debits.
--   2. Keep build time of deleted apps billable for the rest of the cycle,
--      like MAU and bandwidth, then purge it with the deleted_apps
--      retention window.

-- ---------------------------------------------------------------------------
-- 1. apply_usage_overage concurrency
-- ---------------------------------------------------------------------------
--
-- The function reads the already-debited credit total for the billing cycle
-- from usage_overage_events without any lock, and only locks
-- usage_credit_grants later. cron_stat_org, cron_sync_sub, and queue retries
-- can call it concurrently for the same org: both calls read 0 debited, both
-- compute the full credits required, and the second debits again after
-- waiting on the grant row lock (double debit).
--
-- A transaction-scoped advisory lock keyed on org + metric makes the second
-- call wait until the first commits. Under READ COMMITTED each following
-- statement takes a fresh snapshot, so it sees the first call's
-- credits_debited.
--
-- CREATE OR REPLACE keeps the existing owner (postgres) and the
-- REVOKE ALL FROM PUBLIC / GRANT ALL TO service_role privileges.

CREATE OR REPLACE FUNCTION public.apply_usage_overage(
    p_org_id uuid,
    p_metric public.credit_metric_type,
    p_overage_amount numeric,
    p_billing_cycle_start timestamp with time zone,
    p_billing_cycle_end timestamp with time zone,
    p_details jsonb DEFAULT NULL
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

-- ---------------------------------------------------------------------------
-- 2. Build time of deleted apps stays billable
-- ---------------------------------------------------------------------------
--
-- daily_build_time.app_id had ON DELETE CASCADE to apps, so deleting an app
-- mid-cycle wiped its build seconds before calculate_org_metrics_cache_entry
-- could count them through deleted_apps (under-billing). daily_mau and
-- daily_bandwidth have no FK to apps; match them so rows survive app deletion.
ALTER TABLE public.daily_build_time
DROP CONSTRAINT IF EXISTS daily_build_time_app_id_fkey;

-- build_logs.app_id is ON DELETE SET NULL. That detach is an UPDATE on
-- build_logs, which used to subtract the build from daily_build_time. When the
-- app row is gone, keep the daily bucket so the cycle total stays intact.
CREATE OR REPLACE FUNCTION public.aggregate_build_log_to_daily()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_date date;
BEGIN
  -- Handle DELETE: subtract old values and return
  IF TG_OP = 'DELETE' THEN
    IF OLD.app_id IS NOT NULL THEN
      v_old_date := (OLD.created_at AT TIME ZONE 'UTC')::date;
      UPDATE public.daily_build_time
      SET build_time_unit = GREATEST(build_time_unit - OLD.billable_seconds, 0),
          build_count = GREATEST(build_count - 1, 0)
      WHERE app_id = OLD.app_id AND date = v_old_date;
    END IF;
    RETURN OLD;
  END IF;

  -- App deleted: build_logs_app_id_fkey (ON DELETE SET NULL) detaches the log.
  -- Keep the daily bucket so the build stays billable via deleted_apps.
  IF TG_OP = 'UPDATE'
    AND OLD.app_id IS NOT NULL
    AND NEW.app_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.apps
      WHERE apps.app_id = OLD.app_id
    ) THEN
    RETURN NEW;
  END IF;

  -- Handle UPDATE: subtract old values from the old bucket (if old had app_id)
  IF TG_OP = 'UPDATE' AND OLD.app_id IS NOT NULL THEN
    v_old_date := (OLD.created_at AT TIME ZONE 'UTC')::date;
    UPDATE public.daily_build_time
    SET build_time_unit = GREATEST(build_time_unit - OLD.billable_seconds, 0),
        build_count = GREATEST(build_count - 1, 0)
    WHERE app_id = OLD.app_id AND date = v_old_date;
  END IF;

  -- Handle INSERT/UPDATE: add new values (only if new app_id is set)
  IF NEW.app_id IS NOT NULL THEN
    INSERT INTO public.daily_build_time (app_id, date, build_time_unit, build_count)
    VALUES (NEW.app_id, (NEW.created_at AT TIME ZONE 'UTC')::date, NEW.billable_seconds, 1)
    ON CONFLICT (app_id, date) DO UPDATE SET
      build_time_unit = public.daily_build_time.build_time_unit + EXCLUDED.build_time_unit,
      build_count = public.daily_build_time.build_count + EXCLUDED.build_count;
  END IF;

  RETURN NEW;
END;
$$;

-- Keep the org build-time helper consistent with the billing metrics: include
-- apps deleted in the last 35 days (deleted_apps), like MAU, bandwidth and
-- build time in calculate_org_metrics_cache_entry.
CREATE OR REPLACE FUNCTION public.get_org_build_time_unit(
    p_org_id uuid, p_start_date date, p_end_date date
)
RETURNS TABLE (total_build_time_unit bigint, total_builds bigint)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH app_ids AS (
    SELECT a.app_id
    FROM public.apps a
    WHERE a.owner_org = p_org_id
    UNION
    SELECT da.app_id
    FROM public.deleted_apps da
    WHERE da.owner_org = p_org_id
  )
  SELECT COALESCE(SUM(dbt.build_time_unit), 0)::bigint, COALESCE(SUM(dbt.build_count), 0)::bigint
  FROM public.daily_build_time dbt
  INNER JOIN app_ids ON app_ids.app_id = dbt.app_id
  WHERE dbt.date >= p_start_date AND dbt.date <= p_end_date;
END;
$$;

-- Daily usage rows of a deleted app are kept for as long as its deleted_apps
-- row (35 days, longer than any billing cycle), then purged here. Rows are only
-- removed when the app_id is not live again and not still retained by another
-- deleted_apps row, so a reused app_id keeps its usage.
CREATE OR REPLACE FUNCTION public.delete_old_deleted_apps()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_purged_app_ids character varying[];
BEGIN
  WITH purged AS (
    DELETE FROM public.deleted_apps
    WHERE deleted_at < now() - interval '35 days'
    RETURNING app_id
  )
  SELECT COALESCE(array_agg(DISTINCT purged.app_id), '{}')
  INTO v_purged_app_ids
  FROM purged;

  IF cardinality(v_purged_app_ids) = 0 THEN
    RETURN;
  END IF;

  DELETE FROM public.daily_build_time dbt
  WHERE dbt.app_id = ANY (v_purged_app_ids)
    AND NOT EXISTS (SELECT 1 FROM public.apps a WHERE a.app_id = dbt.app_id)
    AND NOT EXISTS (SELECT 1 FROM public.deleted_apps da WHERE da.app_id = dbt.app_id);

  DELETE FROM public.daily_mau dm
  WHERE dm.app_id = ANY (v_purged_app_ids)
    AND NOT EXISTS (SELECT 1 FROM public.apps a WHERE a.app_id = dm.app_id)
    AND NOT EXISTS (SELECT 1 FROM public.deleted_apps da WHERE da.app_id = dm.app_id);

  DELETE FROM public.daily_bandwidth db
  WHERE db.app_id = ANY (v_purged_app_ids)
    AND NOT EXISTS (SELECT 1 FROM public.apps a WHERE a.app_id = db.app_id)
    AND NOT EXISTS (SELECT 1 FROM public.deleted_apps da WHERE da.app_id = db.app_id);
END;
$$;

COMMENT ON FUNCTION public.calculate_org_metrics_cache_entry(
    p_org_id uuid, p_start_date date, p_end_date date
) IS
'Org cycle usage used for billing. Intentionally unions deleted_apps '
'(kept 35 days by delete_old_deleted_apps) with live apps for MAU, '
'bandwidth and build time: deleting and recreating an app, or reusing an '
'app_id, cannot reset usage inside a billing cycle. Anti-fraud behavior, '
'do not remove.';

COMMENT ON FUNCTION public.delete_old_deleted_apps() IS
'Purges deleted_apps rows older than 35 days and the daily_build_time, '
'daily_mau and daily_bandwidth rows of those app_ids when the app_id is '
'not live and not retained by another deleted_apps row. Until then the '
'usage stays billable through calculate_org_metrics_cache_entry.';
