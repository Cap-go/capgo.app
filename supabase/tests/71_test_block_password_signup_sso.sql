BEGIN;

SELECT plan(20);

SELECT has_function(
  'public',
  'hook_before_user_created',
  ARRAY['jsonb'],
  'before-user-created hook exists'
);

SELECT has_function(
  'public',
  'password_signup_blocked_for_email',
  ARRAY['text'],
  'password signup block helper exists'
);

SELECT is(
  has_function_privilege('anon', 'public.hook_before_user_created(jsonb)', 'execute'),
  false,
  'anon cannot execute before-user-created hook'
);

SELECT is(
  has_function_privilege('authenticated', 'public.hook_before_user_created(jsonb)', 'execute'),
  false,
  'authenticated cannot execute before-user-created hook'
);

SELECT is(
  has_function_privilege('anon', 'public.password_signup_blocked_for_email(text)', 'execute'),
  false,
  'anon cannot call password signup block helper'
);

SELECT is(
  has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'execute'),
  true,
  'supabase_auth_admin can execute before-user-created hook'
);

SELECT is(
  has_schema_privilege('supabase_auth_admin', 'public', 'USAGE'),
  true,
  'supabase_auth_admin can use public schema to invoke the hook'
);

SELECT tests.create_supabase_user(
  'block_sso_owner',
  'block-sso-owner@capgo.app'
);

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('block_sso_owner'),
  'block-sso-owner@capgo.app',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '71000000-0000-4000-8000-000000000071',
  tests.get_supabase_uid('block_sso_owner'),
  'Block password signup SSO org',
  'block-sso-owner@capgo.app'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.sso_providers (
  id,
  org_id,
  domain,
  provider_id,
  status,
  enforce_sso,
  dns_verification_token
)
VALUES
  (
    '71000000-0000-4000-8000-000000000072',
    '71000000-0000-4000-8000-000000000071',
    'block-sso-pg.test',
    '71000000-0000-4000-8000-000000000073',
    'active',
    false,
    'dns-block-sso-pg'
  ),
  (
    '71000000-0000-4000-8000-000000000074',
    '71000000-0000-4000-8000-000000000071',
    'block-sso-disabled.test',
    '71000000-0000-4000-8000-000000000075',
    'disabled',
    false,
    'dns-block-sso-disabled'
  ),
  (
    '71000000-0000-4000-8000-000000000076',
    '71000000-0000-4000-8000-000000000071',
    'block-sso-pending.test',
    '71000000-0000-4000-8000-000000000077',
    'pending_verification',
    false,
    'dns-block-sso-pending'
  );

SELECT tests.create_supabase_user(
  'leftover_sso',
  'leftover@leftover-sso.test'
);

UPDATE auth.users
SET is_sso_user = true
WHERE id = tests.get_supabase_uid('leftover_sso');

SELECT is(
  public.password_signup_blocked_for_email('anyone@block-sso-pg.test'),
  true,
  'active SSO domain blocks password signup'
);

SELECT is(
  public.password_signup_blocked_for_email('anyone@block-sso-disabled.test'),
  false,
  'disabled SSO domain does not block password signup'
);

SELECT is(
  public.password_signup_blocked_for_email('anyone@block-sso-pending.test'),
  false,
  'pending SSO domain does not block password signup'
);

SELECT is(
  public.password_signup_blocked_for_email('anyone@example.com'),
  false,
  'unrelated domain is not blocked'
);

SELECT is(
  public.password_signup_blocked_for_email('leftover@leftover-sso.test'),
  true,
  'existing SSO auth user blocks password signup'
);

SELECT is(
  public.hook_before_user_created(
    '{"user":{"email":"anyone@block-sso-pg.test","app_metadata":{"provider":"email","providers":["email"]}}}'::jsonb
  ),
  '{"error":{"http_code":422,"message":"User already registered"}}'::jsonb,
  'hook returns duplicate-account error for SSO domain signup'
);

SELECT is(
  public.hook_before_user_created(
    '{"user":{"email":"leftover@leftover-sso.test","app_metadata":{"provider":"email","providers":["email"]}}}'::jsonb
  ),
  public.hook_before_user_created(
    '{"user":{"email":"anyone@block-sso-pg.test","app_metadata":{"provider":"email","providers":["email"]}}}'::jsonb
  ),
  'hook error is identical for existing SSO email and SSO domain signup'
);

SELECT is(
  public.hook_before_user_created(
    '{"user":{"email":"jit@block-sso-pg.test","app_metadata":{"provider":"sso:abc","providers":["sso:abc"]}}}'::jsonb
  ),
  '{}'::jsonb,
  'hook allows SSO JIT on an active SSO domain'
);

SELECT is(
  public.hook_before_user_created(
    '{"user":{"email":"new@example.com","app_metadata":{"provider":"email","providers":["email"]}}}'::jsonb
  ),
  '{}'::jsonb,
  'hook allows password signup on a non-SSO domain'
);

SELECT throws_ok(
  $$
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, raw_app_meta_data, created_at, updated_at, is_sso_user
    )
    VALUES (
      '00000000-0000-0000-0000-000000000000',
      '71000000-0000-4000-8000-000000000079',
      'authenticated',
      'authenticated',
      'password@block-sso-pg.test',
      '{"provider":"email","providers":["email"]}'::jsonb,
      NOW(),
      NOW(),
      false
    );
  $$,
  '23505',
  'User already registered',
  'trigger rejects password insert on an active SSO domain with the duplicate-account error'
);

SELECT lives_ok(
  $$
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, raw_app_meta_data, created_at, updated_at, is_sso_user
    )
    VALUES (
      '00000000-0000-0000-0000-000000000000',
      '71000000-0000-4000-8000-000000000080',
      'authenticated',
      'authenticated',
      'jit@block-sso-pg.test',
      '{"provider":"sso:abc","providers":["sso:abc"]}'::jsonb,
      NOW(),
      NOW(),
      false
    );
  $$,
  'trigger allows SSO metadata insert on an active SSO domain'
);

SELECT lives_ok(
  $$
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, raw_app_meta_data, created_at, updated_at, is_sso_user
    )
    VALUES (
      '00000000-0000-0000-0000-000000000000',
      '71000000-0000-4000-8000-000000000081',
      'authenticated',
      'authenticated',
      'flagged@block-sso-pg.test',
      '{"provider":"email","providers":["email"]}'::jsonb,
      NOW(),
      NOW(),
      true
    );
  $$,
  'trigger allows is_sso_user insert on an active SSO domain'
);

SELECT lives_ok(
  $$
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, raw_app_meta_data, created_at, updated_at, is_sso_user
    )
    VALUES (
      '00000000-0000-0000-0000-000000000000',
      '71000000-0000-4000-8000-000000000082',
      'authenticated',
      'authenticated',
      'ok@example.com',
      '{"provider":"email","providers":["email"]}'::jsonb,
      NOW(),
      NOW(),
      false
    );
  $$,
  'trigger allows password insert on a non-SSO domain'
);

SELECT * FROM finish();

ROLLBACK;
