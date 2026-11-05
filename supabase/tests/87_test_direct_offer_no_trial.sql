-- Direct-offer (paid ads) signups get no free trial on their org.
BEGIN;

SELECT plan(7);

SELECT tests.create_supabase_user('direct_offer_creator', 'direct-offer-creator@test.local');
SELECT tests.create_supabase_user('standard_trial_creator', 'standard-trial-creator@test.local');
SELECT tests.create_supabase_user('other_offer_creator', 'other-offer-creator@test.local');
-- The offer is user-writable in raw_user_meta_data, so only raw_app_meta_data counts.
SELECT tests.create_supabase_user('user_meta_offer_creator', 'user-meta-offer-creator@test.local', NULL, '{"offer": "direct"}'::jsonb);

-- /auth/register stores the offer in server-controlled app metadata.
UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"offer": "direct"}'::jsonb
WHERE id = tests.get_supabase_uid('direct_offer_creator');
UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"offer": "Direct "}'::jsonb
WHERE id = tests.get_supabase_uid('other_offer_creator');

SELECT tests.authenticate_as_service_role();

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (tests.get_supabase_uid('direct_offer_creator'), 'direct-offer-creator@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('standard_trial_creator'), 'standard-trial-creator@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('other_offer_creator'), 'other-offer-creator@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('user_meta_offer_creator'), 'user-meta-offer-creator@test.local', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES
  ('86000000-0000-4000-8000-000000000001', tests.get_supabase_uid('direct_offer_creator'), 'Direct offer org', 'direct-offer-creator@test.local'),
  ('86000000-0000-4000-8000-000000000002', tests.get_supabase_uid('standard_trial_creator'), 'Standard trial org', 'standard-trial-creator@test.local'),
  ('86000000-0000-4000-8000-000000000003', tests.get_supabase_uid('other_offer_creator'), 'Other offer org', 'other-offer-creator@test.local'),
  ('86000000-0000-4000-8000-000000000004', tests.get_supabase_uid('user_meta_offer_creator'), 'User metadata offer org', 'user-meta-offer-creator@test.local');

SELECT is(
  (SELECT customer_id FROM public.orgs WHERE id = '86000000-0000-4000-8000-000000000001'),
  'pending_86000000-0000-4000-8000-000000000001',
  'direct offer org gets a pending stripe_info row'
);

SELECT ok(
  (
    SELECT si.trial_at BETWEEN NOW() - INTERVAL '1 minute' AND NOW() + INTERVAL '1 minute'
    FROM public.orgs o
    JOIN public.stripe_info si ON si.customer_id = o.customer_id
    WHERE o.id = '86000000-0000-4000-8000-000000000001'
  ),
  'creator with app metadata offer=direct gets trial_at = now (no trial)'
);

SELECT ok(
  (
    SELECT NOT (si.trial_at::date > CURRENT_DATE)
    FROM public.orgs o
    JOIN public.stripe_info si ON si.customer_id = o.customer_id
    WHERE o.id = '86000000-0000-4000-8000-000000000001'
  ),
  'direct offer org is not inside a trial window'
);

SELECT ok(
  (
    SELECT si.trial_at BETWEEN NOW() + INTERVAL '15 days' - INTERVAL '1 minute' AND NOW() + INTERVAL '15 days' + INTERVAL '1 minute'
    FROM public.orgs o
    JOIN public.stripe_info si ON si.customer_id = o.customer_id
    WHERE o.id = '86000000-0000-4000-8000-000000000002'
  ),
  'creator without offer keeps the 15-day trial'
);

SELECT ok(
  (
    SELECT si.trial_at BETWEEN NOW() + INTERVAL '15 days' - INTERVAL '1 minute' AND NOW() + INTERVAL '15 days' + INTERVAL '1 minute'
    FROM public.orgs o
    JOIN public.stripe_info si ON si.customer_id = o.customer_id
    WHERE o.id = '86000000-0000-4000-8000-000000000003'
  ),
  'only the literal offer value direct removes the trial'
);

SELECT ok(
  (
    SELECT si.trial_at::date > CURRENT_DATE
    FROM public.orgs o
    JOIN public.stripe_info si ON si.customer_id = o.customer_id
    WHERE o.id = '86000000-0000-4000-8000-000000000002'
  ),
  'standard org is inside its trial window'
);

SELECT ok(
  (
    SELECT si.trial_at BETWEEN NOW() + INTERVAL '15 days' - INTERVAL '1 minute' AND NOW() + INTERVAL '15 days' + INTERVAL '1 minute'
    FROM public.orgs o
    JOIN public.stripe_info si ON si.customer_id = o.customer_id
    WHERE o.id = '86000000-0000-4000-8000-000000000004'
  ),
  'user-writable user metadata offer=direct is ignored'
);

SELECT * FROM finish();

ROLLBACK;
