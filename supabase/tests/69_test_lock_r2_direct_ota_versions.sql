-- GHSA-5rg9-rhwj-wj76: upload-complete bundles lock all content fields.
-- r2-direct staging with checksum locks identity fields; finalize and r2_path
-- writes remain allowed until storage_provider flips to r2.
BEGIN;

SELECT plan(11);

SELECT tests.authenticate_as_service_role();
SELECT tests.create_supabase_user('r2_direct_upload_lock_owner', 'r2_direct_upload_lock_owner@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('r2_direct_upload_lock_owner'),
  'r2_direct_upload_lock_owner@test.local',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '70000000-0000-4000-8000-000000000071',
  tests.get_supabase_uid('r2_direct_upload_lock_owner'),
  'r2-direct upload lock org',
  'r2-direct-upload-lock@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.r2direct.upload.lock',
  '',
  tests.get_supabase_uid('r2_direct_upload_lock_owner'),
  'r2-direct upload lock app',
  '70000000-0000-4000-8000-000000000071'
)
ON CONFLICT (app_id) DO NOTHING;

DELETE FROM public.app_versions
WHERE app_id = 'com.test.r2direct.upload.lock';

INSERT INTO public.app_versions (
  app_id,
  name,
  owner_org,
  user_id,
  storage_provider,
  checksum,
  session_key,
  r2_path,
  comment,
  deleted
)
VALUES
  (
    'com.test.r2direct.upload.lock',
    '1.0.0-staged',
    '70000000-0000-4000-8000-000000000071',
    tests.get_supabase_uid('r2_direct_upload_lock_owner'),
    'r2-direct',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'session-key-staged',
    NULL,
    'staged comment',
    false
  ),
  (
    'com.test.r2direct.upload.lock',
    '1.0.0-metadata',
    '70000000-0000-4000-8000-000000000071',
    tests.get_supabase_uid('r2_direct_upload_lock_owner'),
    'r2-direct',
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'session-key-metadata',
    NULL,
    'metadata comment',
    false
  ),
  (
    'com.test.r2direct.upload.lock',
    '1.0.0-in-progress',
    '70000000-0000-4000-8000-000000000071',
    tests.get_supabase_uid('r2_direct_upload_lock_owner'),
    'r2-direct',
    NULL,
    NULL,
    NULL,
    'in-progress comment',
    false
  ),
  (
    'com.test.r2direct.upload.lock',
    '1.0.0-finalized',
    '70000000-0000-4000-8000-000000000071',
    tests.get_supabase_uid('r2_direct_upload_lock_owner'),
    'r2',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'session-key-finalized',
    'orgs/70000000-0000-4000-8000-000000000071/apps/com.test.r2direct.upload.lock/1.0.0-finalized.zip',
    'finalized comment',
    false
  );

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET checksum = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-staged'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'staged r2-direct cannot UPDATE checksum'
);

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET session_key = 'session-key-mutated'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-staged'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'staged r2-direct cannot UPDATE session_key'
);

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET key_id = 'mutated-key-id'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-staged'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'staged r2-direct cannot UPDATE key_id'
);

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET external_url = 'https://evil.example/bundle.zip'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-staged'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'staged r2-direct cannot UPDATE external_url'
);

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET storage_provider = 'external'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-staged'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'staged r2-direct cannot redirect storage_provider away from finalize'
);

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET checksum = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-finalized'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'finalized r2 bundle cannot UPDATE checksum'
);

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET r2_path = 'orgs/70000000-0000-4000-8000-000000000071/apps/com.test.r2direct.upload.lock/rewritten.zip'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-finalized'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'finalized r2 bundle cannot UPDATE r2_path'
);

SELECT lives_ok(
  $sql$
    UPDATE public.app_versions
    SET
      storage_provider = 'r2',
      r2_path = 'orgs/70000000-0000-4000-8000-000000000071/apps/com.test.r2direct.upload.lock/1.0.0-staged.zip'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-staged'
  $sql$,
  'staged r2-direct can finalize to r2'
);

SELECT lives_ok(
  $sql$
    UPDATE public.app_versions
    SET r2_path = 'orgs/70000000-0000-4000-8000-000000000071/apps/com.test.r2direct.upload.lock/1.0.0-in-progress.zip'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-in-progress'
  $sql$,
  'in-progress r2-direct without checksum can UPDATE r2_path'
);

SELECT lives_ok(
  $sql$
    UPDATE public.app_versions
    SET
      checksum = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      session_key = 'session-key-first-set'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-in-progress'
  $sql$,
  'in-progress r2-direct can set checksum and session_key once'
);

SELECT lives_ok(
  $sql$
    UPDATE public.app_versions
    SET comment = 'updated metadata comment'
    WHERE app_id = 'com.test.r2direct.upload.lock'
      AND name = '1.0.0-metadata'
  $sql$,
  'staged r2-direct can still update non-content metadata'
);

SELECT * FROM finish();
ROLLBACK;
