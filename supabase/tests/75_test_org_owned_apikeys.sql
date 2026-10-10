-- Org-owned (shared) API keys: single-org bindings, org-level management,
-- and attribution-only transfer when the attributed user leaves.
BEGIN;

SELECT plan(71);

SELECT ok(NOT has_function_privilege('anon', 'public.lock_channel_override_orgs()', 'EXECUTE'),
  'anonymous callers cannot directly invoke the override lock trigger');
SELECT ok(NOT has_function_privilege('authenticated', 'public.lock_channel_override_orgs()', 'EXECUTE'),
  'user sessions cannot directly invoke the override lock trigger');

SELECT tests.create_supabase_user('shared_key_owner', 'shared-key-owner@test.local');
SELECT tests.create_supabase_user('shared_key_creator', 'shared-key-creator@test.local');
SELECT tests.create_supabase_user('shared_key_manager', 'shared-key-manager@test.local');
SELECT tests.create_supabase_user('shared_key_member', 'shared-key-member@test.local');

SELECT tests.authenticate_as_service_role();
SET LOCAL ROLE service_role;
SET LOCAL "request.jwt.claim.role" = 'service_role';

INSERT INTO public.users (id, email, created_at, updated_at)
SELECT tests.get_supabase_uid(fixture.identifier), fixture.email, NOW(), NOW()
FROM (
  VALUES
    ('shared_key_owner', 'shared-key-owner@test.local'),
    ('shared_key_creator', 'shared-key-creator@test.local'),
    ('shared_key_manager', 'shared-key-manager@test.local'),
    ('shared_key_member', 'shared-key-member@test.local')
) AS fixture(identifier, email)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES
  (
    '75000000-0000-4000-8000-000000000001',
    tests.get_supabase_uid('shared_key_owner'),
    'Shared key org',
    'shared-key-org@test.local'
  ),
  (
    '75000000-0000-4000-8000-000000000002',
    tests.get_supabase_uid('shared_key_owner'),
    'Shared key other org',
    'shared-key-other-org@test.local'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
SELECT fixture.org_id::uuid, tests.get_supabase_uid(fixture.identifier), fixture.role_name, false
FROM (
  VALUES
    ('75000000-0000-4000-8000-000000000001', 'shared_key_owner', public.rbac_role_org_super_admin()),
    ('75000000-0000-4000-8000-000000000001', 'shared_key_creator', public.rbac_role_org_admin()),
    ('75000000-0000-4000-8000-000000000001', 'shared_key_manager', public.rbac_role_apikey_manager()),
    ('75000000-0000-4000-8000-000000000001', 'shared_key_member', public.rbac_role_org_member()),
    ('75000000-0000-4000-8000-000000000002', 'shared_key_owner', public.rbac_role_org_super_admin()),
    ('75000000-0000-4000-8000-000000000002', 'shared_key_creator', public.rbac_role_org_admin())
) AS fixture(org_id, identifier, role_name)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT
  public.rbac_principal_user(),
  tests.get_supabase_uid(fixture.identifier),
  public.roles.id,
  public.rbac_scope_org(),
  fixture.org_id::uuid,
  tests.get_supabase_uid('shared_key_owner')
FROM (
  VALUES
    ('75000000-0000-4000-8000-000000000001', 'shared_key_owner', public.rbac_role_org_super_admin()),
    ('75000000-0000-4000-8000-000000000001', 'shared_key_creator', public.rbac_role_org_admin()),
    ('75000000-0000-4000-8000-000000000001', 'shared_key_manager', public.rbac_role_apikey_manager()),
    ('75000000-0000-4000-8000-000000000001', 'shared_key_member', public.rbac_role_org_member()),
    ('75000000-0000-4000-8000-000000000002', 'shared_key_owner', public.rbac_role_org_super_admin()),
    ('75000000-0000-4000-8000-000000000002', 'shared_key_creator', public.rbac_role_org_admin())
) AS fixture(org_id, identifier, role_name)
JOIN public.roles
  ON public.roles.name = fixture.role_name
  AND public.roles.scope_type = public.rbac_scope_org()
ON CONFLICT DO NOTHING;

-- Shared key created by an org admin, one attributed to a plain member who
-- holds no secret (as the backend would never allow, to prove user_id alone
-- grants nothing), and a personal key of the creator.
INSERT INTO public.apikeys (id, user_id, key_hash, name, owner_org_id)
VALUES
  (
    75000001,
    tests.get_supabase_uid('shared_key_creator'),
    encode(extensions.digest('shared-key-plain-75000001', 'sha256'), 'hex'),
    'Shared CI key',
    '75000000-0000-4000-8000-000000000001'
  ),
  (
    75000002,
    tests.get_supabase_uid('shared_key_member'),
    encode(extensions.digest('shared-key-plain-75000002', 'sha256'), 'hex'),
    'Shared key attributed to member',
    '75000000-0000-4000-8000-000000000001'
  );

SELECT tests.create_v2_apikey(
  75000003,
  tests.get_supabase_uid('shared_key_creator'),
  'personal-key-plain-75000003',
  'Creator personal key',
  '75000000-0000-4000-8000-000000000001',
  public.rbac_role_org_member()
);

SELECT tests.create_v2_apikey(
  75000004,
  tests.get_supabase_uid('shared_key_member'),
  'personal-key-plain-75000004',
  'Member personal key',
  '75000000-0000-4000-8000-000000000001',
  public.rbac_role_org_member()
);

INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT
  public.rbac_principal_apikey(),
  public.apikeys.rbac_id,
  public.roles.id,
  public.rbac_scope_org(),
  '75000000-0000-4000-8000-000000000001',
  tests.get_supabase_uid('shared_key_owner')
FROM public.apikeys
JOIN public.roles
  ON public.roles.name = public.rbac_role_org_member()
  AND public.roles.scope_type = public.rbac_scope_org()
WHERE public.apikeys.id IN (75000001, 75000002);

-- The secret holder is the user the key acts as (user_id). 75000002 stays
-- attributed to the member without any issued secret.
UPDATE public.apikeys SET shared_secret_user_id = user_id WHERE id = 75000001;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.shared.key.owner',
  '',
  tests.get_supabase_uid('shared_key_owner'),
  'Shared key owner app',
  '75000000-0000-4000-8000-000000000001'
)
ON CONFLICT (app_id) DO NOTHING;

CREATE TEMP TABLE shared_key_fixture AS
SELECT id, rbac_id FROM public.apikeys WHERE id IN (75000001, 75000002, 75000003, 75000004);
GRANT SELECT ON shared_key_fixture TO authenticated, anon;

-- Audit logs: shared keys and their bindings are logged in the owner org,
-- without secrets; personal keys are not.
SELECT is(
  (
    SELECT count(*)::int
    FROM public.audit_logs
    WHERE table_name = 'apikeys'
      AND record_id = '75000001'
      AND operation = 'INSERT'
      AND org_id = '75000000-0000-4000-8000-000000000001'
      AND NOT (new_record ? 'key_hash')
      AND NOT (new_record ? 'key')
  ),
  1,
  'shared key creation is audited in its owner org without secrets'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.audit_logs
    WHERE table_name = 'apikeys'
      AND record_id IN ('75000003', '75000004')
  ),
  0,
  'personal keys are not written to org audit logs'
);

SELECT is(
  (
    SELECT new_record->>'role_name'
    FROM public.audit_logs
    WHERE table_name = 'role_bindings'
      AND record_id = '75000001'
      AND operation = 'INSERT'
      AND org_id = '75000000-0000-4000-8000-000000000001'
    LIMIT 1
  ),
  public.rbac_role_org_member(),
  'shared key access grants are audited with the role name'
);

SELECT set_config('capgo.audit_actor_user_id', tests.get_supabase_uid('shared_key_manager')::text, true);
UPDATE public.apikeys SET name = 'Shared CI key renamed' WHERE id = 75000001;
SELECT set_config('capgo.audit_actor_user_id', '', true);

SELECT results_eq(
  $$SELECT actor_type, actor_user_id, changed_fields @> ARRAY['name']::text[]
    FROM public.audit_logs
    WHERE table_name = 'apikeys' AND record_id = '75000001' AND operation = 'UPDATE'
    ORDER BY id DESC
    LIMIT 1$$,
  $$SELECT 'user'::text, tests.get_supabase_uid('shared_key_manager'), true$$,
  'backend actor is recorded for shared key edits'
);

-- Invariants
SELECT throws_ok(
  $$INSERT INTO public.apikeys (user_id, key, name, owner_org_id)
    VALUES (tests.get_supabase_uid('shared_key_creator'), 'plain-shared-75', 'Plain shared', '75000000-0000-4000-8000-000000000001')$$,
  '23514',
  NULL,
  'shared keys must be hashed'
);

SELECT throws_ok(
  $$UPDATE public.apikeys SET shared_secret_user_id = tests.get_supabase_uid('shared_key_owner') WHERE id = 75000001$$,
  '23514',
  'new row for relation "apikeys" violates check constraint "apikeys_shared_secret_holder_is_user"',
  'shared secret holder cannot differ from the user the key acts as'
);

SELECT throws_ok(
  $$INSERT INTO public.apikeys (user_id, key_hash, name, owner_org_id, shared_secret_user_id)
    VALUES (tests.get_supabase_uid('shared_key_creator'), encode(extensions.digest('holder-mismatch-75', 'sha256'), 'hex'),
      'Holder mismatch', '75000000-0000-4000-8000-000000000001', tests.get_supabase_uid('shared_key_owner'))$$,
  '23514',
  'new row for relation "apikeys" violates check constraint "apikeys_shared_secret_holder_is_user"',
  'shared key cannot be inserted with a secret holder other than its user'
);

SELECT throws_ok(
  $$UPDATE public.apikeys SET owner_org_id = NULL WHERE id = 75000001$$,
  '42501',
  'APIKEY_OWNER_ORG_IMMUTABLE',
  'shared key cannot be converted to personal'
);

SELECT throws_ok(
  $$UPDATE public.apikeys SET owner_org_id = '75000000-0000-4000-8000-000000000001' WHERE id = 75000003$$,
  '42501',
  'APIKEY_OWNER_ORG_IMMUTABLE',
  'personal key cannot be converted to shared'
);

SELECT throws_ok(
  $$INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
    SELECT public.rbac_principal_apikey(), (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000001), roles.id,
      public.rbac_scope_org(), '75000000-0000-4000-8000-000000000002', tests.get_supabase_uid('shared_key_owner')
    FROM public.roles WHERE roles.name = public.rbac_role_org_member() AND roles.scope_type = public.rbac_scope_org()$$,
  '42501',
  'ORG_OWNED_APIKEY_BINDING_OUTSIDE_OWNER_ORG',
  'shared key cannot be bound outside its owner org'
);

SELECT throws_ok(
  $$INSERT INTO public.apikey_global_permissions (apikey_rbac_id, permission_key)
    VALUES ((SELECT rbac_id FROM shared_key_fixture WHERE id = 75000001), public.rbac_perm_org_create())$$,
  '42501',
  'ORG_OWNED_APIKEY_GLOBAL_PERMISSION_DENIED',
  'shared key cannot hold global permissions'
);

SELECT is(
  rbac_internal.role_binding_principal_allowed_for_org(
    public.rbac_principal_apikey(),
    (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000001),
    '75000000-0000-4000-8000-000000000002',
    public.rbac_scope_org()
  ),
  false,
  'binding helper rejects the other org for a shared key'
);

SELECT is(
  rbac_internal.role_binding_principal_allowed_for_org(
    public.rbac_principal_apikey(),
    (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000002),
    '75000000-0000-4000-8000-000000000001',
    public.rbac_scope_app()
  ),
  true,
  'binding helper allows the owner org for a shared key'
);

-- RLS: shared keys are visible to org API key managers, not to their user_id
SELECT tests.authenticate_as('shared_key_manager');

SELECT is(
  (SELECT count(*)::int FROM public.apikeys WHERE id IN (75000001, 75000002)),
  2,
  'apikey manager sees shared keys of the org'
);

SELECT is(
  (SELECT count(*)::int FROM public.apikeys WHERE id IN (75000003, 75000004)),
  0,
  'apikey manager does not see personal keys of other users'
);

SELECT tests.authenticate_as('shared_key_member');

SELECT is(
  (SELECT count(*)::int FROM public.apikeys WHERE id = 75000002),
  0,
  'attributed user without manage rights cannot see the shared key'
);

SELECT is(
  (SELECT count(*)::int FROM public.apikeys WHERE id = 75000004),
  1,
  'member still sees own personal key'
);

WITH deleted AS (
  DELETE FROM public.apikeys WHERE id = 75000002 RETURNING id
)
SELECT is(
  (SELECT count(*)::int FROM deleted),
  0,
  'attributed user without manage rights cannot delete the shared key'
);

-- A shared key only reads org_users of its owner org
SELECT tests.clear_authentication();
SET LOCAL ROLE anon;
SELECT set_config('request.headers', '{"capgkey":"shared-key-plain-75000001"}', true);

SELECT is(
  public.org_member_readable_org_ids(),
  ARRAY['75000000-0000-4000-8000-000000000001'::uuid],
  'shared key readable member orgs are limited to its owner org'
);

SELECT set_config('request.headers', '{}', true);
SELECT tests.authenticate_as_service_role();
SET LOCAL "request.jwt.claim.role" = 'service_role';
SET LOCAL ROLE postgres;

-- A shared manager cannot use attribution to rotate a personal key.
INSERT INTO public.apikeys (id, user_id, key_hash, name, owner_org_id)
VALUES (75000005, tests.get_supabase_uid('shared_key_creator'),
  encode(extensions.digest('shared-manager-secret-75000005', 'sha256'), 'hex'),
  'Shared manager', '75000000-0000-4000-8000-000000000001');
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT 'apikey', a.rbac_id, r.id, 'org', a.owner_org_id, a.user_id
FROM public.apikeys a JOIN public.roles r ON r.name = 'apikey_manager' AND r.scope_type = 'org'
WHERE a.id = 75000005;
UPDATE public.apikeys SET shared_secret_user_id = user_id WHERE id = 75000005;
SELECT tests.clear_authentication();
SET LOCAL ROLE anon;
SELECT set_config('request.headers', '{"capgkey":"shared-manager-secret-75000005"}', true);
SELECT throws_ok(
  $$SELECT public.regenerate_hashed_apikey(75000003)$$,
  '42501', 'PERMISSION_DENIED_PERSONAL_APIKEY',
  'shared manager cannot rotate attributed user personal keys through RPC'
);
SELECT tests.authenticate_as('shared_key_creator');
SELECT lives_ok(
  $$SELECT public.regenerate_hashed_apikey(75000003)$$,
  'JWT user retains priority over an accompanying shared capgkey'
);
SELECT set_config('request.headers', '{}', true);
SELECT tests.clear_authentication();
SELECT tests.authenticate_as_service_role();
SET LOCAL "request.jwt.claim.role" = 'service_role';
SET LOCAL ROLE postgres;
DELETE FROM public.apikeys WHERE id = 75000005;

-- Issue 75000002's secret to the owner (holder and user_id move together)
-- for the revocation checks; rolled back before the departure tests.
SAVEPOINT shared_key_live_secret;
UPDATE public.apikeys
SET user_id = tests.get_supabase_uid('shared_key_owner'),
    shared_secret_user_id = tests.get_supabase_uid('shared_key_owner')
WHERE id = 75000002;
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000002')), 1,
  'issued shared secret authorizes before any revocation');

-- Secret expiry stops authorization without waiting for cron cleanup.
UPDATE public.apikeys SET shared_secret_expires_at = now() - interval '1 second' WHERE id = 75000002;
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000002')), 0,
  'shared secret stops at recipient supporting binding expiry');
UPDATE public.apikeys SET shared_secret_expires_at = NULL WHERE id = 75000002;
SAVEPOINT shared_key_privilege_increase;
UPDATE public.role_bindings SET role_id = (SELECT id FROM public.roles WHERE name = 'org_admin' AND scope_type = 'org')
WHERE principal_type = 'apikey' AND principal_id = (SELECT rbac_id FROM public.apikeys WHERE id = 75000002);
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000002')), 0,
  'increasing key privileges revokes the previously copied secret');
ROLLBACK TO SAVEPOINT shared_key_privilege_increase;

SAVEPOINT shared_key_recipient_downgrade;
UPDATE public.apikeys
SET user_id = tests.get_supabase_uid('shared_key_creator'),
    shared_secret_user_id = tests.get_supabase_uid('shared_key_creator')
WHERE id = 75000002;
UPDATE public.role_bindings SET role_id = (SELECT id FROM public.roles WHERE name = 'org_member' AND scope_type = 'org')
WHERE principal_type = 'user' AND principal_id = tests.get_supabase_uid('shared_key_creator')
  AND org_id = '75000000-0000-4000-8000-000000000001';
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000002')), 0,
  'recipient role downgrade revokes their copied shared secret');
ROLLBACK TO SAVEPOINT shared_key_recipient_downgrade;

SAVEPOINT shared_key_group_revocation;
INSERT INTO public.groups (id, org_id, name, created_by)
VALUES ('75000000-0000-4000-8000-000000000004', '75000000-0000-4000-8000-000000000001',
  'Shared secret recipient group', tests.get_supabase_uid('shared_key_owner'));
INSERT INTO public.group_members (group_id, user_id, added_by)
VALUES ('75000000-0000-4000-8000-000000000004', tests.get_supabase_uid('shared_key_creator'), tests.get_supabase_uid('shared_key_owner'));
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT 'group', '75000000-0000-4000-8000-000000000004', r.id, 'org', '75000000-0000-4000-8000-000000000001', tests.get_supabase_uid('shared_key_owner')
FROM public.roles r WHERE r.name = 'org_member' AND r.scope_type = 'org';
UPDATE public.apikeys
SET user_id = tests.get_supabase_uid('shared_key_creator'),
    shared_secret_user_id = tests.get_supabase_uid('shared_key_creator')
WHERE id = 75000002;
SAVEPOINT shared_key_group_mutation;
DELETE FROM public.group_members WHERE group_id = '75000000-0000-4000-8000-000000000004';
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000002')), 0,
  'recipient group removal revokes their copied shared secret');
ROLLBACK TO SAVEPOINT shared_key_group_mutation;
DELETE FROM public.role_bindings WHERE principal_type = 'group' AND principal_id = '75000000-0000-4000-8000-000000000004';
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000002')), 0,
  'group role removal revokes member copied shared secrets');
ROLLBACK TO SAVEPOINT shared_key_group_mutation;
DELETE FROM public.groups WHERE id = '75000000-0000-4000-8000-000000000004';
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000002')), 0,
  'group deletion revokes secrets before cascading away memberships');
ROLLBACK TO SAVEPOINT shared_key_group_revocation;

-- Removing the member who holds a shared secret notifies the org once.
SAVEPOINT shared_key_removal_notice;
UPDATE public.apikeys
SET user_id = tests.get_supabase_uid('shared_key_creator'),
    shared_secret_user_id = tests.get_supabase_uid('shared_key_creator')
WHERE id = 75000002;
SELECT is(
  (
    SELECT count(*)::int
    FROM pgmq.q_on_shared_apikey_secret_revoked AS queued
    WHERE queued.message->'payload'->'record'->>'owner_org_id' = '75000000-0000-4000-8000-000000000001'
  ),
  0,
  'recipient stamping alone does not queue a rotation notice'
);
DELETE FROM public.org_users
WHERE org_id = '75000000-0000-4000-8000-000000000001'
  AND user_id = tests.get_supabase_uid('shared_key_creator');
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pgmq.q_on_shared_apikey_secret_revoked AS queued
    WHERE queued.message->>'function_name' = 'on_shared_apikey_secret_revoked'
      AND queued.message->'payload'->>'table' = 'apikeys'
      AND queued.message->'payload'->'record'->>'owner_org_id' = '75000000-0000-4000-8000-000000000001'
      AND queued.message->'payload'->'record'->'apikeys' @> pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'id', 75000002,
          'previous_recipient_user_id', tests.get_supabase_uid('shared_key_creator')
        )
      )
  ),
  'removing the secret holder queues a rotated shared key notice for the org'
);
ROLLBACK TO SAVEPOINT shared_key_removal_notice;
ROLLBACK TO SAVEPOINT shared_key_live_secret;

-- Transfer to a successor revokes the departing holder's secret instead of
-- handing a working secret to the successor.
SAVEPOINT shared_key_transfer_revokes;
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000001')), 1,
  'creator holds a working secret for the shared key before transfer');
SELECT public.transfer_org_owned_apikeys_from_user(
  tests.get_supabase_uid('shared_key_creator'),
  '75000000-0000-4000-8000-000000000001'
);
SELECT results_eq(
  $$SELECT user_id, shared_secret_user_id IS NULL, shared_secret_expires_at IS NULL, key IS NULL
    FROM public.apikeys WHERE id = 75000001$$,
  $$SELECT tests.get_supabase_uid('shared_key_owner'), true, true, true$$,
  'transfer moves user_id to the successor and clears the held secret'
);
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000001')), 0,
  'transferred shared key secret no longer authenticates');
ROLLBACK TO SAVEPOINT shared_key_transfer_revokes;

-- Requesting account deletion revokes held shared secrets right away; the key
-- itself stays with its org until the final purge.
SELECT tests.create_supabase_user('shared_key_leaver', 'shared-key-leaver@test.local');
INSERT INTO public.users (id, email)
VALUES (tests.get_supabase_uid('shared_key_leaver'), 'shared-key-leaver@test.local')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
VALUES ('75000000-0000-4000-8000-000000000001', tests.get_supabase_uid('shared_key_leaver'), public.rbac_role_org_admin(), false)
ON CONFLICT DO NOTHING;
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT 'user', tests.get_supabase_uid('shared_key_leaver'), r.id, 'org', '75000000-0000-4000-8000-000000000001',
  tests.get_supabase_uid('shared_key_owner')
FROM public.roles r WHERE r.name = public.rbac_role_org_admin() AND r.scope_type = 'org'
ON CONFLICT DO NOTHING;
INSERT INTO public.apikeys (id, user_id, key_hash, name, owner_org_id)
VALUES (75000008, tests.get_supabase_uid('shared_key_leaver'),
  encode(extensions.digest('shared-key-plain-75000008', 'sha256'), 'hex'),
  'Leaver held key', '75000000-0000-4000-8000-000000000001');
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT 'apikey', a.rbac_id, r.id, 'org', a.owner_org_id, a.user_id
FROM public.apikeys a JOIN public.roles r ON r.name = 'org_member' AND r.scope_type = 'org'
WHERE a.id = 75000008;
UPDATE public.apikeys SET shared_secret_user_id = user_id WHERE id = 75000008;
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000008')), 1,
  'leaver holds a working shared secret before requesting account deletion');
SELECT tests.mark_email_otp_verified('shared_key_leaver');
UPDATE auth.users SET last_sign_in_at = NOW() WHERE id = tests.get_supabase_uid('shared_key_leaver');
SELECT tests.authenticate_as('shared_key_leaver');
SELECT lives_ok($$SELECT public.delete_user()$$, 'shared secret holder can request account deletion');
SELECT tests.authenticate_as_service_role();
SET LOCAL "request.jwt.claim.role" = 'service_role';
SET LOCAL ROLE postgres;
SELECT results_eq(
  $$SELECT user_id, shared_secret_user_id IS NULL, key IS NULL FROM public.apikeys WHERE id = 75000008$$,
  $$SELECT tests.get_supabase_uid('shared_key_leaver'), true, true$$,
  'delete_user revokes held shared secrets but keeps the key in its org until the purge'
);
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('shared-key-plain-75000008')), 0,
  'shared secret of a user who requested account deletion no longer authenticates');

-- Creator leaves the org: shared key is reassigned, its bindings stay intact
DELETE FROM public.org_users
WHERE org_id = '75000000-0000-4000-8000-000000000001'
  AND user_id = tests.get_supabase_uid('shared_key_creator');

SELECT is(
  (SELECT user_id FROM public.apikeys WHERE id = 75000001),
  tests.get_supabase_uid('shared_key_owner'),
  'shared key moves to the durable org super admin when its creator leaves'
);

SELECT is(
  (SELECT shared_secret_user_id FROM public.apikeys WHERE id = 75000001),
  NULL::uuid,
  'departing creator no longer holds a secret for the transferred shared key'
);

SELECT ok(
  (
    SELECT changed_fields @> ARRAY['user_id']
    FROM public.audit_logs
    WHERE table_name = 'apikeys' AND record_id = '75000001' AND operation = 'UPDATE'
    ORDER BY id DESC
    LIMIT 1
  ),
  'shared key transfer is audited'
);

-- Issue a fresh secret to the new user_id so the probes below exercise a
-- working shared key.
UPDATE public.apikeys
SET key_hash = encode(extensions.digest('shared-key-plain-75000001', 'sha256'), 'hex'),
    shared_secret_user_id = user_id
WHERE id = 75000001;

SELECT is(
  public.is_app_owner('shared-key-plain-75000001', 'com.test.shared.key.owner'),
  false,
  'is_app_owner ignores the attributed app owner and requires app access for a shared key'
);

SELECT is(
  public.is_app_owner('shared-key-plain-75000001', 'com.demo.app'),
  false,
  'is_app_owner does not follow the attributed user to apps of other orgs'
);

-- An app-scoped shared key only passes the ownership probe for its bound app.
INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.shared.key.other',
  '',
  tests.get_supabase_uid('shared_key_owner'),
  'Shared key unbound app',
  '75000000-0000-4000-8000-000000000001'
)
ON CONFLICT (app_id) DO NOTHING;
INSERT INTO public.apikeys (id, user_id, key_hash, name, owner_org_id)
VALUES (75000007, tests.get_supabase_uid('shared_key_owner'),
  encode(extensions.digest('app-scoped-shared-key-75000007', 'sha256'), 'hex'),
  'App-scoped shared key', '75000000-0000-4000-8000-000000000001');
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by)
SELECT public.rbac_principal_apikey(), a.rbac_id, r.id, public.rbac_scope_app(), a.owner_org_id, apps.id, a.user_id
FROM public.apikeys a
JOIN public.roles r ON r.name = public.rbac_role_app_reader() AND r.scope_type = public.rbac_scope_app()
JOIN public.apps ON apps.app_id = 'com.test.shared.key.owner'
WHERE a.id = 75000007;
UPDATE public.apikeys SET shared_secret_user_id = tests.get_supabase_uid('shared_key_owner') WHERE id = 75000007;

SELECT is(
  public.is_app_owner('app-scoped-shared-key-75000007', 'com.test.shared.key.owner'),
  true,
  'is_app_owner accepts the app bound to an app-scoped shared key'
);

SELECT is(
  public.is_app_owner('app-scoped-shared-key-75000007', 'com.test.shared.key.other'),
  false,
  'is_app_owner rejects unbound apps of the owner org for an app-scoped shared key'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.role_bindings
    WHERE principal_type = public.rbac_principal_apikey()
      AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000001)
      AND org_id = '75000000-0000-4000-8000-000000000001'
  ),
  1,
  'shared key keeps exactly its bindings after the transfer'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.role_bindings
    WHERE principal_type = public.rbac_principal_apikey()
      AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000003)
      AND org_id = '75000000-0000-4000-8000-000000000001'
  ),
  0,
  'personal key of the departing member still loses its org bindings'
);

-- Direct client writes to shared key bindings are denied even for a user
-- holding app.update_user_roles; shared key access only changes through the
-- backend. Personal key bindings keep working.
SELECT tests.create_supabase_user('shared_key_app_admin', 'shared-key-app-admin@test.local');
INSERT INTO public.users (id, email)
VALUES (tests.get_supabase_uid('shared_key_app_admin'), 'shared-key-app-admin@test.local')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
VALUES ('75000000-0000-4000-8000-000000000001', tests.get_supabase_uid('shared_key_app_admin'), public.rbac_role_org_member(), false)
ON CONFLICT DO NOTHING;
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT 'user', tests.get_supabase_uid('shared_key_app_admin'), r.id, 'org', '75000000-0000-4000-8000-000000000001',
  tests.get_supabase_uid('shared_key_owner')
FROM public.roles r WHERE r.name = public.rbac_role_org_member() AND r.scope_type = 'org'
ON CONFLICT DO NOTHING;
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by)
SELECT 'user', tests.get_supabase_uid('shared_key_app_admin'), r.id, 'app', apps.owner_org, apps.id,
  tests.get_supabase_uid('shared_key_owner')
FROM public.roles r
JOIN public.apps ON apps.app_id = 'com.test.shared.key.owner'
WHERE r.name = public.rbac_role_app_admin() AND r.scope_type = 'app';
SELECT tests.create_v2_apikey(
  75000009,
  tests.get_supabase_uid('shared_key_app_admin'),
  'personal-key-plain-75000009',
  'App admin personal key',
  '75000000-0000-4000-8000-000000000001',
  public.rbac_role_org_member()
);
INSERT INTO shared_key_fixture
SELECT id, rbac_id FROM public.apikeys WHERE id IN (75000007, 75000009);
CREATE TEMP TABLE shared_key_app_fixture AS
SELECT
  apps.id AS app_uuid,
  (SELECT id FROM public.roles WHERE name = public.rbac_role_app_reader() AND scope_type = 'app') AS reader_role_id,
  (SELECT id FROM public.roles WHERE name = public.rbac_role_app_developer() AND scope_type = 'app') AS developer_role_id
FROM public.apps WHERE apps.app_id = 'com.test.shared.key.owner';
GRANT SELECT ON shared_key_app_fixture TO authenticated;

SELECT tests.authenticate_as('shared_key_app_admin');

SELECT throws_ok(
  $$INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by)
    SELECT 'apikey', (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000001), f.reader_role_id, 'app',
      '75000000-0000-4000-8000-000000000001', f.app_uuid, auth.uid()
    FROM shared_key_app_fixture f$$,
  '42501',
  'ORG_OWNED_APIKEY_BINDING_CLIENT_WRITE_DENIED',
  'app admin cannot grant a shared key access with a direct role binding insert'
);

SELECT throws_ok(
  $$UPDATE public.role_bindings SET role_id = (SELECT developer_role_id FROM shared_key_app_fixture)
    WHERE principal_type = 'apikey' AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000007)$$,
  '42501',
  'ORG_OWNED_APIKEY_BINDING_CLIENT_WRITE_DENIED',
  'app admin cannot change a shared key role binding directly'
);

SELECT throws_ok(
  $$DELETE FROM public.role_bindings
    WHERE principal_type = 'apikey' AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000007)$$,
  '42501',
  'ORG_OWNED_APIKEY_BINDING_CLIENT_WRITE_DENIED',
  'app admin cannot revoke a shared key role binding directly'
);

SELECT lives_ok(
  $$INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by)
    SELECT 'apikey', (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000009), f.reader_role_id, 'app',
      '75000000-0000-4000-8000-000000000001', f.app_uuid, auth.uid()
    FROM shared_key_app_fixture f$$,
  'app admin can still bind a personal key to the app'
);

SELECT throws_ok(
  $$UPDATE public.role_bindings SET principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000007)
    WHERE principal_type = 'apikey' AND scope_type = 'app'
      AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000009)$$,
  '42501',
  'ORG_OWNED_APIKEY_BINDING_CLIENT_WRITE_DENIED',
  'app admin cannot move an existing binding onto a shared key'
);

WITH updated AS (
  UPDATE public.role_bindings SET role_id = (SELECT developer_role_id FROM shared_key_app_fixture)
  WHERE principal_type = 'apikey' AND scope_type = 'app'
    AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000009)
  RETURNING 1
)
SELECT is(
  (SELECT count(*)::int FROM updated),
  1,
  'app admin can still change a personal key app binding'
);

WITH deleted AS (
  DELETE FROM public.role_bindings
  WHERE principal_type = 'apikey' AND scope_type = 'app'
    AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000009)
  RETURNING 1
)
SELECT is(
  (SELECT count(*)::int FROM deleted),
  1,
  'app admin can still revoke a personal key app binding'
);

SELECT tests.authenticate_as_service_role();
SET LOCAL "request.jwt.claim.role" = 'service_role';
SET LOCAL ROLE postgres;

SELECT results_eq(
  $$SELECT role_id FROM public.role_bindings
    WHERE principal_type = 'apikey' AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000007)$$,
  $$SELECT reader_role_id FROM shared_key_app_fixture$$,
  'denied client writes leave the shared key binding unchanged'
);

-- Deleting a shared key still removes its bindings (nested cleanup write).
SELECT tests.authenticate_as('shared_key_manager');
WITH deleted AS (
  DELETE FROM public.apikeys WHERE id = 75000007 RETURNING id
)
SELECT is(
  (SELECT count(*)::int FROM deleted),
  1,
  'apikey manager can delete a shared key that has bindings'
);
SELECT tests.authenticate_as_service_role();
SET LOCAL "request.jwt.claim.role" = 'service_role';
SET LOCAL ROLE postgres;
SELECT is(
  (
    SELECT count(*)::int FROM public.role_bindings
    WHERE principal_type = 'apikey' AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000007)
  ),
  0,
  'deleting a shared key from a client session cascades its role bindings'
);

-- Account deletion: shared key is reassigned, personal key is deleted
DELETE FROM auth.users WHERE id = (SELECT tests.get_supabase_uid('shared_key_member'));

SELECT is(
  (SELECT user_id FROM public.apikeys WHERE id = 75000002),
  tests.get_supabase_uid('shared_key_owner'),
  'shared key survives the attributed user account deletion'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.role_bindings
    WHERE principal_type = public.rbac_principal_apikey()
      AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000002)
  ),
  1,
  'shared key keeps its bindings after account deletion'
);

SELECT is(
  (SELECT count(*)::int FROM public.apikeys WHERE id = 75000004),
  0,
  'personal key is deleted with its owner account'
);

-- Deleting an org creator must not cascade the organization before transfer.
SELECT tests.create_supabase_user('shared_key_org_creator', 'shared-key-org-creator@test.local');
INSERT INTO public.users (id, email)
VALUES (tests.get_supabase_uid('shared_key_org_creator'), 'shared-key-org-creator@test.local')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES ('75000000-0000-4000-8000-000000000003', tests.get_supabase_uid('shared_key_org_creator'),
  'Creator deletion org', 'creator-deletion@test.local');
INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
SELECT '75000000-0000-4000-8000-000000000003', tests.get_supabase_uid(identifier), 'org_super_admin', false
FROM (VALUES ('shared_key_org_creator'), ('shared_key_owner')) AS fixture(identifier);
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT 'user', tests.get_supabase_uid(identifier), r.id, 'org', '75000000-0000-4000-8000-000000000003', tests.get_supabase_uid('shared_key_owner')
FROM (VALUES ('shared_key_org_creator'), ('shared_key_owner')) AS fixture(identifier)
JOIN public.roles r ON r.name = 'org_super_admin' AND r.scope_type = 'org'
ON CONFLICT DO NOTHING;
INSERT INTO public.apikeys (id, user_id, key_hash, name, owner_org_id)
VALUES (75000006, tests.get_supabase_uid('shared_key_org_creator'),
  encode(extensions.digest('creator-deletion-shared-key', 'sha256'), 'hex'),
  'Creator deletion key', '75000000-0000-4000-8000-000000000003');
INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
SELECT 'apikey', a.rbac_id, r.id, 'org', a.owner_org_id, a.user_id
FROM public.apikeys a JOIN public.roles r ON r.name = 'org_member' AND r.scope_type = 'org'
WHERE a.id = 75000006;
UPDATE public.apikeys SET shared_secret_user_id = tests.get_supabase_uid('shared_key_org_creator') WHERE id = 75000006;
DELETE FROM auth.users WHERE id = (SELECT tests.get_supabase_uid('shared_key_org_creator'));
SELECT is((SELECT created_by FROM public.orgs WHERE id = '75000000-0000-4000-8000-000000000003'),
  tests.get_supabase_uid('shared_key_owner'), 'organization survives creator auth deletion with successor');
SELECT is((SELECT user_id FROM public.apikeys WHERE id = 75000006),
  tests.get_supabase_uid('shared_key_owner'), 'shared key survives org creator auth deletion');
SELECT is((SELECT count(*)::int FROM public.role_bindings WHERE principal_type = 'apikey'
  AND principal_id = (SELECT rbac_id FROM public.apikeys WHERE id = 75000006)),
  1, 'shared key bindings survive org creator auth deletion');
SELECT is((SELECT count(*)::int FROM public.find_apikey_by_value('creator-deletion-shared-key')), 0,
  'copied shared secret is revoked when its recipient account is deleted');

-- A super admin deleting the org from a client session still cascades the
-- shared key bindings.
INSERT INTO shared_key_fixture SELECT id, rbac_id FROM public.apikeys WHERE id = 75000006;
SELECT tests.authenticate_as('shared_key_owner');
WITH deleted AS (
  DELETE FROM public.orgs WHERE id = '75000000-0000-4000-8000-000000000003' RETURNING id
)
SELECT is(
  (SELECT count(*)::int FROM deleted),
  1,
  'super admin can delete an org whose shared keys hold role bindings'
);
SELECT tests.authenticate_as_service_role();
SET LOCAL "request.jwt.claim.role" = 'service_role';
SET LOCAL ROLE postgres;
SELECT results_eq(
  $$SELECT
      (SELECT count(*)::int FROM public.apikeys WHERE id = 75000006),
      (SELECT count(*)::int FROM public.role_bindings
        WHERE principal_type = 'apikey' AND principal_id = (SELECT rbac_id FROM shared_key_fixture WHERE id = 75000006))$$,
  $$SELECT 0, 0$$,
  'client org deletion removes its shared keys and their bindings'
);

-- Shared keys never rotate through the personal compatibility RPC
SELECT tests.authenticate_as('shared_key_owner');

SELECT throws_ok(
  $$SELECT public.regenerate_hashed_apikey(75000001)$$,
  'P0002',
  'apikey_not_found',
  'regenerate_hashed_apikey rejects shared keys even for their current user_id'
);

-- Deleting the owner org deletes its shared keys
SELECT tests.authenticate_as_service_role();
SET LOCAL ROLE postgres;

DELETE FROM public.orgs WHERE id = '75000000-0000-4000-8000-000000000001';

SELECT is(
  (SELECT count(*)::int FROM public.apikeys WHERE id IN (75000001, 75000002)),
  0,
  'shared keys are deleted with their owner org'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM public.audit_logs
    WHERE table_name = 'apikeys' AND record_id = '75000001' AND operation = 'DELETE'
  ),
  1,
  'shared key deletion is audited'
);

SELECT is(
  (SELECT count(*)::int FROM public.apikeys WHERE id = 75000003),
  1,
  'personal keys survive deletion of one of their orgs'
);

SELECT * FROM finish();

ROLLBACK;
