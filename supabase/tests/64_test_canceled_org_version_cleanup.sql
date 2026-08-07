BEGIN;

SELECT plan(38);

SELECT tests.authenticate_as_service_role();

SELECT ok(
  to_regprocedure('public.long_canceled_org_ids()') IS NOT NULL,
  'long_canceled_org_ids exists'
);

SELECT ok(
  to_regprocedure('public.canceled_org_ids_past_grace(integer)') IS NOT NULL,
  'canceled_org_ids_past_grace exists'
);

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
  to_regprocedure('public.queue_canceled_org_retention_alerts(text, integer, integer)') IS NOT NULL,
  'queue_canceled_org_retention_alerts exists'
);

SELECT ok(
  to_regprocedure('public.delete_apps_for_long_canceled_orgs(integer)') IS NOT NULL,
  'delete_apps_for_long_canceled_orgs exists'
);

SELECT ok(
  to_regprocedure('public.cleanup_long_canceled_org_data()') IS NOT NULL,
  'cleanup_long_canceled_org_data exists'
);

SELECT ok(
  to_regclass('public.old_apps') IS NOT NULL,
  'old_apps table exists'
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

-- Fixtures + pgmq access need the default postgres role (service_role has no pgmq schema grants).
SELECT tests.clear_authentication();

-- Dedicated fixtures (unique customer/app ids for parallel safety)
-- long = 92d (past 90, before 95) for version soft-delete without app delete
-- warn85 = 87d for bundle-deletion warning queue
-- ultra = 100d (past 95) for app delete + old_apps archive
CREATE TEMP TABLE canceled_cleanup_ctx AS
SELECT
  'a0c1e2f3-1111-4aaa-8bbb-000000000001'::uuid AS long_canceled_org,
  'a0c1e2f3-1111-4aaa-8bbb-000000000002'::uuid AS recent_canceled_org,
  'a0c1e2f3-1111-4aaa-8bbb-000000000003'::uuid AS trial_org,
  'a0c1e2f3-1111-4aaa-8bbb-000000000004'::uuid AS paying_org,
  'a0c1e2f3-1111-4aaa-8bbb-000000000005'::uuid AS early_cancel_org,
  'a0c1e2f3-1111-4aaa-8bbb-000000000006'::uuid AS warn85_org,
  'a0c1e2f3-1111-4aaa-8bbb-000000000007'::uuid AS ultra_canceled_org,
  'cus_canceled_cleanup_long'::varchar AS long_customer,
  'cus_canceled_cleanup_recent'::varchar AS recent_customer,
  'cus_canceled_cleanup_trial'::varchar AS trial_customer,
  'cus_canceled_cleanup_paying'::varchar AS paying_customer,
  'cus_canceled_cleanup_early'::varchar AS early_customer,
  'cus_canceled_cleanup_warn85'::varchar AS warn85_customer,
  'cus_canceled_cleanup_ultra'::varchar AS ultra_customer,
  'com.test.canceled.cleanup.long'::varchar AS long_app,
  'com.test.canceled.cleanup.recent'::varchar AS recent_app,
  'com.test.canceled.cleanup.trial'::varchar AS trial_app,
  'com.test.canceled.cleanup.paying'::varchar AS paying_app,
  'com.test.canceled.cleanup.early'::varchar AS early_app,
  'com.test.canceled.cleanup.warn85'::varchar AS warn85_app,
  'com.test.canceled.cleanup.ultra'::varchar AS ultra_app,
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
  now() - interval '92 days',
  now() - interval '92 days'
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
FROM canceled_cleanup_ctx
UNION ALL
-- Cancel clicked early, but paid access ended recently (grace from period end).
SELECT
  early_customer,
  'canceled'::public.stripe_status,
  product_id,
  now() - interval '200 days',
  false,
  now() - interval '40 days',
  now() - interval '10 days',
  now() - interval '100 days'
FROM canceled_cleanup_ctx
UNION ALL
-- 87 days: past 85 bundle warning, before 90 soft-delete.
SELECT
  warn85_customer,
  'canceled'::public.stripe_status,
  product_id,
  now() - interval '200 days',
  false,
  now() - interval '200 days',
  now() - interval '87 days',
  now() - interval '87 days'
FROM canceled_cleanup_ctx
UNION ALL
-- 100 days: past 95 app-delete window.
SELECT
  ultra_customer,
  'canceled'::public.stripe_status,
  product_id,
  now() - interval '200 days',
  false,
  now() - interval '200 days',
  now() - interval '100 days',
  now() - interval '100 days'
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
FROM canceled_cleanup_ctx
UNION ALL
SELECT early_cancel_org, user_id, 'Early Cancel Cleanup Org', 'canceled-early@test.local', early_customer
FROM canceled_cleanup_ctx
UNION ALL
SELECT warn85_org, user_id, 'Warn85 Canceled Cleanup Org', 'canceled-warn85@test.local', warn85_customer
FROM canceled_cleanup_ctx
UNION ALL
SELECT ultra_canceled_org, user_id, 'Ultra Canceled Cleanup Org', 'canceled-ultra@test.local', ultra_customer
FROM canceled_cleanup_ctx;

INSERT INTO public.apps (app_id, icon_url, owner_org, name, user_id)
SELECT long_app, '', long_canceled_org, 'Long Canceled App', user_id FROM canceled_cleanup_ctx
UNION ALL
SELECT recent_app, '', recent_canceled_org, 'Recent Canceled App', user_id FROM canceled_cleanup_ctx
UNION ALL
SELECT trial_app, '', trial_org, 'Trial App', user_id FROM canceled_cleanup_ctx
UNION ALL
SELECT paying_app, '', paying_org, 'Paying App', user_id FROM canceled_cleanup_ctx
UNION ALL
SELECT early_app, '', early_cancel_org, 'Early Cancel App', user_id FROM canceled_cleanup_ctx
UNION ALL
SELECT warn85_app, '', warn85_org, 'Warn85 App', user_id FROM canceled_cleanup_ctx
UNION ALL
SELECT ultra_app, '', ultra_canceled_org, 'Ultra Canceled App', user_id FROM canceled_cleanup_ctx;

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
SELECT 970401, paying_app, '1.0.0', 'r2', paying_org, user_id, false FROM canceled_cleanup_ctx
UNION ALL
SELECT 970501, early_app, '1.0.0', 'r2', early_cancel_org, user_id, false FROM canceled_cleanup_ctx
UNION ALL
SELECT 970601, warn85_app, '1.0.0', 'r2', warn85_org, user_id, false FROM canceled_cleanup_ctx
UNION ALL
SELECT 970701, ultra_app, '1.0.0', 'r2', ultra_canceled_org, user_id, false FROM canceled_cleanup_ctx;

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
FROM canceled_cleanup_ctx
UNION ALL
SELECT
  now() - interval '2 days',
  'canceled_org_cleanup_test',
  'audit-trial',
  'UPDATE',
  user_id,
  trial_org,
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

-- Full canceled-org cleanup (warnings + versions + app delete + audit logs)
DELETE FROM pgmq.q_canceled_org_retention_alerts
WHERE message -> 'payload' ->> 'org_id' IN (
  SELECT long_canceled_org::text FROM canceled_cleanup_ctx
  UNION ALL
  SELECT warn85_org::text FROM canceled_cleanup_ctx
  UNION ALL
  SELECT ultra_canceled_org::text FROM canceled_cleanup_ctx
  UNION ALL
  SELECT recent_canceled_org::text FROM canceled_cleanup_ctx
);

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
  (SELECT deleted FROM public.app_versions WHERE id = 970301),
  false,
  'freshly expired trial org versions are kept for the 90-day grace window'
);

SELECT is(
  (SELECT deleted FROM public.app_versions WHERE id = 970401),
  false,
  'paying org versions are never soft-deleted by canceled cleanup'
);

SELECT is(
  (SELECT deleted FROM public.app_versions WHERE id = 970501),
  false,
  'early cancel still inside period-end grace keeps versions'
);

SELECT is(
  (SELECT deleted FROM public.app_versions WHERE id = 970601),
  false,
  '87-day org versions are kept until the 90-day soft-delete window'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.apps
    WHERE app_id = (SELECT long_app FROM canceled_cleanup_ctx)
  ),
  '92-day org app is kept until the 95-day app-delete window'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.apps
    WHERE app_id = (SELECT ultra_app FROM canceled_cleanup_ctx)
  ),
  '100-day org app is deleted after 95 days'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.old_apps
    WHERE app_id = (SELECT ultra_app FROM canceled_cleanup_ctx)
      AND owner_org = (SELECT ultra_canceled_org FROM canceled_cleanup_ctx)
      AND email = 'test@capgo.app'
  ),
  'deleted 95-day app is archived into old_apps with creator email'
);

SELECT ok(
  (
    SELECT count(*)::int
    FROM pgmq.q_canceled_org_retention_alerts
    WHERE message -> 'payload' ->> 'alert_type' = 'bundles_deletion_warning'
      AND (message -> 'payload' ->> 'org_id')::uuid IN (
        SELECT warn85_org FROM canceled_cleanup_ctx
        UNION ALL
        SELECT long_canceled_org FROM canceled_cleanup_ctx
        UNION ALL
        SELECT ultra_canceled_org FROM canceled_cleanup_ctx
      )
  ) >= 1,
  'queues 85-day bundle deletion warnings for eligible canceled orgs'
);

SELECT ok(
  (
    SELECT count(*)::int
    FROM pgmq.q_canceled_org_retention_alerts
    WHERE message -> 'payload' ->> 'alert_type' = 'app_deletion_warning'
      AND (message -> 'payload' ->> 'org_id')::uuid IN (
        SELECT long_canceled_org FROM canceled_cleanup_ctx
        UNION ALL
        SELECT ultra_canceled_org FROM canceled_cleanup_ctx
      )
  ) >= 1,
  'queues 90-day app deletion warnings for eligible canceled orgs'
);

SELECT ok(
  (
    SELECT count(*)::int
    FROM pgmq.q_canceled_org_retention_alerts
    WHERE (message -> 'payload' ->> 'org_id')::uuid = (
      SELECT recent_canceled_org FROM canceled_cleanup_ctx
    )
  ) = 0,
  'recently canceled orgs do not get retention deletion warnings'
);

SELECT ok(
  (
    SELECT cron.target::jsonb ? 'canceled_org_retention_alerts'
    FROM public.cron_tasks AS cron
    WHERE cron.name = 'high_frequency_queues'
  ),
  'high_frequency_queues drains canceled_org_retention_alerts'
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

SELECT is(
  (
    SELECT count(*)::int
    FROM public.audit_logs
    WHERE table_name = 'canceled_org_cleanup_test'
      AND record_id = 'audit-trial'
  ),
  1,
  'audit logs for freshly expired trial orgs are kept for the 90-day grace window'
);

SELECT tests.clear_authentication();

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
