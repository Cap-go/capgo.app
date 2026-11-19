BEGIN;
SELECT plan(10);

SELECT has_function(
  'public',
  'wake_sync_trial_plan_schedule',
  ARRAY['text', 'timestamptz'],
  'wake_sync_trial_plan_schedule exists'
);

SELECT has_function(
  'public',
  'trigger_sync_trial_plan_schedule_on_trial_at_change',
  ARRAY[]::text[],
  'trial_at change trigger function exists'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege(
    'anon',
    'public.wake_sync_trial_plan_schedule(text, timestamptz)',
    'EXECUTE'
  ),
  'anon cannot execute wake_sync_trial_plan_schedule'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.wake_sync_trial_plan_schedule(text, timestamptz)',
    'EXECUTE'
  ),
  'authenticated cannot execute wake_sync_trial_plan_schedule'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege(
    'anon',
    'public.trigger_sync_trial_plan_schedule_on_trial_at_change()',
    'EXECUTE'
  ),
  'anon cannot execute trigger_sync_trial_plan_schedule_on_trial_at_change'
);

SELECT ok(
  NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.trigger_sync_trial_plan_schedule_on_trial_at_change()',
    'EXECUTE'
  ),
  'authenticated cannot execute trigger_sync_trial_plan_schedule_on_trial_at_change'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.stripe_info'::regclass
      AND tgname = 'sync_trial_plan_schedule_on_stripe_info_trial_at'
      AND NOT tgisinternal
  ),
  'sync_trial_plan_schedule_on_stripe_info_trial_at trigger exists on stripe_info'
);

INSERT INTO public.stripe_info (
  customer_id, status, product_id, trial_at, is_good_plan
) VALUES (
  'cus_test_sync_trial_plan_schedule',
  NULL,
  'prod_LQIregjtNduh4q',
  pg_catalog.now() + interval '14 days',
  true
);

SELECT pgmq.purge_queue('sync_trial_plan_schedule');

SELECT public.wake_sync_trial_plan_schedule(
  'cus_test_sync_trial_plan_schedule',
  pg_catalog.now() + interval '21 days'
);

SELECT is(
  (
    SELECT count(*)::bigint
    FROM pgmq.q_sync_trial_plan_schedule
    WHERE message -> 'payload' ->> 'customerId' = 'cus_test_sync_trial_plan_schedule'
  ),
  1::bigint,
  'wake_sync_trial_plan_schedule enqueues one sync_trial_plan_schedule job'
);

SELECT pgmq.purge_queue('sync_trial_plan_schedule');

UPDATE public.stripe_info
SET trial_at = trial_at + interval '7 days'
WHERE customer_id = 'cus_test_sync_trial_plan_schedule';

SELECT is(
  (
    SELECT count(*)::bigint
    FROM pgmq.q_sync_trial_plan_schedule
    WHERE message -> 'payload' ->> 'customerId' = 'cus_test_sync_trial_plan_schedule'
  ),
  1::bigint,
  'updating trial_at enqueues sync work'
);

SELECT pgmq.purge_queue('sync_trial_plan_schedule');

UPDATE public.stripe_info
SET trial_at = trial_at
WHERE customer_id = 'cus_test_sync_trial_plan_schedule';

SELECT is(
  (
    SELECT count(*)::bigint FROM pgmq.q_sync_trial_plan_schedule
  ),
  0::bigint,
  'setting trial_at to the same value does not enqueue sync work'
);

SELECT * FROM finish();
ROLLBACK;
