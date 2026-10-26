BEGIN;

SELECT plan(8);

-- A user with no membership in the org, for the permission check.
SELECT tests.create_supabase_user('legacy_price_outsider', 'legacy-price-outsider@example.com');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (tests.get_supabase_uid('legacy_price_outsider'), 'legacy-price-outsider@example.com', now(), now())
ON CONFLICT (id) DO NOTHING;

-- A replaced Solo price still billed on an existing subscription (seed org of test_user).
UPDATE public.plans
SET legacy_price_m_ids = ARRAY['price_legacy_solo_m'],
  legacy_price_y_ids = ARRAY['price_legacy_solo_y']
WHERE name = 'Solo';

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
