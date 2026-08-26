-- In-progress r2-direct versions must not accept app_versions.manifest jsonb writes.
BEGIN;

SELECT plan(2);

SELECT tests.authenticate_as_service_role();
SELECT tests.create_supabase_user('r2_direct_manifest_block_owner', 'r2_direct_manifest_block_owner@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('r2_direct_manifest_block_owner'),
  'r2_direct_manifest_block_owner@test.local',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '70000000-0000-4000-8000-000000000073',
  tests.get_supabase_uid('r2_direct_manifest_block_owner'),
  'r2-direct manifest block org',
  'r2-direct-manifest-block@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.r2direct.manifest.block',
  '',
  tests.get_supabase_uid('r2_direct_manifest_block_owner'),
  'r2-direct manifest block app',
  '70000000-0000-4000-8000-000000000073'
)
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO public.app_versions (
  app_id,
  name,
  owner_org,
  user_id,
  storage_provider,
  checksum,
  deleted
)
VALUES (
  'com.test.r2direct.manifest.block',
  '1.0.0-in-progress',
  '70000000-0000-4000-8000-000000000073',
  tests.get_supabase_uid('r2_direct_manifest_block_owner'),
  'r2-direct',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  false
)
ON CONFLICT (name, app_id) DO UPDATE
SET
  storage_provider = EXCLUDED.storage_provider,
  checksum = EXCLUDED.checksum,
  manifest = NULL,
  deleted = false;

SELECT throws_ok(
  $sql$
    UPDATE public.app_versions
    SET manifest = ARRAY[
      ROW(
        'index.html',
        'orgs/70000000-0000-4000-8000-000000000073/apps/com.test.r2direct.manifest.block/delta/poison_index.html',
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      )::public.manifest_entry
    ]
    WHERE app_id = 'com.test.r2direct.manifest.block'
      AND name = '1.0.0-in-progress'
  $sql$,
  'P0001',
  'bundle_already_ready: Bundle content cannot be changed after upload is complete. Upload a new bundle instead.',
  'in-progress r2-direct cannot UPDATE manifest jsonb'
);

SELECT lives_ok(
  $sql$
    UPDATE public.app_versions
    SET
      storage_provider = 'r2',
      r2_path = 'orgs/70000000-0000-4000-8000-000000000073/apps/com.test.r2direct.manifest.block/1.0.0-in-progress.zip',
      manifest = ARRAY[
        ROW(
          'legacy.html',
          'orgs/70000000-0000-4000-8000-000000000073/apps/com.test.r2direct.manifest.block/delta/legacy_legacy.html',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        )::public.manifest_entry
      ]
    WHERE app_id = 'com.test.r2direct.manifest.block'
      AND name = '1.0.0-in-progress'
  $sql$,
  'legacy finalize can still set manifest while moving r2-direct -> r2'
);

SELECT * FROM finish();
ROLLBACK;
