BEGIN;
SELECT plan(4);

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
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.stripe_info'::regclass
      AND tgname = 'sync_trial_plan_schedule_on_stripe_info_trial_at'
      AND NOT tgisinternal
  ),
  'sync_trial_plan_schedule_on_stripe_info_trial_at trigger exists on stripe_info'
);

SELECT pgmq.purge_queue('sync_trial_plan_schedule');

SELECT public.wake_sync_trial_plan_schedule(
  'cus_Q38uE91NP8Ufqc',
  pg_catalog.now() + interval '14 days'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pgmq.q_sync_trial_plan_schedule q
    WHERE q.message->>'function_name' = 'sync_trial_plan_schedule'
      AND q.message->'payload'->>'customerId' = 'cus_Q38uE91NP8Ufqc'
  ),
  'wake_sync_trial_plan_schedule enqueues sync_trial_plan_schedule with customerId'
);

SELECT * FROM finish();
ROLLBACK;
