-- Test RLS Policy Scenarios (Simplified)
-- This file tests basic RLS policy behavior
BEGIN;

-- Use existing seed data - no need to create new test data
-- Existing users from seed.sql:
-- 'c591b04e-cf29-4945-b9a0-776d0672061a' (admin@capgo.app)
-- '6aa76066-55ef-4238-ade6-0b32334a4097' (test@capgo.app)
-- Existing orgs:
-- '22dbad8a-b885-4309-9b3b-a09f8460fb6d' (Admin org)
-- '046a36ac-e03c-4590-9257-bd6c9dba9ee8' (Demo org)
-- Existing apps:
-- 'com.demoadmin.app', 'com.demo.app'
-- Plan tests
SELECT
  plan (7);

INSERT INTO public.app_versions (id, app_id, name, owner_org, storage_provider)
VALUES
  (910001, 'com.demo.app', 'manifest-own-rls', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'r2'),
  (910002, 'com.demoadmin.app', 'manifest-foreign-rls', '22dbad8a-b885-4309-9b3b-a09f8460fb6d', 'r2');

INSERT INTO public.manifest (id, app_version_id, file_name, s3_path, file_hash)
VALUES
  (910001, 910001, 'own.js', 'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.demo.app/manifest-own-rls.zip', 'ownhash'),
  (910002, 910002, 'foreign.js', 'orgs/22dbad8a-b885-4309-9b3b-a09f8460fb6d/apps/com.demoadmin.app/manifest-foreign-rls.zip', 'foreignhash');

-- Test 1: Users can see organizations they belong to
SET
  LOCAL role TO authenticated;

SET
  LOCAL request.jwt.claims TO '{"sub": "6aa76066-55ef-4238-ade6-0b32334a4097"}';

SELECT
  ok (
    (
      SELECT
        COUNT(*)
      FROM
        public.orgs
    ) >= 1,
    'User should see at least their own organization'
  );

-- Test 2: Users can see apps from their organization
SELECT
  ok (
    (
      SELECT
        COUNT(*)
      FROM
        public.apps
    ) >= 1,
    'User should see at least apps from their organization'
  );

-- Test 3: Plans table is accessible to everyone
SET
  LOCAL role TO anon;

SELECT
  lives_ok (
    'SELECT COUNT(*) FROM public.plans',
    'Anonymous users should be able to select from plans table'
  );

-- Test 5: Users table has RLS enabled
SET
  LOCAL role TO authenticated;

SET
  LOCAL request.jwt.claims TO '{"sub": "6aa76066-55ef-4238-ade6-0b32334a4097"}';

SELECT
  ok (
    (
      SELECT
        COUNT(*)
      FROM
        public.users
      WHERE
        id = '6aa76066-55ef-4238-ade6-0b32334a4097'
    ) = 1,
    'User should be able to see their own record in users table'
  );

-- Test 6: Disabled tables are truly disabled
-- TODO: fix it
-- SELECT
--   throws_ok (
--     'SELECT COUNT(*) FROM public.bandwidth_usage',
--     '42501',
--     'new row violates row-level security policy for table "bandwidth_usage"',
--     'bandwidth_usage table should be disabled for all'
--   );
-- TODO: fix it
-- Test 6: Test devices table policies - using existing seed device
-- SELECT
--   ok (
--     EXISTS (
--       SELECT
--         1
--       FROM
--         public.devices
--       WHERE
--         device_id = '00000000-0000-0000-0000-000000000001'
--         AND app_id = 'com.demo.app'
--     ),
--     'User should be able to see existing test devices from their apps'
--   );
-- Test 7: Test channels table - using existing seed channel
SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        public.channels
      WHERE
        app_id = 'com.demo.app'
        AND name = 'production'
    ),
    'User should be able to see existing channels from their apps'
  );

-- Test 8: Users should see manifest entries for apps they can access
SELECT
  is (
    (
      SELECT
        COUNT(*)
      FROM
        public.manifest
      WHERE
        app_version_id = 910001
    ),
    1::bigint,
    'User should see manifest entries for their own app versions'
  );

-- Test 9: Users should not see manifest entries for other organizations
SELECT
  is (
    (
      SELECT
        COUNT(*)
      FROM
        public.manifest
      WHERE
        app_version_id = 910002
    ),
    0::bigint,
    'User should not see manifest entries for app versions in other organizations'
  );

-- TODO: fix it
-- Test 9: Storage buckets check
-- SET
--   LOCAL role TO anon;
-- SELECT
--   throws_ok (
--     'SELECT COUNT(*) FROM storage.buckets',
--     '42501',
--     'new row violates row-level security policy for table "buckets"',
--     'Storage buckets should be disabled for users'
--   );
-- Cleanup and finish
SELECT
  *
FROM
  finish ();

ROLLBACK;
