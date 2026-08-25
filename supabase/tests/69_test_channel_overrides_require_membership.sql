-- GHSA-626c-p6fq-3whq: app admins cannot grant channel permission overrides
-- to principals outside the channel owner org.
BEGIN;

SELECT plan(9);

SELECT tests.create_supabase_user('channel_override_admin', 'channel_override_admin@test.local');
SELECT tests.create_supabase_user('channel_override_member', 'channel_override_member@test.local');
SELECT tests.create_supabase_user('channel_override_outsider', 'channel_override_outsider@test.local');
SELECT tests.create_supabase_user('channel_override_app_admin', 'channel_override_app_admin@test.local');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES
  (tests.get_supabase_uid('channel_override_admin'), 'channel_override_admin@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('channel_override_member'), 'channel_override_member@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('channel_override_outsider'), 'channel_override_outsider@test.local', NOW(), NOW()),
  (tests.get_supabase_uid('channel_override_app_admin'), 'channel_override_app_admin@test.local', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES
  (
    '69000000-0000-4000-8000-000000000069',
    tests.get_supabase_uid('channel_override_admin'),
    'Channel override membership org',
    'channel-override-membership@test.local'
  ),
  (
    '69000000-0000-4000-8000-000000000070',
    tests.get_supabase_uid('channel_override_outsider'),
    'Channel override outsider org',
    'channel-override-outsider@test.local'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.channel.overrides.membership',
  '',
  tests.get_supabase_uid('channel_override_admin'),
  'Channel override membership app',
  '69000000-0000-4000-8000-000000000069'
)
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO public.channels (id, name, app_id, owner_org, created_by)
VALUES (
  6900401,
  'overrides-membership',
  'com.test.channel.overrides.membership',
  '69000000-0000-4000-8000-000000000069',
  tests.get_supabase_uid('channel_override_admin')
)
ON CONFLICT (id) DO NOTHING;

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
  tests.get_supabase_uid('channel_override_member'),
  roles.id,
  public.rbac_scope_org(),
  '69000000-0000-4000-8000-000000000069'::uuid,
  tests.get_supabase_uid('channel_override_admin'),
  'pgTAP channel override member fixture',
  true
FROM public.roles
WHERE roles.name = public.rbac_role_org_member()
  AND roles.scope_type = public.rbac_scope_org()
ON CONFLICT DO NOTHING;

INSERT INTO public.role_bindings (
  principal_type,
  principal_id,
  role_id,
  scope_type,
  org_id,
  app_id,
  granted_by,
  reason,
  is_direct
)
SELECT
  public.rbac_principal_user(),
  tests.get_supabase_uid('channel_override_app_admin'),
  roles.id,
  public.rbac_scope_app(),
  '69000000-0000-4000-8000-000000000069'::uuid,
  apps.id,
  tests.get_supabase_uid('channel_override_admin'),
  'pgTAP channel override app admin fixture',
  true
FROM public.roles
CROSS JOIN public.apps
WHERE roles.name = public.rbac_role_app_admin()
  AND roles.scope_type = public.rbac_scope_app()
  AND apps.app_id = 'com.test.channel.overrides.membership'
ON CONFLICT DO NOTHING;

INSERT INTO public.groups (id, org_id, name, created_by)
VALUES
  (
    '69000000-0000-4000-8000-000000000071',
    '69000000-0000-4000-8000-000000000069',
    'Channel override member group',
    tests.get_supabase_uid('channel_override_admin')
  ),
  (
    '69000000-0000-4000-8000-000000000072',
    '69000000-0000-4000-8000-000000000070',
    'Channel override outsider group',
    tests.get_supabase_uid('channel_override_outsider')
  )
ON CONFLICT (id) DO NOTHING;

SELECT tests.create_v2_apikey(
  690040001,
  tests.get_supabase_uid('channel_override_admin'),
  'channel-override-member-apikey',
  'Channel override member apikey',
  '69000000-0000-4000-8000-000000000069',
  public.rbac_role_org_member()
);

SELECT tests.create_v2_apikey(
  690040002,
  tests.get_supabase_uid('channel_override_outsider'),
  'channel-override-outsider-apikey',
  'Channel override outsider apikey',
  '69000000-0000-4000-8000-000000000070',
  public.rbac_role_org_member()
);

CREATE TEMP TABLE channel_override_apikey_rbac AS
SELECT apikeys.id, apikeys.rbac_id
FROM public.apikeys
WHERE apikeys.id IN (690040001, 690040002);

SELECT tests.authenticate_as('channel_override_admin');

SELECT throws_ok(
  $$
    INSERT INTO public.channel_permission_overrides (
      principal_type,
      principal_id,
      channel_id,
      permission_key,
      is_allowed
    )
    VALUES (
      public.rbac_principal_user(),
      tests.get_supabase_uid('channel_override_outsider'),
      6900401,
      public.rbac_perm_channel_promote_bundle(),
      true
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "channel_permission_overrides"',
  'admin cannot insert a channel permission override for a non-member user'
);

SELECT lives_ok(
  $$
    INSERT INTO public.channel_permission_overrides (
      principal_type,
      principal_id,
      channel_id,
      permission_key,
      is_allowed
    )
    VALUES (
      public.rbac_principal_user(),
      tests.get_supabase_uid('channel_override_member'),
      6900401,
      public.rbac_perm_channel_promote_bundle(),
      true
    )
  $$,
  'admin can insert a channel permission override for an org member'
);

SELECT throws_ok(
  $$
    UPDATE public.channel_permission_overrides
    SET principal_id = tests.get_supabase_uid('channel_override_outsider')
    WHERE channel_id = 6900401
      AND principal_id = tests.get_supabase_uid('channel_override_member')
      AND permission_key = public.rbac_perm_channel_promote_bundle()
  $$,
  '42501',
  'new row violates row-level security policy for table "channel_permission_overrides"',
  'admin cannot retarget a channel permission override to a non-member user'
);

SELECT lives_ok(
  $$
    UPDATE public.channel_permission_overrides
    SET is_allowed = false
    WHERE channel_id = 6900401
      AND principal_id = tests.get_supabase_uid('channel_override_member')
      AND permission_key = public.rbac_perm_channel_promote_bundle()
  $$,
  'admin can update a channel permission override that still targets an org member'
);

SELECT throws_ok(
  $$
    INSERT INTO public.channel_permission_overrides (
      principal_type,
      principal_id,
      channel_id,
      permission_key,
      is_allowed
    )
    VALUES (
      public.rbac_principal_group(),
      '69000000-0000-4000-8000-000000000072',
      6900401,
      public.rbac_perm_channel_promote_bundle(),
      true
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "channel_permission_overrides"',
  'admin cannot insert a channel permission override for an outsider group'
);

SELECT lives_ok(
  $$
    INSERT INTO public.channel_permission_overrides (
      principal_type,
      principal_id,
      channel_id,
      permission_key,
      is_allowed
    )
    VALUES (
      public.rbac_principal_group(),
      '69000000-0000-4000-8000-000000000071',
      6900401,
      public.rbac_perm_channel_promote_bundle(),
      true
    )
  $$,
  'admin can insert a channel permission override for an org group'
);

SELECT throws_ok(
  $$
    INSERT INTO public.channel_permission_overrides (
      principal_type,
      principal_id,
      channel_id,
      permission_key,
      is_allowed
    )
    VALUES (
      public.rbac_principal_apikey(),
      (SELECT rbac_id FROM channel_override_apikey_rbac WHERE id = 690040002),
      6900401,
      public.rbac_perm_channel_promote_bundle(),
      true
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "channel_permission_overrides"',
  'admin cannot insert a channel permission override for an outsider apikey'
);

SELECT lives_ok(
  $$
    INSERT INTO public.channel_permission_overrides (
      principal_type,
      principal_id,
      channel_id,
      permission_key,
      is_allowed
    )
    VALUES (
      public.rbac_principal_apikey(),
      (SELECT rbac_id FROM channel_override_apikey_rbac WHERE id = 690040001),
      6900401,
      public.rbac_perm_channel_rollback_bundle(),
      true
    )
  $$,
  'admin can insert a channel permission override for an org apikey'
);

SELECT tests.authenticate_as('channel_override_app_admin');

SELECT lives_ok(
  $$
    INSERT INTO public.channel_permission_overrides (
      principal_type,
      principal_id,
      channel_id,
      permission_key,
      is_allowed
    )
    VALUES (
      public.rbac_principal_user(),
      tests.get_supabase_uid('channel_override_member'),
      6900401,
      public.rbac_perm_channel_rollback_bundle(),
      true
    )
  $$,
  'app-scoped admin can insert a channel permission override for an org member'
);

SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
