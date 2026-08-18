-- Reject foreign or cross-version r2_path retargeting on app_versions.
BEGIN;

SELECT plan(5);

SELECT tests.authenticate_as_service_role();
SELECT tests.create_supabase_user(
  'r2_path_guard_owner',
  'r2_path_guard_owner@test.local'
);

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('r2_path_guard_owner'),
  'r2_path_guard_owner@test.local',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '70000000-0000-4000-8000-000000000070',
  tests.get_supabase_uid('r2_path_guard_owner'),
  'R2 path guard org',
  'r2-path-guard@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.r2.path.guard',
  '',
  tests.get_supabase_uid('r2_path_guard_owner'),
  'R2 path guard app',
  '70000000-0000-4000-8000-000000000070'
)
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.r2.path.victim',
  '',
  tests.get_supabase_uid('r2_path_guard_owner'),
  'R2 path victim app',
  '70000000-0000-4000-8000-000000000070'
)
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO public.app_versions (
  id,
  app_id,
  name,
  owner_org,
  user_id,
  storage_provider,
  deleted
)
VALUES (
  7000701,
  'com.test.r2.path.guard',
  '1.0.0-r2-path-guard',
  '70000000-0000-4000-8000-000000000070'::uuid,
  tests.get_supabase_uid('r2_path_guard_owner'),
  'r2-direct',
  false
)
ON CONFLICT (id) DO UPDATE
SET
  storage_provider = EXCLUDED.storage_provider,
  r2_path = null,
  deleted = EXCLUDED.deleted;

INSERT INTO public.app_versions (
  id,
  app_id,
  name,
  owner_org,
  user_id,
  storage_provider,
  r2_path,
  deleted
)
VALUES (
  7000702,
  'com.test.r2.path.victim',
  '9.9.9-victim-bundle',
  '70000000-0000-4000-8000-000000000070'::uuid,
  tests.get_supabase_uid('r2_path_guard_owner'),
  'r2',
  'orgs/70000000-0000-4000-8000-000000000070'
  || '/apps/com.test.r2.path.victim/9.9.9-victim-bundle.zip',
  false
)
ON CONFLICT (id) DO UPDATE
SET r2_path = EXCLUDED.r2_path;

SELECT throws_ok(
  $$
    UPDATE public.app_versions
    SET r2_path = 'orgs/70000000-0000-4000-8000-000000000070'
      || '/apps/com.test.r2.path.victim/9.9.9-victim-bundle.zip'
    WHERE id = 7000701
  $$,
  'invalid_r2_path: Bundle storage path must match the canonical location for this version.',
  'foreign version r2_path retarget is rejected'
);

SELECT lives_ok(
  $$
    UPDATE public.app_versions
    SET r2_path = 'orgs/70000000-0000-4000-8000-000000000070'
      || '/apps/com.test.r2.path.guard/1.0.0-r2-path-guard.zip'
    WHERE id = 7000701
  $$,
  'canonical upload_link r2_path is accepted'
);

SELECT is(
  (
    SELECT r2_path::text
    FROM public.app_versions
    WHERE id = 7000701
  ),
  (
    'orgs/70000000-0000-4000-8000-000000000070'
    || '/apps/com.test.r2.path.guard/1.0.0-r2-path-guard.zip'
  ),
  'canonical r2_path is persisted'
);

SELECT throws_ok(
  $$
    UPDATE public.app_versions
    SET r2_path = 'orgs/70000000-0000-4000-8000-000000000070'
      || '/apps/com.test.r2.path.guard/9.9.9-victim-bundle.zip'
    WHERE id = 7000701
  $$,
  'invalid_r2_path: Bundle storage path must match the canonical location for this version.',
  'same-app cross-version r2_path retarget is rejected'
);

SELECT is(
  (
    SELECT r2_path::text
    FROM public.app_versions
    WHERE id = 7000701
  ),
  (
    'orgs/70000000-0000-4000-8000-000000000070'
    || '/apps/com.test.r2.path.guard/1.0.0-r2-path-guard.zip'
  ),
  'canonical r2_path unchanged after rejected cross-version retarget'
);

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
