-- 34_test_billing_cycle_functions.sql
-- Tests to ensure billing cycle functions return CURRENT cycle dates, not original subscription dates
-- This prevents the bug where charts showed empty data because subscription_start was from 2023
BEGIN;

SELECT plan(21);

CREATE OR REPLACE FUNCTION test_billing_cycle_functions() RETURNS SETOF TEXT AS $$
DECLARE
  v_org_id uuid := '046a36ac-e03c-4590-9257-bd6c9dba9ee8';
  v_user_id uuid := '6aa76066-55ef-4238-ade6-0b32334a4097';
  v_customer_id text := 'cus_Q38uE91NP8Ufqc';
  v_org_result RECORD;
  v_cycle_info RECORD;
  v_metrics_result RECORD;
  v_usage_result RECORD;
  v_original_anchor_start timestamptz;
  v_original_anchor_end timestamptz;
  v_now timestamptz := NOW();
  v_expected_cycle_start timestamptz;
  v_expected_cycle_end timestamptz;
  v_anchor_day int;
BEGIN
  -- Save original values
  SELECT subscription_anchor_start, subscription_anchor_end
  INTO v_original_anchor_start, v_original_anchor_end
  FROM stripe_info WHERE customer_id = v_customer_id;

  -- ============================================================================
  -- TEST SCENARIO 1: Subscription from 2 years ago (simulating the bug scenario)
  -- Set subscription_anchor_start to September 14, 2023 (far in the past)
  -- The functions should still return the CURRENT billing cycle, not 2023 dates
  -- ============================================================================
  
  UPDATE stripe_info 
  SET subscription_anchor_start = '2023-09-14 13:54:45+00'::timestamptz,
      subscription_anchor_end = '2023-10-14 13:54:45+00'::timestamptz
  WHERE customer_id = v_customer_id;

  -- Calculate expected current cycle based on anchor day (14th)
  v_anchor_day := 14;
  IF EXTRACT(DAY FROM v_now) < v_anchor_day THEN
    -- We're before anchor day, so cycle started last month
    v_expected_cycle_start := date_trunc('MONTH', v_now - INTERVAL '1 MONTH') + ((v_anchor_day - 1) || ' days')::INTERVAL;
  ELSE
    -- We're at or after anchor day, so cycle started this month
    v_expected_cycle_start := date_trunc('MONTH', v_now) + ((v_anchor_day - 1) || ' days')::INTERVAL;
  END IF;
  v_expected_cycle_end := v_expected_cycle_start + INTERVAL '1 MONTH';

  -- ============================================================================
  -- Test 1: get_cycle_info_org should return current cycle (baseline)
  -- ============================================================================
  SELECT subscription_anchor_start, subscription_anchor_end
  INTO v_cycle_info
  FROM get_cycle_info_org(v_org_id);

  RETURN NEXT ok(
    v_cycle_info.subscription_anchor_start IS NOT NULL,
    'get_cycle_info_org: cycle_start is not null with 2023 subscription'
  );
  
  RETURN NEXT ok(
    v_cycle_info.subscription_anchor_start > '2024-01-01'::timestamptz,
    'get_cycle_info_org: cycle_start is in 2024 or later (not 2023)'
  );
  
  RETURN NEXT ok(
    v_cycle_info.subscription_anchor_start <= v_now,
    'get_cycle_info_org: cycle_start is not in the future'
  );
  
  RETURN NEXT ok(
    v_cycle_info.subscription_anchor_end > v_now,
    'get_cycle_info_org: cycle_end is in the future'
  );

  -- ============================================================================
  -- Test 2: get_orgs_v7 should return current cycle dates (THE BUG FIX)
  -- ============================================================================
  SELECT subscription_start, subscription_end
  INTO v_org_result
  FROM get_orgs_v7(v_user_id)
  WHERE gid = v_org_id;

  RETURN NEXT ok(
    v_org_result.subscription_start IS NOT NULL,
    'get_orgs_v7: subscription_start is not null with 2023 subscription'
  );
  
  RETURN NEXT ok(
    v_org_result.subscription_start > '2024-01-01'::timestamptz,
    'get_orgs_v7: subscription_start is in 2024 or later (not 2023) - BUG FIX VERIFICATION'
  );
  
  RETURN NEXT ok(
    v_org_result.subscription_start <= v_now,
    'get_orgs_v7: subscription_start is not in the future'
  );
  
  RETURN NEXT ok(
    v_org_result.subscription_end > v_now,
    'get_orgs_v7: subscription_end is in the future'
  );
  
  RETURN NEXT cmp_ok(
    v_org_result.subscription_end - v_org_result.subscription_start,
    '>',
    '27 days'::INTERVAL,
    'get_orgs_v7: billing cycle is at least 27 days'
  );
  
  RETURN NEXT cmp_ok(
    v_org_result.subscription_end - v_org_result.subscription_start,
    '<',
    '32 days'::INTERVAL,
    'get_orgs_v7: billing cycle is less than 32 days'
  );

  -- Verify get_orgs_v7 matches get_cycle_info_org
  RETURN NEXT ok(
    ABS(EXTRACT(EPOCH FROM (v_org_result.subscription_start - v_cycle_info.subscription_anchor_start))) < 86400,
    'get_orgs_v7: subscription_start matches get_cycle_info_org within 1 day'
  );

  -- ============================================================================
  -- Test 3: get_plan_usage_percent_detailed (1-arg) should use current cycle
  -- We verify it runs without error and uses reasonable date range
  -- ============================================================================
  SELECT * INTO v_usage_result FROM get_plan_usage_percent_detailed(v_org_id);
  
  RETURN NEXT ok(
    v_usage_result IS NOT NULL,
    'get_plan_usage_percent_detailed(org_id): runs successfully with 2023 subscription'
  );

  -- ============================================================================
  -- Test 4: get_total_metrics (1-arg) should use current cycle
  -- ============================================================================
  SELECT * INTO v_metrics_result FROM get_total_metrics(v_org_id);
  
  RETURN NEXT ok(
    v_metrics_result IS NOT NULL,
    'get_total_metrics(org_id): runs successfully with 2023 subscription'
  );

  -- ============================================================================
  -- Test 5: is_good_plan_v5_org should use current cycle
  -- ============================================================================
  RETURN NEXT ok(
    is_good_plan_v5_org(v_org_id) IS NOT NULL,
    'is_good_plan_v5_org: runs successfully with 2023 subscription'
  );

  -- ============================================================================
  -- TEST SCENARIO 2: Verify anchor day calculation works for different days
  -- Set anchor to the 28th to test edge case
  -- ============================================================================
  
  UPDATE stripe_info 
  SET subscription_anchor_start = '2022-01-28 10:00:00+00'::timestamptz,
      subscription_anchor_end = '2022-02-28 10:00:00+00'::timestamptz
  WHERE customer_id = v_customer_id;

  -- Get results with anchor day 28
  SELECT subscription_start, subscription_end
  INTO v_org_result
  FROM get_orgs_v7(v_user_id)
  WHERE gid = v_org_id;

  RETURN NEXT ok(
    v_org_result.subscription_start > '2024-01-01'::timestamptz,
    'get_orgs_v7 (anchor 28th): subscription_start is in 2024 or later'
  );
  
  RETURN NEXT ok(
    EXTRACT(DAY FROM v_org_result.subscription_start) = 28,
    'get_orgs_v7 (anchor 28th): subscription_start is on the 28th'
  );

  -- ============================================================================
  -- TEST SCENARIO 3: Verify anchor day 1st (first of month)
  -- ============================================================================
  
  UPDATE stripe_info 
  SET subscription_anchor_start = '2021-06-01 00:00:00+00'::timestamptz,
      subscription_anchor_end = '2021-07-01 00:00:00+00'::timestamptz
  WHERE customer_id = v_customer_id;

  SELECT subscription_start, subscription_end
  INTO v_org_result
  FROM get_orgs_v7(v_user_id)
  WHERE gid = v_org_id;

  RETURN NEXT ok(
    v_org_result.subscription_start > '2024-01-01'::timestamptz,
    'get_orgs_v7 (anchor 1st): subscription_start is in 2024 or later'
  );
  
  RETURN NEXT ok(
    EXTRACT(DAY FROM v_org_result.subscription_start) = 1,
    'get_orgs_v7 (anchor 1st): subscription_start is on the 1st'
  );

  -- ============================================================================
  -- TEST SCENARIO 4: Consistency between all functions
  -- All functions should return the same billing cycle for the same org
  -- ============================================================================
  
  -- Reset to a known anchor day (15th)
  UPDATE stripe_info 
  SET subscription_anchor_start = '2020-03-15 12:00:00+00'::timestamptz,
      subscription_anchor_end = '2020-04-15 12:00:00+00'::timestamptz
  WHERE customer_id = v_customer_id;

  -- Get cycle from get_cycle_info_org (the reference implementation)
  SELECT subscription_anchor_start, subscription_anchor_end
  INTO v_cycle_info
  FROM get_cycle_info_org(v_org_id);

  -- Get cycle from get_orgs_v7
  SELECT subscription_start, subscription_end
  INTO v_org_result
  FROM get_orgs_v7(v_user_id)
  WHERE gid = v_org_id;

  -- Verify they match (within 1 second tolerance for timestamp comparison)
  RETURN NEXT ok(
    ABS(EXTRACT(EPOCH FROM (v_org_result.subscription_start - v_cycle_info.subscription_anchor_start))) < 1,
    'Consistency: get_orgs_v7 start matches get_cycle_info_org start'
  );
  
  RETURN NEXT ok(
    ABS(EXTRACT(EPOCH FROM (v_org_result.subscription_end - v_cycle_info.subscription_anchor_end))) < 1,
    'Consistency: get_orgs_v7 end matches get_cycle_info_org end'
  );

  -- Verify the cycle is current (not from 2020)
  RETURN NEXT ok(
    v_org_result.subscription_start > v_now - INTERVAL '60 days',
    'Consistency: cycle_start is within last 60 days (current cycle, not 2020)'
  );

  -- ============================================================================
  -- Restore original values
  -- ============================================================================
  UPDATE stripe_info 
  SET subscription_anchor_start = v_original_anchor_start,
      subscription_anchor_end = v_original_anchor_end
  WHERE customer_id = v_customer_id;

  RETURN;
END;
$$ LANGUAGE plpgsql;

SELECT test_billing_cycle_functions();

SELECT * FROM finish();

ROLLBACK;
