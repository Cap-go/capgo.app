BEGIN;
SELECT plan(3);

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
  'stripe_info trial_at updates wake sync_trial_plan_schedule'
);

SELECT * FROM finish();
ROLLBACK;
