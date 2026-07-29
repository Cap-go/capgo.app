BEGIN;

SELECT plan(28);

-- Member of admin org can read billing/trial RPCs
SELECT tests.authenticate_as('test_admin');

SELECT
    is(
        is_paying_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        true,
        'is_paying_org - org admin can read paying state'
    );

SELECT
    is(
        public.is_trial_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        (
            SELECT COALESCE(
                GREATEST((trial_at::date - CURRENT_DATE), 0),
                0
            )::integer
            FROM public.stripe_info
            WHERE customer_id = 'cus_Pa0k8TO6HVln6A'
        ),
        'is_trial_org - org admin can read trial days'
    );

SELECT
    is(
        is_paying_and_good_plan_org_action(
            '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
            ARRAY['mau']::public.action_type []
        ),
        true,
        'is_paying_and_good_plan_org_action - org admin can read plan status'
    );

-- Non-member should be denied by org authorization checks
SELECT tests.create_supabase_user(
    'org_status_non_member',
    'org_status_non_member@test.local'
);
SELECT tests.authenticate_as('org_status_non_member');

SELECT
    is(
        is_paying_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        false,
        'is_paying_org - non-member org user gets false'
    );

SELECT
    is(
        is_trial_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        0,
        'is_trial_org - non-member org user gets 0'
    );

SELECT
    is(
        is_paying_and_good_plan_org_action(
            '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
            ARRAY['mau']::public.action_type []
        ),
        false,
        'is_paying_and_good_plan_org_action - non-member org user gets false'
    );

-- Anonymous API-key callers should be able to execute these RPCs, but the
-- function bodies still gate the result through request_has_org_read_access().
SELECT tests.clear_authentication();
DO $$
BEGIN
    PERFORM set_config('request.jwt.claims', '{}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.headers', '{}', true);
END $$;

SELECT
    is(
        has_function_privilege(
            'anon'::name,
            'public.is_paying_org(uuid)'::regprocedure,
            'EXECUTE'
        ),
        true,
        'is_paying_org - anonymous execute is allowed for API-key CLI callers'
    );

SELECT
    is(
        has_function_privilege(
            'anon'::name,
            'public.is_trial_org(uuid)'::regprocedure,
            'EXECUTE'
        ),
        true,
        'is_trial_org - anonymous execute is allowed for API-key CLI callers'
    );

DO $$
BEGIN
    PERFORM set_config('request.headers', '{"capgkey": "ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);
END $$;

SELECT
    is(
        is_paying_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
        (
            SELECT EXISTS (
                SELECT 1
                FROM public.stripe_info
                WHERE customer_id = 'cus_Q38uE91NP8Ufqc'
                    AND status = 'succeeded'
            )
        ),
        'is_paying_org - anonymous API-key caller can read its own org paying state'
    );

SELECT
    is(
        public.is_trial_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
        (
            SELECT COALESCE(
                GREATEST((trial_at::date - CURRENT_DATE), 0),
                0
            )::integer
            FROM public.stripe_info
            WHERE customer_id = 'cus_Q38uE91NP8Ufqc'
        ),
        'is_trial_org - anonymous API-key caller can read its own org trial days'
    );

DO $$
BEGIN
    PERFORM set_config('request.headers', '{"capgkey": "invalid-key"}', true);
END $$;

SELECT
    is(
        is_paying_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
        false,
        'is_paying_org - anonymous invalid API key gets false'
    );

SELECT
    is(
        public.is_trial_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
        0,
        'is_trial_org - anonymous invalid API key gets 0'
    );

DO $$
BEGIN
    PERFORM set_config('request.headers', '{}', true);
END $$;

SELECT
    is(
        is_paying_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
        false,
        'is_paying_org - anonymous caller without API key gets false'
    );

SELECT
    is(
        public.is_trial_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
        0,
        'is_trial_org - anonymous caller without API key gets 0'
    );

SELECT
    throws_ok(
        'SELECT is_paying_and_good_plan_org_action('
        || '''22dbad8a-b885-4309-9b3b-a09f8460fb6d'', '
        || 'ARRAY[''mau'']::public.action_type[])',
        '42501',
        'permission denied for function is_paying_and_good_plan_org_action',
        'is_paying_and_good_plan_org_action - anonymous call is blocked'
    );

-- service role keeps backend-style access
SELECT tests.authenticate_as_service_role();
DO $$
BEGIN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.headers', '{}', true);
END $$;

SELECT
    is(
        is_paying_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        true,
        'is_paying_org - service role can read paying state'
    );

SELECT
    is(
        public.is_trial_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        (
            SELECT COALESCE(
                GREATEST((trial_at::date - CURRENT_DATE), 0),
                0
            )::integer
            FROM public.stripe_info
            WHERE customer_id = 'cus_Pa0k8TO6HVln6A'
        ),
        'is_trial_org - service role can read trial days'
    );

SELECT
    is(
        is_paying_and_good_plan_org_action(
            '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
            ARRAY['mau']::public.action_type []
        ),
        true,
        'is_paying_and_good_plan_org_action - service role can read plan status'
    );

-- has_usage_credits_org: service role can read the credit flag
SELECT
    is(
        public.has_usage_credits_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        (
            SELECT has_usage_credits
            FROM public.orgs
            WHERE id = '22dbad8a-b885-4309-9b3b-a09f8460fb6d'
        ),
        'has_usage_credits_org - service role can read credit flag'
    );

-- Org admin can read credit flag
SELECT tests.authenticate_as('test_admin');

SELECT
    is(
        public.has_usage_credits_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        (
            SELECT has_usage_credits
            FROM public.orgs
            WHERE id = '22dbad8a-b885-4309-9b3b-a09f8460fb6d'
        ),
        'has_usage_credits_org - org admin can read credit flag'
    );

-- Non-member denied
SELECT tests.authenticate_as('org_status_non_member');

SELECT
    is(
        public.has_usage_credits_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        false,
        'has_usage_credits_org - non-member gets false'
    );

-- Anonymous execute allowed; body still gated by auth
SELECT tests.clear_authentication();
DO $$
BEGIN
    PERFORM set_config('request.jwt.claims', '{}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.headers', '{}', true);
END $$;

SELECT
    is(
        has_function_privilege(
            'anon'::name,
            'public.has_usage_credits_org(uuid)'::regprocedure,
            'EXECUTE'
        ),
        true,
        'has_usage_credits_org - anonymous execute is allowed for API-key CLI callers'
    );

SELECT
    is(
        has_function_privilege(
            'anon'::name,
            'public.has_usage_credits_org(uuid,character varying)'::regprocedure,
            'EXECUTE'
        ),
        true,
        'has_usage_credits_org(appid) - anonymous execute is allowed for API-key CLI callers'
    );

-- Org-scoped API key can read credit flag without appid
DO $$
BEGIN
    PERFORM set_config('request.headers', '{"capgkey": "ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);
END $$;

SELECT
    is(
        public.has_usage_credits_org('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
        (
            SELECT has_usage_credits
            FROM public.orgs
            WHERE id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
        ),
        'has_usage_credits_org - org-scoped API key can read credit flag'
    );

-- Strip org bindings from the seeded admin app uploader key so it is truly
-- app-scoped for this transaction (rolled back at the end of the test).
SELECT tests.authenticate_as_service_role();
DELETE FROM public.role_bindings
WHERE principal_type = public.rbac_principal_apikey()
  AND principal_id = (
    SELECT rbac_id
    FROM public.apikeys
    WHERE key = 'c591b04e-cf29-4945-b9a0-776d0672061e'
  )
  AND scope_type = public.rbac_scope_org();

SELECT tests.clear_authentication();
DO $$
BEGIN
    PERFORM set_config('request.jwt.claims', '{}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.headers', '{"capgkey": "c591b04e-cf29-4945-b9a0-776d0672061e"}', true);
END $$;

SELECT
    is(
        public.has_usage_credits_org('22dbad8a-b885-4309-9b3b-a09f8460fb6d'),
        false,
        'has_usage_credits_org - app-scoped API key without appid gets false'
    );

SELECT
    is(
        public.has_usage_credits_org(
            '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
            'com.demoadmin.app'
        ),
        (
            SELECT has_usage_credits
            FROM public.orgs
            WHERE id = '22dbad8a-b885-4309-9b3b-a09f8460fb6d'
        ),
        'has_usage_credits_org - app-scoped API key with appid can read credit flag'
    );

SELECT
    is(
        public.is_paying_org(
            '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
            'com.demoadmin.app'
        ),
        (
            SELECT EXISTS (
                SELECT 1
                FROM public.stripe_info
                WHERE customer_id = 'cus_Pa0k8TO6HVln6A'
                    AND status = 'succeeded'
            )
        ),
        'is_paying_org(appid) - app-scoped API key can read paying state'
    );

SELECT
    is(
        public.is_trial_org(
            '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
            'com.demoadmin.app'
        ),
        (
            SELECT COALESCE(
                GREATEST((trial_at::date - CURRENT_DATE), 0),
                0
            )::integer
            FROM public.stripe_info
            WHERE customer_id = 'cus_Pa0k8TO6HVln6A'
        ),
        'is_trial_org(appid) - app-scoped API key can read trial days'
    );

SELECT * -- noqa: AM04
FROM
    finish();

ROLLBACK;
