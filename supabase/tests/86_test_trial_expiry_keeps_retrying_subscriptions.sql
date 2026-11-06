BEGIN;
SELECT plan(7);

INSERT INTO public.stripe_info (customer_id, status, product_id, trial_at, is_good_plan, subscription_id, past_due_at)
VALUES
  ('cus_trial_expiry_trial', NULL, 'prod_LQIregjtNduh4q', now() - interval '1 day', true, NULL, NULL),
  ('cus_trial_expiry_null_sub', NULL, 'prod_LQIregjtNduh4q', now() - interval '1 day', true, 'sub_trial_expiry_null_sub', NULL),
  ('cus_trial_expiry_retry', 'failed', 'prod_LQIregjtNduh4q', now() - interval '200 days', true, 'sub_trial_expiry_retry', now() - interval '2 days'),
  ('cus_trial_expiry_nosub', 'failed', 'prod_LQIregjtNduh4q', now() - interval '1 day', true, NULL, NULL),
  ('cus_trial_expiry_paying', 'succeeded', 'prod_LQIregjtNduh4q', now() - interval '200 days', true, 'sub_trial_expiry_paying', NULL);

SELECT public.process_free_trial_expired();

SELECT is(
  (SELECT status::text FROM public.stripe_info WHERE customer_id = 'cus_trial_expiry_trial'),
  'canceled',
  'expired never-converted trial is canceled'
);
SELECT is(
  (SELECT status::text FROM public.stripe_info WHERE customer_id = 'cus_trial_expiry_null_sub'),
  'canceled',
  'expired trial with a NULL status and a subscription id is still canceled'
);
SELECT is(
  (SELECT status::text FROM public.stripe_info WHERE customer_id = 'cus_trial_expiry_retry'),
  'failed',
  'past-due subscription Stripe is still retrying is not canceled'
);
SELECT is(
  (SELECT canceled_at FROM public.stripe_info WHERE customer_id = 'cus_trial_expiry_retry'),
  NULL,
  'past-due subscription keeps canceled_at empty'
);
SELECT is(
  (SELECT is_good_plan FROM public.stripe_info WHERE customer_id = 'cus_trial_expiry_retry'),
  true,
  'past-due subscription is left untouched'
);
SELECT is(
  (SELECT status::text FROM public.stripe_info WHERE customer_id = 'cus_trial_expiry_nosub'),
  'canceled',
  'failed status without a subscription is still canceled'
);
SELECT is(
  (SELECT status::text FROM public.stripe_info WHERE customer_id = 'cus_trial_expiry_paying'),
  'succeeded',
  'paying org is unchanged'
);

SELECT finish();
ROLLBACK;
