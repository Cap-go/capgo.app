BEGIN;

SELECT plan(8);

SELECT is(
  (SELECT native_build_queue_priority FROM public.plans WHERE name = 'Solo'),
  10,
  'Solo native build queue priority'
);

SELECT is(
  (SELECT native_build_queue_priority FROM public.plans WHERE name = 'Maker'),
  20,
  'Maker native build queue priority'
);

SELECT is(
  (SELECT native_build_queue_priority FROM public.plans WHERE name = 'Team'),
  40,
  'Team native build queue priority'
);

SELECT is(
  (SELECT native_build_queue_priority FROM public.plans WHERE name = 'Enterprise'),
  100,
  'Enterprise native build queue priority'
);

SELECT is(
  public.native_build_queue_tier_from_priority(10),
  'standard',
  'tier mapping standard'
);

SELECT is(
  public.native_build_effective_queue_priority(10, pg_catalog.now() - interval '10 minutes'),
  12,
  'effective priority includes aging bonus'
);

SELECT is(
  public.native_build_effective_queue_priority(10, pg_catalog.now() - interval '2 days'),
  100,
  'effective priority caps aging bonus'
);

SELECT is(
  (
    SELECT native_build_queue_priority
    FROM public.get_current_plan_max_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d')
    LIMIT 1
  ),
  (
    SELECT p.native_build_queue_priority
    FROM public.orgs o
    JOIN public.stripe_info si ON o.customer_id = si.customer_id
    JOIN public.plans p ON si.product_id = p.stripe_id
    WHERE o.id = '22dbad8a-b885-4309-9b3b-a09f8460fb6d'
    LIMIT 1
  ),
  'get_current_plan_max_org returns native build queue priority'
);

SELECT *
FROM finish();

ROLLBACK;
