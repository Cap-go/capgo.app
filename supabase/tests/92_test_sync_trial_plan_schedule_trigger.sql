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

SELECT lives_ok(
  $$SELECT public.wake_sync_trial_plan_schedule(
    'cus_Q38uE91NP8Ufqc',
    pg_catalog.now() + interval '14 days'
  )$$,
  'wake_sync_trial_plan_schedule enqueues sync work without error'
);

SELECT * FROM finish();
ROLLBACK;
