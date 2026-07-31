BEGIN;


SELECT plan(8);

-- Test is_platform_admin wrapper
SELECT tests.authenticate_as('test_admin');

SELECT
    is(
        public.is_platform_admin(),
        true,
        'is_platform_admin test - admin secret user is platform admin'
    );

SELECT tests.clear_authentication();

SELECT tests.authenticate_as('test_user');

SELECT
    is(
        public.is_platform_admin(),
        false,
        'is_platform_admin test - user is not platform admin without admin_users secret'
    );

SELECT tests.clear_authentication();

-- Test split behavior when an RBAC role exists (RBAC roles should not affect is_platform_admin)
SET LOCAL ROLE service_role;
INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
    '55555555-5555-4555-8555-555555555555',
    tests.get_supabase_uid('test_admin'),
    'Auth function role test org',
    'auth-function-role-test@capgo.app'
)
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.role_bindings
WHERE
    principal_type = 'user'
    AND principal_id = tests.get_supabase_uid('test_user')
    AND scope_type = 'org'
    AND org_id = '55555555-5555-4555-8555-555555555555';

INSERT INTO public.role_bindings (
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    granted_by
)
SELECT
    'user',
    tests.get_supabase_uid('test_user'),
    r.id,
    'org',
    '55555555-5555-4555-8555-555555555555',
    tests.get_supabase_uid('test_admin')
FROM public.roles AS r
WHERE r.name = public.rbac_role_org_super_admin();
RESET ROLE;

SELECT tests.authenticate_as('test_user');

SELECT
    is(
        public.is_platform_admin(),
        false,
        'is_platform_admin wrapper test - RBAC roles are not checked in admin secret function'
    );

SELECT tests.clear_authentication();

SELECT
    is(
        (
            SELECT count(*)::int
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
                AND p.proname = 'is_allowed_capgkey'
                AND pg_get_function_identity_arguments(p.oid) ~ 'key_mode'
        ),
        0,
        'is_allowed_capgkey old key_mode overloads are removed'
    );

SELECT
    is(
        (
            SELECT count(*)::int
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
                AND p.proname = 'is_allowed_capgkey'
                AND pg_get_function_identity_arguments(p.oid) IN (
                    'apikey text, keymode text[]',
                    'apikey text, keymode text[], appid character varying'
                )
        ),
        2,
        'is_allowed_capgkey keeps only RBAC-backed text[] compatibility wrappers'
    );

-- ============================================================================
-- Test get_user_id with hashed API keys
-- ============================================================================

SELECT tests.authenticate_as('test_user');

SELECT
    is(
        get_user_id('test-hashed-apikey-for-auth-test'),
        tests.get_supabase_uid('test_user'),
        'get_user_id test - hashed key returns correct user_id'
    );

SELECT
    is(
        get_user_id('expired-hashed-key-for-test'),
        null,
        'get_user_id test - expired hashed key returns null'
    );

SELECT
    is(
        get_user_id('expired-plain-key-for-test'),
        null,
        'get_user_id test - expired plain key returns null'
    );

SELECT tests.clear_authentication();

SELECT *
FROM
    finish();

ROLLBACK;
