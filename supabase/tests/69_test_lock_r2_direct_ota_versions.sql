-- GHSA-5rg9-rhwj-wj76: channel-linked r2-direct versions must lock
-- checksum/session_key. Unlinked in-progress r2-direct can still finalize.
BEGIN;

SELECT plan(5);

SELECT tests.authenticate_as_service_role();
SELECT tests.create_supabase_user('r2_direct_ota_lock_owner', 'r2_direct_ota_lock_owner@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('r2_direct_ota_lock_owner'),
  'r2_direct_ota_lock_owner@test.local',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '70000000-0000-4000-8000-000000000070',
  tests.get_supabase_uid('r2_direct_ota_lock_owner'),
  'r2-direct OTA lock org',
  'r2-direct-ota-lock@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.r2direct.ota.lock',
  '',
  tests.get_supabase_uid('r2_direct_ota_lock_owner'),
  'r2-direct OTA lock app',
  '70000000-0000-4000-8000-000000000070'
)
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO public.app_versions (
  app_id,
  name,
  owner_org,
  user_id,
  storage_provider,
  checksum,
  session_key,
  comment,
  deleted
)
VALUES
  (
    'com.test.r2direct.ota.lock',
    '1.0.0-linked',
    '70000000-0000-4000-8000-000000000070',
    tests.get_supabase_uid('r2_direct_ota_lock_owner'),
    'r2-direct',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'session-key-linked',
    'initial linked comment',
    false
  ),
  (
    'com.test.r2direct.ota.lock',
    '1.0.0-rollout',
    '70000000-0000-4000-8000-000000000070',
    tests.get_supabase_uid('r2_direct_ota_lock_owner'),
    'r2-direct',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'session-key-rollout',
    false
  ),
  (
    'com.test.r2direct.ota.lock',
    '1.0.0-unlinked',
    '70000000-0000-4000-8000-000000000070',
    tests.get_supabase_uid('r2_direct_ota_lock_owner'),
    'r2-direct',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'session-key-unlinked',
    false
  )
ON CONFLICT (name, app_id) DO UPDATE
SET
  storage_provider = EXCLUDED.storage_provider,
  checksum = EXCLUDED.checksum,
  session_key = EXCLUDED.session_key,
  comment = EXCLUDED.comment,
  deleted = false;

INSERT INTO public.channels (
  id,
  name,
  app_id,
  version,
  rollout_version,
  public,
  disable_auto_update_under_native,
  disable_auto_update,
  ios,
  android,
  electron,
  allow_device_self_set,
  allow_emulator,
  allow_device,
  allow_dev,
  allow_prod,
  owner_org,
  created_by
)
SELECT
  7000701,
  'ota-lock',
  'com.test.r2direct.ota.lock',
  linked.id,
  rollout.id,
  false,
  true,
  'major'::public.disable_update,
  true,
  true,
  false,
  false,
  false,
  false,
  false,
  true,
  '70000000-0000-4000-8000-000000000070'::uuid,
  tests.get_supabase_uid('r2_direct_ota_lock_owner')
FROM public.app_versions AS linked
CROSS JOIN public.app_versions AS rollout
WHERE linked.app_id = 'com.test.r2direct.ota.lock'
  AND linked.name = '1.0.0-linked'
  AND rollout.app_id = 'com.test.r2direct.ota.lock'
  AND rollout.name = '1.0.0-rollout'
ON CONFLICT (id) DO UPDATE
SET
  version = EXCLUDED.version,
  rollout_version = EXCLUDED.rollout_version;

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET checksum = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    WHERE app_id = 'com.test.r2direct.ota.lock'
      AND name = '1.0.0-linked'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'channel-linked r2-direct cannot UPDATE checksum'
);

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET session_key = 'session-key-mutated'
    WHERE app_id = 'com.test.r2direct.ota.lock'
      AND name = '1.0.0-linked'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'channel-linked r2-direct cannot UPDATE session_key'
);

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET checksum = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    WHERE app_id = 'com.test.r2direct.ota.lock'
      AND name = '1.0.0-rollout'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'rollout-linked r2-direct cannot UPDATE checksum'
);

SELECT lives_ok(
  $sql$
    UPDATE public.app_versions
    SET
      storage_provider = 'r2',
      r2_path = 'orgs/70000000-0000-4000-8000-000000000070/apps/com.test.r2direct.ota.lock/1.0.0-unlinked.zip'
    WHERE app_id = 'com.test.r2direct.ota.lock'
      AND name = '1.0.0-unlinked'
  $sql$,
  'unlinked in-progress r2-direct can finalize to r2'
);

SELECT lives_ok(
  $sql$
    UPDATE public.app_versions
    SET comment = 'updated linked comment'
    WHERE app_id = 'com.test.r2direct.ota.lock'
      AND name = '1.0.0-linked'
  $sql$,
  'channel-linked r2-direct can still update non-delivery metadata'
);

SELECT * FROM finish();
ROLLBACK;
