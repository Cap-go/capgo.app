BEGIN;

SELECT plan(4);

SELECT is(
  (SELECT observe_events FROM public.plans WHERE name = 'Solo'),
  500000::bigint,
  'Solo includes 500000 observe events per cycle'
);

SELECT is(
  (SELECT observe_events FROM public.plans WHERE name = 'Maker'),
  3000000::bigint,
  'Maker includes 3000000 observe events per cycle'
);

SELECT is(
  (SELECT observe_events FROM public.plans WHERE name = 'Team'),
  20000000::bigint,
  'Team includes 20000000 observe events per cycle'
);

SELECT is(
  (SELECT observe_events FROM public.plans WHERE name = 'Enterprise'),
  600000000::bigint,
  'Enterprise includes 600000000 observe events per cycle'
);

SELECT * FROM finish();

ROLLBACK;
