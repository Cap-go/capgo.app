BEGIN;

SELECT plan(11);

-- A user with no membership in the org, for the permission check.
SELECT tests.create_supabase_user('legacy_price_outsider', 'legacy-price-outsider@example.com');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (tests.get_supabase_uid('legacy_price_outsider'), 'legacy-price-outsider@example.com', now(), now())
ON CONFLICT (id) DO NOTHING;

-- A replaced Solo price still billed on an existing subscription (seed org of test_user).
UPDATE public.plans
SET alt_price_m_ids = ARRAY['price_legacy_solo_m'],
  alt_price_y_ids = ARRAY['price_legacy_solo_y']
WHERE name = 'Solo';

-- Regional tier prices are copied into the alt arrays, and a replaced one stays there.
UPDATE public.plans
SET regional_price_ids = '{"p50": {"price_m_id": "price_p50_m", "price_y_id": "price_p50_y", "price_m_id_us": "price_p50_m_us"}}'::jsonb
WHERE name = 'Solo';

SELECT is(
  (SELECT alt_price_m_ids @> ARRAY['price_legacy_solo_m', 'price_p50_m', 'price_p50_m_us'] AND alt_price_y_ids @> ARRAY['price_legacy_solo_y', 'price_p50_y'] FROM public.plans WHERE name = 'Solo'),
  true,
  'regional tier prices are added to the alt price arrays'
);

UPDATE public.plans
SET regional_price_ids = '{"p50": {"price_m_id": "price_p50_m_v2"}}'::jsonb
WHERE name = 'Solo';

SELECT is(
  (SELECT alt_price_m_ids @> ARRAY['price_p50_m', 'price_p50_m_v2'] FROM public.plans WHERE name = 'Solo'),
  true,
  'a replaced regional price keeps counting as the plan'
);

SELECT throws_ok(
  $$UPDATE public.plans SET regional_price_ids = '[]'::jsonb WHERE name = 'Solo'$$,
  '23514',
  NULL,
  'regional_price_ids must be an object'
);

CREATE TEMP TABLE customer_counts_before AS
SELECT * FROM public.get_customer_counts();

UPDATE public.stripe_info
SET price_id = 'price_legacy_solo_y'
WHERE customer_id = 'cus_Q38uE91NP8Ufqc';

SELECT is(
  public.is_org_yearly('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  true,
  'is_org_yearly recognises a replaced yearly price'
);

SELECT is(
  (SELECT is_yearly FROM public.get_orgs_v7(tests.get_supabase_uid('test_user')) WHERE gid = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  true,
  'get_orgs_v7 reports a replaced yearly price as yearly'
);

SELECT is(
  (SELECT yearly FROM public.get_customer_counts()) - (SELECT yearly FROM customer_counts_before),
  1::bigint,
  'get_customer_counts counts a replaced yearly price as yearly'
);

UPDATE public.stripe_info
SET price_id = 'price_legacy_solo_m'
WHERE customer_id = 'cus_Q38uE91NP8Ufqc';

SELECT is(
  public.is_org_yearly('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  false,
  'is_org_yearly keeps a replaced monthly price monthly'
);

SELECT is(
  (SELECT monthly FROM public.get_customer_counts()) - (SELECT monthly FROM customer_counts_before),
  1::bigint,
  'get_customer_counts counts a replaced monthly price as monthly'
);

SELECT is(
  (SELECT is_yearly FROM public.get_orgs_v7(tests.get_supabase_uid('test_user')) WHERE gid = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  false,
  'get_orgs_v7 reports a replaced monthly price as monthly'
);

-- Billing permission still gates the answer: a member of another org learns nothing.
UPDATE public.stripe_info
SET price_id = 'price_legacy_solo_y'
WHERE customer_id = 'cus_Q38uE91NP8Ufqc';

SELECT tests.authenticate_as('test_user');

SELECT is(
  public.is_org_yearly('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  true,
  'the org owner sees the replaced yearly price as yearly'
);

SELECT tests.authenticate_as('legacy_price_outsider');

SELECT is(
  public.is_org_yearly('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
  false,
  'a user outside the org gets false'
);

SELECT tests.clear_authentication();

SELECT * FROM finish();

ROLLBACK;
