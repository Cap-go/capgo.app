BEGIN;

-- Storage and bandwidth are fair use on paid plans: going over the old plan
-- numbers is still reported as a percentage of that fair-use reference, but it
-- never makes the plan "not good", never counts toward total_percent and never
-- pushes the plan recommendation up.
-- 7 checks per plan + 2 recommendation checks.
SELECT plan(((SELECT count(*) FROM public.plans)::integer * 7) + 2);

CREATE OR REPLACE FUNCTION my_tests() RETURNS SETOF TEXT AS $$
DECLARE
  plan RECORD;
  usage RECORD;
  fit RECORD;
  smallest_plan text;
BEGIN
  -- Only storage and bandwidth usage: MAU and build time stay at zero.
  TRUNCATE TABLE "public"."daily_mau" CASCADE;
  TRUNCATE TABLE "public"."daily_bandwidth" CASCADE;
  TRUNCATE TABLE "public"."daily_build_time" CASCADE;

  FOR plan IN
    SELECT * FROM plans
  LOOP
    TRUNCATE TABLE "public"."app_versions_meta" CASCADE;
    TRUNCATE TABLE "public"."daily_bandwidth" CASCADE;

    -- Force demo app to have the given plan
    UPDATE stripe_info set product_id=plan.stripe_id where customer_id='cus_Q38uE91NP8Ufqc';

    -- let's divide the plan storage by half and put it.
    INSERT INTO "public"."app_versions_meta" ("created_at", "app_id", "updated_at", "checksum", "size", "id") VALUES
    (NOW(), 'com.demo.app', NOW(), '3885ee49', FLOOR(plan.storage / 2), 3);

    SELECT * from get_plan_usage_percent_detailed('046a36ac-e03c-4590-9257-bd6c9dba9ee8') limit 1 into usage;
    RETURN NEXT IS(usage.storage_percent, (SELECT CAST ('50' AS DOUBLE PRECISION)), format('Storage usage = 50%% for "%s" plan', plan.name));
    RETURN NEXT ok(is_good_plan_v5_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'), format('is_good_plan_v5_org for "%s" plan', plan.name));

    -- Storage at 200% of the fair-use reference stays a good plan.
    TRUNCATE TABLE "public"."app_versions_meta" CASCADE;
    INSERT INTO "public"."app_versions_meta" ("created_at", "app_id", "updated_at", "checksum", "size", "id") VALUES
    (NOW(), 'com.demo.app', NOW(), '3885ee49', FLOOR(plan.storage * 2), 3);

    SELECT * from get_plan_usage_percent_detailed('046a36ac-e03c-4590-9257-bd6c9dba9ee8') limit 1 into usage;
    RETURN NEXT IS(usage.storage_percent, (SELECT CAST ('200' AS DOUBLE PRECISION)), format('Storage usage = 200%% for "%s" plan', plan.name));
    RETURN NEXT IS(usage.total_percent, (SELECT CAST ('0' AS DOUBLE PRECISION)), format('Storage does not count toward total_percent for "%s" plan', plan.name));
    RETURN NEXT ok(is_good_plan_v5_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'), format('Storage over the reference keeps is_good_plan_v5_org for "%s" plan', plan.name));

    -- Bandwidth at 200% of the fair-use reference also stays a good plan.
    INSERT INTO "public"."daily_bandwidth" ("app_id", "date", "bandwidth") VALUES
    ('com.demo.app', CURRENT_DATE, plan.bandwidth * 2);

    RETURN NEXT ok(is_good_plan_v5_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'), format('Bandwidth over the reference keeps is_good_plan_v5_org for "%s" plan', plan.name));

    SELECT * FROM get_plan_usage_and_fit_uncached('046a36ac-e03c-4590-9257-bd6c9dba9ee8') LIMIT 1 INTO fit;
    RETURN NEXT ok(
      fit.is_good_plan AND fit.total_percent = 0 AND fit.bandwidth_percent >= 200 AND fit.storage_percent >= 200,
      format('get_plan_usage_and_fit_uncached ignores fair-use metrics for "%s" plan', plan.name)
    );
  END LOOP;

  SELECT name INTO smallest_plan FROM public.plans ORDER BY mau LIMIT 1;

  RETURN NEXT IS(
    find_best_plan_v3(1, (SELECT max(bandwidth) * 10 FROM public.plans)::double precision, (SELECT max(storage) * 10 FROM public.plans)::double precision, 0)::text,
    smallest_plan,
    'find_best_plan_v3 ignores storage and bandwidth'
  );
  RETURN NEXT IS(
    (SELECT name FROM find_fit_plan_v3(1, (SELECT max(bandwidth) * 10 FROM public.plans), (SELECT max(storage) * 10 FROM public.plans), 0) LIMIT 1)::text,
    smallest_plan,
    'find_fit_plan_v3 ignores storage and bandwidth'
  );
END;
$$ LANGUAGE plpgsql;

SELECT my_tests();

SELECT *
FROM
    finish();

ROLLBACK;
