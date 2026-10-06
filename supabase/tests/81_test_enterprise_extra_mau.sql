BEGIN;

SELECT plan(6);

-- Demo org on Enterprise with a small allowance so seeded MAU can cross it.
UPDATE public.plans SET mau = 1000 WHERE name = 'Enterprise';
UPDATE public.stripe_info
SET product_id = (SELECT stripe_id FROM public.plans WHERE name = 'Enterprise'), extra_mau = 0
WHERE customer_id = 'cus_Q38uE91NP8Ufqc';

TRUNCATE TABLE public.daily_mau CASCADE;
TRUNCATE TABLE public.daily_bandwidth CASCADE;
TRUNCATE TABLE public.app_versions_meta CASCADE;
INSERT INTO public.daily_mau (app_id, date, mau)
SELECT 'com.demo.app', (cycle.cycle_start AT TIME ZONE 'UTC')::date, 1500
FROM public.get_org_billing_cycle('046a36ac-e03c-4590-9257-bd6c9dba9ee8') AS cycle;
DELETE FROM public.org_metrics_cache WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';

SELECT is(
    (SELECT mau_percent FROM public.get_plan_usage_and_fit('046a36ac-e03c-4590-9257-bd6c9dba9ee8')),
    150::double precision,
    'Enterprise MAU percent uses the plan allowance'
);
SELECT ok(
    NOT (SELECT is_good_plan FROM public.get_plan_usage_and_fit('046a36ac-e03c-4590-9257-bd6c9dba9ee8')),
    'Enterprise above its allowance is not a good plan'
);
SELECT ok(
    NOT public.is_good_plan_v5_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
    'is_good_plan_v5_org: Enterprise above its allowance'
);

-- 1,000 extra MAU bought on the subscription: allowance becomes 2,000.
UPDATE public.stripe_info SET extra_mau = 1000 WHERE customer_id = 'cus_Q38uE91NP8Ufqc';
DELETE FROM public.org_metrics_cache WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8';

SELECT is(
    (SELECT mau_percent FROM public.get_plan_usage_percent_detailed('046a36ac-e03c-4590-9257-bd6c9dba9ee8')),
    75::double precision,
    'Extra MAU is part of the allowance'
);
SELECT ok(
    (SELECT is_good_plan FROM public.get_plan_usage_and_fit('046a36ac-e03c-4590-9257-bd6c9dba9ee8')),
    'Enterprise within plan + extra MAU is a good plan'
);
SELECT ok(
    public.is_good_plan_v5_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
    'is_good_plan_v5_org counts extra MAU'
);

SELECT * FROM finish();

ROLLBACK;
