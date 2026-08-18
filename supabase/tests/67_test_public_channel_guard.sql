-- Behavioral RLS/trigger coverage for the public/default channel guard.
-- app_preview may create private channels, but public create/flip needs
-- app.update_settings. Channel-scoped admins keep editing already-public rows.
BEGIN;

SELECT plan(6);

SELECT tests.authenticate_as_service_role();
SELECT tests.create_supabase_user('public_channel_guard_owner', 'public_channel_guard_owner@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('public_channel_guard_owner'),
  'public_channel_guard_owner@test.local',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '67000000-0000-4000-8000-000000000067',
  tests.get_supabase_uid('public_channel_guard_owner'),
  'Public channel guard org',
  'public-channel-guard@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.public.channel.guard',
  '',
  tests.get_supabase_uid('public_channel_guard_owner'),
  'Public channel guard app',
  '67000000-0000-4000-8000-000000000067'
)
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO public.role_bindings (
  principal_type,
  principal_id,
  role_id,
  scope_type,
  org_id,
  granted_by,
  reason,
  is_direct
)
SELECT
  public.rbac_principal_user(),
  tests.get_supabase_uid('public_channel_guard_owner'),
  roles.id,
  public.rbac_scope_org(),
  '67000000-0000-4000-8000-000000000067'::uuid,
  tests.get_supabase_uid('public_channel_guard_owner'),
  'pgTAP public channel guard owner',
  true
FROM public.roles
WHERE roles.name = public.rbac_role_org_super_admin()
ON CONFLICT DO NOTHING;

-- Preview key: can create private channels, cannot publicize.
SELECT tests.create_v2_apikey(
  67001,
  tests.get_supabase_uid('public_channel_guard_owner'),
  'public-channel-guard-preview-key',
  'public-channel-guard-preview-key',
  '67000000-0000-4000-8000-000000000067'::uuid,
  public.rbac_role_org_member(),
  'com.test.public.channel.guard',
  'app_preview'
);

-- App admin key: has app.update_settings for intentional public flips.
SELECT tests.create_v2_apikey(
  67002,
  tests.get_supabase_uid('public_channel_guard_owner'),
  'public-channel-guard-admin-key',
  'public-channel-guard-admin-key',
  '67000000-0000-4000-8000-000000000067'::uuid,
  public.rbac_role_org_member(),
  'com.test.public.channel.guard',
  public.rbac_role_app_admin()
);

-- Private channel owned by the fixture app for channel-admin flip tests.
INSERT INTO public.channels (
  id,
  name,
  app_id,
  version,
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
VALUES (
  6700401,
  'guard-private',
  'com.test.public.channel.guard',
  NULL,
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
  '67000000-0000-4000-8000-000000000067'::uuid,
  tests.get_supabase_uid('public_channel_guard_owner')
)
ON CONFLICT (id) DO UPDATE
SET
  public = false,
  allow_emulator = false;

-- Channel-admin key: channel.update_settings only, no app.update_settings.
SELECT tests.create_v2_apikey(
  67003,
  tests.get_supabase_uid('public_channel_guard_owner'),
  'public-channel-guard-channel-admin-key',
  'public-channel-guard-channel-admin-key',
  '67000000-0000-4000-8000-000000000067'::uuid,
  public.rbac_role_org_billing_admin()
);

INSERT INTO public.role_bindings (
  principal_type,
  principal_id,
  role_id,
  scope_type,
  org_id,
  app_id,
  channel_id,
  granted_by,
  reason,
  is_direct
)
SELECT
  public.rbac_principal_apikey(),
  apikeys.rbac_id,
  roles.id,
  public.rbac_scope_channel(),
  '67000000-0000-4000-8000-000000000067'::uuid,
  apps.id,
  channels.rbac_id,
  tests.get_supabase_uid('public_channel_guard_owner'),
  'pgTAP channel-admin public flip denial',
  true
FROM public.apikeys
CROSS JOIN public.roles
CROSS JOIN public.apps
CROSS JOIN public.channels
WHERE apikeys.id = 67003
  AND roles.name = public.rbac_role_channel_admin()
  AND apps.app_id = 'com.test.public.channel.guard'
  AND channels.id = 6700401
ON CONFLICT DO NOTHING;

-- 1) Preview key cannot INSERT a public channel.
SELECT tests.clear_authentication();
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.headers', '{"capgkey":"public-channel-guard-preview-key"}', true);

SELECT throws_ok(
  $$
    INSERT INTO public.channels (
      name,
      app_id,
      version,
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
    VALUES (
      'guard-preview-public',
      'com.test.public.channel.guard',
      NULL,
      true,
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
      '67000000-0000-4000-8000-000000000067'::uuid,
      tests.get_supabase_uid('public_channel_guard_owner')
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "channels"',
  'app_preview key cannot insert a public channel without app.update_settings'
);

-- 2) Preview key can INSERT a private channel.
SELECT lives_ok(
  $$
    INSERT INTO public.channels (
      name,
      app_id,
      version,
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
    VALUES (
      'guard-preview-private',
      'com.test.public.channel.guard',
      NULL,
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
      '67000000-0000-4000-8000-000000000067'::uuid,
      tests.get_supabase_uid('public_channel_guard_owner')
    )
  $$,
  'app_preview key can insert a private channel'
);

-- 3) Channel-admin cannot flip private -> public.
SELECT tests.clear_authentication();
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.headers', '{"capgkey":"public-channel-guard-channel-admin-key"}', true);

SELECT throws_ok(
  $$
    UPDATE public.channels
    SET public = true
    WHERE id = 6700401
  $$,
  '42501',
  'PERMISSION_DENIED_APP_UPDATE_SETTINGS',
  'channel-admin cannot promote a private channel to public'
);

-- 4) Channel-admin cannot mutate protected settings via direct PostgREST.
SELECT throws_ok(
  $$
    UPDATE public.channels
    SET allow_emulator = true
    WHERE id = 6700401
  $$,
  'P0001',
  'not allowed allow_emulator',
  'channel-admin cannot update non-public settings via API key PostgREST'
);

-- 5) App admin API keys cannot flip private -> public via direct PostgREST.
SELECT tests.clear_authentication();
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.headers', '{"capgkey":"public-channel-guard-admin-key"}', true);

SELECT throws_ok(
  $$
    UPDATE public.channels
    SET public = true
    WHERE id = 6700401
  $$,
  'P0001',
  'not allowed public',
  'app admin API key cannot promote a private channel to public via PostgREST'
);

-- 6) Channel-admin cannot edit an already-public channel via direct PostgREST.
SELECT tests.clear_authentication();
SELECT tests.authenticate_as_service_role();
SELECT set_config('request.headers', '{}', true);
UPDATE public.channels
SET public = true
WHERE id = 6700401;
SELECT tests.clear_authentication();
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.headers', '{"capgkey":"public-channel-guard-channel-admin-key"}', true);

SELECT throws_ok(
  $$
    UPDATE public.channels
    SET allow_device = true
    WHERE id = 6700401
  $$,
  'P0001',
  'not allowed allow_device',
  'channel-admin cannot update settings on an already-public channel '
  'via API key PostgREST'
);

SELECT tests.clear_authentication();
SELECT set_config('request.headers', '{}', true);

SELECT * FROM finish();
ROLLBACK;
