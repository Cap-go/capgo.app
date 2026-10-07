-- 08_plan_functions.sql
BEGIN;


-- + 2 is for the count(*)
-- -1 is for the pay as you go if statenent
SELECT
    plan(
        (
            (
                SELECT count(*)
                FROM
                    plans
                WHERE kind = 'full'
            )::integer * 13
        ) + 6
    );

CREATE OR REPLACE FUNCTION my_tests() RETURNS SETOF text AS $$
DECLARE
  plan RECORD;
  usage RECORD;
  total_metrics RECORD;
  mau_count bigint;
  bandwidth_count bigint;
BEGIN

  -- Ensure credits do not bypass plan action checks in this test file.
  UPDATE public.usage_credit_grants
  SET credits_consumed = credits_total
  WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';

  -- Test action_type checks
  UPDATE stripe_info 
  SET mau_exceeded = false, storage_exceeded = false, bandwidth_exceeded = false, 
      status = 'succeeded', is_good_plan = true,
      trial_at = NOW() - interval '1 year'
  WHERE customer_id = 'cus_Q38uE91NP8Ufqc';
  
  RETURN NEXT ok(
    is_paying_and_good_plan_org_action('046a36ac-e03c-4590-9257-bd6c9dba9ee8', ARRAY['mau']::action_type[]), 
    'Should allow mau action when no limits exceeded and good plan'
  );

  -- Test individual MAU limit
  UPDATE stripe_info 
  SET mau_exceeded = true, storage_exceeded = false, bandwidth_exceeded = false
  WHERE customer_id = 'cus_Q38uE91NP8Ufqc';
  
  RETURN NEXT ok(
    NOT is_paying_and_good_plan_org_action('046a36ac-e03c-4590-9257-bd6c9dba9ee8', ARRAY['mau']::action_type[]), 
    'Should block mau action when only mau exceeded'
  );

  -- Test individual Storage limit
  UPDATE stripe_info 
  SET mau_exceeded = false, storage_exceeded = true, bandwidth_exceeded = false
  WHERE customer_id = 'cus_Q38uE91NP8Ufqc';
  
  RETURN NEXT ok(
    NOT is_paying_and_good_plan_org_action('046a36ac-e03c-4590-9257-bd6c9dba9ee8', ARRAY['storage']::action_type[]), 
    'Should block storage action when only storage exceeded'
  );

  -- Test individual Bandwidth limit
  UPDATE stripe_info 
  SET mau_exceeded = false, storage_exceeded = false, bandwidth_exceeded = true
  WHERE customer_id = 'cus_Q38uE91NP8Ufqc';
  
  RETURN NEXT ok(
    NOT is_paying_and_good_plan_org_action('046a36ac-e03c-4590-9257-bd6c9dba9ee8', ARRAY['bandwidth']::action_type[]), 
    'Should block bandwidth action when only bandwidth exceeded'
  );

  UPDATE stripe_info 
  SET storage_exceeded = true, bandwidth_exceeded = true
  WHERE customer_id = 'cus_Q38uE91NP8Ufqc';
  
  RETURN NEXT ok(
    NOT is_paying_and_good_plan_org_action('046a36ac-e03c-4590-9257-bd6c9dba9ee8', ARRAY['mau', 'storage', 'bandwidth']::action_type[]), 
    'Should block all actions when all limits exceeded'
  );

  -- Test trial period
  UPDATE stripe_info 
  SET trial_at = NOW() + interval '1 day',
      mau_exceeded = true, storage_exceeded = true, bandwidth_exceeded = true,
      is_good_plan = false
  WHERE customer_id = 'cus_Q38uE91NP8Ufqc';
  
  RETURN NEXT ok(
    is_paying_and_good_plan_org_action('046a36ac-e03c-4590-9257-bd6c9dba9ee8', ARRAY['mau', 'storage', 'bandwidth']::action_type[]), 
    'Should allow all actions during trial period regardless of limits'
  );

  select count(*) from daily_mau where app_id='com.demo.app' into mau_count;
  RETURN NEXT ok(mau_count > 0, 'Demo app mau is > 0');

  select count(*) from daily_bandwidth where app_id='com.demo.app' into bandwidth_count;
  RETURN NEXT ok(bandwidth_count > 0, 'Demo app bandwidth is > 0');

  -- raise notice '%', mau_count;

  -- Website Live has no usage limits; these checks cover usage-based plans.
  FOR plan IN
    SELECT * FROM plans WHERE kind = 'full'
  LOOP
    -- Force demo app to have the given plan
    UPDATE stripe_info set product_id=plan.stripe_id where customer_id='cus_Q38uE91NP8Ufqc';
    UPDATE daily_mau set mau=floor((plan.mau - 1) / mau_count) where app_id='com.demo.app'; 
    UPDATE daily_bandwidth set bandwidth=floor((plan.bandwidth - convert_gb_to_bytes(0.5)) / bandwidth_count) where app_id='com.demo.app'; 

    TRUNCATE TABLE "public"."app_metrics_cache";
    SELECT * from get_plan_usage_percent_detailed('046a36ac-e03c-4590-9257-bd6c9dba9ee8') limit 1 into usage;

    RETURN NEXT ok(usage.mau_percent <= 100, format('Plan usage MAU is less than the limit for "%s" plan', plan.name));
    RETURN NEXT ok(usage.bandwidth_percent < 100, format('Plan usage BANDWIDTH is less than the limit for "%s" plan', plan.name));

    -- here we don't set storage but we do check it because we have to make sure is_good_plan will not fail due to storage
    RETURN NEXT ok(usage.storage_percent < 100, format('Plan usage STORAGE is less than the limit for "%s" plan', plan.name));

    TRUNCATE TABLE "public"."app_metrics_cache";
    SELECT * from get_total_metrics('046a36ac-e03c-4590-9257-bd6c9dba9ee8') INTO total_metrics;
    RETURN NEXT ok(total_metrics.mau > 0, format('Org total_metrics.mau > 0 for "%s" plan', plan.name));
    RETURN NEXT ok(total_metrics.bandwidth > 0, format('Org total_metrics.bandwidth > 0 for "%s" plan', plan.name));

    RETURN NEXT ok(
      (select * from find_fit_plan_v3(
        total_metrics.mau, 
        total_metrics.bandwidth, 
        total_metrics.storage) limit 1
      ) = plan.name, 
      format('find_fit_plan_v3 = "%s" plan', plan.name)
    );

    RETURN NEXT ok(is_good_plan_v5_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'), format('is_good_plan_v5_org for "%s" plan', plan.name));

    --
    --  Now let's make sure that the user is over the limit
    --
    UPDATE daily_mau set mau=floor((plan.mau - 1) / mau_count) * 1.5 where app_id='com.demo.app'; 
    UPDATE daily_bandwidth set bandwidth=floor((plan.bandwidth - convert_gb_to_bytes(0.5)) / bandwidth_count) * 1.5 where app_id='com.demo.app'; 

    TRUNCATE TABLE "public"."app_metrics_cache";
    SELECT * from get_plan_usage_percent_detailed('046a36ac-e03c-4590-9257-bd6c9dba9ee8') limit 1 into usage;

    RETURN NEXT ok(usage.mau_percent > 100, format('Plan usage MAU is more than the limit for "%s" plan', plan.name));
    RETURN NEXT ok(usage.bandwidth_percent > 100, format('Plan usage BANDWIDTH is more than the limit for "%s" plan', plan.name));

    TRUNCATE TABLE "public"."app_metrics_cache";
    SELECT * from get_total_metrics('046a36ac-e03c-4590-9257-bd6c9dba9ee8') INTO total_metrics;
    RETURN NEXT ok(total_metrics.mau > 0, format('Org total_metrics.mau > 0 for "%s" plan', plan.name));
    RETURN NEXT ok(total_metrics.bandwidth > 0, format('Org total_metrics.bandwidth > 0 for "%s" plan', plan.name));

    -- TODO test those fns for pay as you go
    IF plan.name IS DISTINCT FROM 'Enterprise' THEN
      RETURN NEXT ok(
        (select * from find_fit_plan_v3(
          total_metrics.mau, 
          total_metrics.bandwidth, 
          total_metrics.storage) limit 1
        ) != plan.name, 
        format('find_fit_plan_v3 NOT EQUAL "%s" plan', plan.name)
      );

      RETURN NEXT ok(is_good_plan_v5_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8') = false, format('is_good_plan_v5_org (NOT GOOD PLAN) for "%s" plan', plan.name));
    END IF;
  END LOOP;  
END;
$$ LANGUAGE plpgsql;

SELECT tests.authenticate_as_service_role();

SELECT my_tests();

SELECT *
FROM
    finish();

ROLLBACK;
