BEGIN;

SELECT plan(21);

SELECT tests.authenticate_as_service_role();

SELECT ok(
  to_regprocedure('public.soft_delete_versions_for_long_canceled_orgs(integer)') IS NOT NULL,
  'soft_delete_versions_for_long_canceled_orgs exists'
);

SELECT ok(
  to_regprocedure(
    'public.cleanup_audit_logs_for_long_canceled_orgs(integer, integer, integer)'
  ) IS NOT NULL,
  'cleanup_audit_logs_for_long_canceled_orgs exists'
);

SELECT ok(
  to_regprocedure('public.cleanup_long_canceled_org_data()') IS NOT NULL,
  'cleanup_long_canceled_org_data exists'
);

SELECT is(
  has_function_privilege(
    'anon',
    'public.cleanup_long_canceled_org_data()',
    'EXECUTE'
  ),
  false,
  'anon cannot execute cleanup_long_canceled_org_data'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.cleanup_long_canceled_org_data()',
    'EXECUTE'
  ),
  false,
  'authenticated cannot execute cleanup_long_canceled_org_data'
);

SELECT is(
  has_function_privilege(
    'service_role',
    'public.cleanup_long_canceled_org_data()',
    'EXECUTE'
  ),
  true,
  'service_role can execute cleanup_long_canceled_org_data'
);

SELECT ok(
  (
    SELECT count(*)::int
    FROM public.cron_tasks
    WHERE name = 'canceled_org_version_cleanup'
      AND enabled = true
      AND task_type = 'function'::public.cron_task_type
      AND target = 'public.cleanup_long_canceled_org_data()'
      AND run_at_hour = 3
      AND run_at_minute = 20
  ) = 1,
  'cron_tasks points canceled_org_version_cleanup at cleanup_long_canceled_org_data'
);

-- Dedicated fixtures (unique customer/app ids for parallel safety)
CREATE TEMP TABLE canceled_cleanup_ctx AS
SELECT
  'a0c1e2f3-1111-4aaa-8bbb-000000000001'::uuid AS long_canceled_org,
  'a0c1e2f3-1111-4aaa-8bbb-000000000002'::uuid AS recent_canceled_org,
  'a0c1e2f3-1111-4aaa-8bbb-000000000003'::uuid AS trial_org,
  'a0c1e2f3-1111-4aaa-8bbb-000000000004'::uuid AS paying_org,
  'cus_canceled_cleanup_long'::varchar AS long_customer,
  'cus_canceled_cleanup_recent'::varchar AS recent_customer,
  'cus_canceled_cleanup_trial'::varchar AS trial_customer,
  'cus_canceled_cleanup_paying'::varchar AS paying_customer,
  'com.test.canceled.cleanup.long'::varchar AS long_app,
  'com.test.canceled.cleanup.recent'::varchar AS recent_app,
  'com.test.canceled.cleanup.trial'::varchar AS trial_app,
  'com.test.canceled.cleanup.paying'::varchar AS paying_app,
  '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid AS user_id,
  'prod_LQIregjtNduh4q'::varchar AS product_id;

INSERT INTO public.stripe_info (
  customer_id,
  status,
  product_id,
  trial_at,
  is_good_plan,
  subscription_anchor_start,
  subscription_anchor_end,
  canceled_at
)
SELECT
  long_customer,
  'canceled'::public.stripe_status,
  product_id,
  now() - interval '200 days',
  false,
  now() - interval '200 days',
  now() - interval '100 days',
  now() - interval '100 days'
FROM canceled_cleanup_ctx
UNION ALL
SELECT
  recent_customer,
  'canceled'::public.stripe_status,
  product_id,
  now() - interval '40 days',
  false,
  now() - interval '40 days',
  now() - interval '10 days',
  now() - interval '10 days'
FROM canceled_cleanup_ctx
UNION ALL
SELECT
  trial_customer,
  NULL::public.stripe_status,
  product_id,
  now() - interval '1 day',
  true,
  now() - interval '16 days',
  now() + interval '14 days',
  NULL::timestamptz
FROM canceled_cleanup_ctx
UNION ALL
SELECT
  paying_customer,
  'succeeded'::public.stripe_status,
  product_id,
  now() - interval '200 days',
  true,
  now() - interval '20 days',
  now() + interval '10 days',
  NULL::timestamptz
FROM canceled_cleanup_ctx;

INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
SELECT long_canceled_org, user_id, 'Long Canceled Cleanup Org', 'canceled-long@test.local', long_customer
FROM canceled_cleanup_ctx
UNION ALL
SELECT recent_canceled_org, user_id, 'Recent Canceled Cleanup Org', 'canceled-recent@test.local', recent_customer
FROM canceled_cleanup_ctx
UNION ALL
SELECT trial_org, user_id, 'Expired Trial Cleanup Org', 'canceled-trial@test.local', trial_customer
FROM canceled_cleanup_ctx
UNION ALL
SELECT paying_org, user_id, 'Paying Cleanup Org', 'canceled-paying@test.local', paying_customer
FROM canceled_cleanup_ctx;

INSERT INTO public.apps (app_id, icon_url, owner_org, name, user_id)
SELECT long_app, '', long_canceled_org, 'Long Canceled App', user_id FROM canceled_cleanup_ctx
UNION ALL
SELECT recent_app, '', recent_canceled_org, 'Recent Canceled App', user_id FROM canceled_cleanup_ctx
UNION ALL
SELECT trial_app, '', trial_org, 'Trial App', user_id FROM canceled_cleanup_ctx
UNION ALL
SELECT paying_app, '', paying_org, 'Paying App', user_id FROM canceled_cleanup_ctx;

INSERT INTO public.app_versions (id, app_id, name, storage_provider, owner_org, user_id, deleted)
SELECT 970101, long_app, '1.0.0', 'r2', long_canceled_org, user_id, false FROM canceled_cleanup_ctx
UNION ALL
SELECT 970102, long_app, '1.0.1-linked', 'r2', long_canceled_org, user_id, false FROM canceled_cleanup_ctx
UNION ALL
SELECT 970103, long_app, 'builtin', 'r2', long_canceled_org, user_id, false FROM canceled_cleanup_ctx
UNION ALL
SELECT 970201, recent_app, '1.0.0', 'r2', recent_canceled_org, user_id, false FROM canceled_cleanup_ctx
UNION ALL
SELECT 970301, trial_app, '1.0.0', 'r2', trial_org, user_id, false FROM canceled_cleanup_ctx
UNION ALL
SELECT 970401, paying_app, '1.0.0', 'r2', paying_org, user_id, false FROM canceled_cleanup_ctx;

SELECT set_config('capgo.seed_channel_targets', 'true', true);

INSERT INTO public.channels (
  created_at, name, app_id, version, updated_at, public,
  disable_auto_update_under_native, disable_auto_update, ios, android,
  allow_device_self_set, allow_emulator, allow_device, allow_dev, allow_prod,
  created_by, owner_org
)
SELECT
  now(),
  'production',
  long_app,
  970102,
  now(),
  true,
  true,
  'major'::public.disable_update,
  false,
  true,
  true,
  true,
  true,
  true,
  true,
  user_id,
  long_canceled_org
FROM canceled_cleanup_ctx
UNION ALL
SELECT
  now(),
  'builtin-channel',
  long_app,
  970103,
  now(),
  false,
  true,
  'major'::public.disable_update,
  false,
  true,
  true,
  true,
  true,
  true,
  true,
  user_id,
  long_canceled_org
FROM canceled_cleanup_ctx;

-- Fresh audit rows (not age-expired) so only canceled-org cleanup removes them.
INSERT INTO public.audit_logs (
  created_at,
  table_name,
  record_id,
  operation,
  user_id,
  org_id,
  old_record,
  new_record,
  changed_fields
)
SELECT
  now() - interval '2 days',
  'canceled_org_cleanup_test',
  'audit-long-canceled',
  'UPDATE',
  user_id,
  long_canceled_org,
  '{}'::jsonb,
  '{}'::jsonb,
  ARRAY['canceled_org_cleanup']::text []
FROM canceled_cleanup_ctx
UNION ALL
SELECT
  now() - interval '2 days',
  'canceled_org_cleanup_test',
  'audit-recent-canceled',
  'UPDATE',
  user_id,
  recent_canceled_org,
  '{}'::jsonb,
  '{}'::jsonb,
  ARRAY['canceled_org_cleanup']::text []
FROM canceled_cleanup_ctx
UNION ALL
SELECT
  now() - interval '2 days',
  'canceled_org_cleanup_test',
  'audit-paying',
  'UPDATE',
  user_id,
  paying_org,
  '{}'::jsonb,
  '{}'::jsonb,
  ARRAY['canceled_org_cleanup']::text []
FROM canceled_cleanup_ctx;

-- Expired trial -> canceled
SELECT public.process_free_trial_expired();

SELECT is(
  (
    SELECT status::text
    FROM public.stripe_info
    WHERE customer_id = (SELECT trial_customer FROM canceled_cleanup_ctx)
  ),
  'canceled',
  'process_free_trial_expired sets expired trial status to canceled'
);

SELECT is(
  (
    SELECT is_good_plan
    FROM public.stripe_info
    WHERE customer_id = (SELECT trial_customer FROM canceled_cleanup_ctx)
  ),
  false,
  'process_free_trial_expired sets is_good_plan false for expired trial'
);

SELECT ok(
  (
    SELECT canceled_at = trial_at
    FROM public.stripe_info
    WHERE customer_id = (SELECT trial_customer FROM canceled_cleanup_ctx)
  ),
  'process_free_trial_expired sets canceled_at from trial_at'
);

SELECT is(
  (
    SELECT status::text
    FROM public.stripe_info
    WHERE customer_id = (SELECT paying_customer FROM canceled_cleanup_ctx)
  ),
  'succeeded',
  'process_free_trial_expired leaves paying orgs unchanged'
);

-- Full canceled-org cleanup (versions + audit logs)
SELECT public.cleanup_long_canceled_org_data();

SELECT is(
  (SELECT deleted FROM public.app_versions WHERE id = 970101),
  true,
  'long-canceled org version is soft-deleted after 90 days'
);

SELECT is(
  (SELECT deleted FROM public.app_versions WHERE id = 970102),
  true,
  'channel-linked version is soft-deleted after channel unlink'
);

SELECT is(
  (
    SELECT version
    FROM public.channels
    WHERE app_id = (SELECT long_app FROM canceled_cleanup_ctx)
      AND name = 'production'
  ),
  NULL::bigint,
  'channels targeting deletion candidates are unlinked'
);

SELECT is(
  (
    SELECT version
    FROM public.channels
    WHERE app_id = (SELECT long_app FROM canceled_cleanup_ctx)
      AND name = 'builtin-channel'
  ),
  970103::bigint,
  'channels targeting builtin versions are preserved'
);

SELECT is(
  (SELECT deleted FROM public.app_versions WHERE id = 970103),
  false,
  'builtin versions are never soft-deleted'
);

SELECT is(
  (SELECT deleted FROM public.app_versions WHERE id = 970201),
  false,
  'recently canceled org versions are kept within 90 days'
);

SELECT is(
  (SELECT deleted FROM public.app_versions WHERE id = 970401),
  false,
  'paying org versions are never soft-deleted by canceled cleanup'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.audit_logs
    WHERE table_name = 'canceled_org_cleanup_test'
      AND record_id = 'audit-long-canceled'
  ),
  0,
  'audit logs for long-canceled orgs are purged'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.audit_logs
    WHERE table_name = 'canceled_org_cleanup_test'
      AND record_id = 'audit-recent-canceled'
  ),
  1,
  'audit logs for recently canceled orgs are kept within 90 days'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.audit_logs
    WHERE table_name = 'canceled_org_cleanup_test'
      AND record_id = 'audit-paying'
  ),
  1,
  'audit logs for paying orgs are never purged by canceled cleanup'
);

SELECT tests.clear_authentication();

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
