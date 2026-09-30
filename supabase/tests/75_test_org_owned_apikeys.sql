-- Org-owned (shared) API keys: single-org bindings, org-level management,
-- and attribution-only transfer when the attributed user leaves.
BEGIN;

SELECT plan(28);

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

-- Shared key created by an org admin, one created by a plain member (as the
-- backend would never allow, to prove user_id alone grants nothing), and a
-- personal key of the creator.
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
  $$SELECT actor_type, actor_user_id, changed_fields
    FROM public.audit_logs
    WHERE table_name = 'apikeys' AND record_id = '75000001' AND operation = 'UPDATE'
    ORDER BY id DESC
    LIMIT 1$$,
  $$SELECT 'user'::text, tests.get_supabase_uid('shared_key_manager'), ARRAY['name']::text[]$$,
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
SET LOCAL ROLE postgres;

-- Creator leaves the org: shared key is reassigned, its bindings stay intact
DELETE FROM public.org_users
WHERE org_id = '75000000-0000-4000-8000-000000000001'
  AND user_id = tests.get_supabase_uid('shared_key_creator');

SELECT is(
  (SELECT user_id FROM public.apikeys WHERE id = 75000001),
  tests.get_supabase_uid('shared_key_owner'),
  'shared key moves to the durable org super admin when its creator leaves'
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

-- Account deletion: shared key is reassigned, personal key is deleted
DELETE FROM auth.users WHERE id = tests.get_supabase_uid('shared_key_member');

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
