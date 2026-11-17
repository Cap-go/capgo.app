BEGIN;

-- -- + 2 is for the count(*)
-- -1 is for the pay as you go if statenent
SELECT plan(16);

-- Storage is billed in GB-hours: the plan includes plans.storage x hours-in-cycle
-- byte-hours, read from daily_storage_hourly. The bytes stored right now
-- (app_versions_meta) are not billed.
CREATE OR REPLACE FUNCTION my_tests() RETURNS SETOF TEXT AS $$
DECLARE
  plan RECORD;
  usage RECORD;
  v_org_id uuid := '046a36ac-e03c-4590-9257-bd6c9dba9ee8';
  v_cycle_start date;
  v_cycle_hours double precision;
BEGIN
  -- Remove all usage info for everyone
  TRUNCATE TABLE "public"."daily_mau" CASCADE;
  TRUNCATE TABLE "public"."daily_bandwidth" CASCADE;

  FOR plan IN
    SELECT * FROM plans
  LOOP
    TRUNCATE TABLE "public"."daily_storage_hourly";

    -- Force demo app to have the given plan
    UPDATE stripe_info set product_id=plan.stripe_id where customer_id='cus_Q38uE91NP8Ufqc';

    SELECT (cycle.cycle_start AT TIME ZONE 'UTC')::date,
      ((cycle.cycle_end AT TIME ZONE 'UTC')::date - (cycle.cycle_start AT TIME ZONE 'UTC')::date) * 24
    INTO v_cycle_start, v_cycle_hours
    FROM public.get_org_billing_cycle(v_org_id) AS cycle;

    -- Half the plan storage, stored for the whole cycle.
    INSERT INTO public.daily_storage_hourly (app_id, owner_org, date, storage_byte_hours)
    VALUES ('com.demo.app', v_org_id, v_cycle_start, FLOOR(plan.storage / 2) * v_cycle_hours);

    SELECT * from get_plan_usage_percent_detailed(v_org_id) limit 1 into usage;
    RETURN NEXT IS(usage.storage_percent, (SELECT CAST ('50' AS DOUBLE PRECISION)), format('Storage usage = 50%% for "%s" plan', plan.name));
    RETURN NEXT ok(is_good_plan_v5_org(v_org_id), format('is_good_plan_v5_org for "%s" plan', plan.name));

    -- Twice the plan storage for the whole cycle is blocked.
    UPDATE public.daily_storage_hourly
    SET storage_byte_hours = FLOOR(plan.storage * 2) * v_cycle_hours
    WHERE app_id = 'com.demo.app' AND date = v_cycle_start;

    SELECT * from get_plan_usage_percent_detailed(v_org_id) limit 1 into usage;
    RETURN NEXT IS(usage.storage_percent, (SELECT CAST ('200' AS DOUBLE PRECISION)), format('Storage usage = 200%% for "%s" plan', plan.name));

    -- Enterprise is no longer exempt: above its allowance it is blocked like every plan.
    RETURN NEXT ok(is_good_plan_v5_org(v_org_id) = false, format('(NOT) is_good_plan_v5_org for "%s" plan', plan.name));
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT my_tests();

SELECT *
FROM
    finish();

ROLLBACK;
