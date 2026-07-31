-- 10_utility_functions.sql
BEGIN;


SELECT plan(8);

-- Test get_user_id
SELECT
    results_eq(
        'SELECT get_user_id(''ae6e7458-c46d-4c00-aa3b-153b0b8520ea'')',
        $$VALUES ('6aa76066-55ef-4238-ade6-0b32334a4097'::uuid)$$,
        'get_user_id test - correct user ID'
    );

SELECT
    results_eq(
        'SELECT get_user_id(''non_existent_key'')',
        $$VALUES (NULL::uuid)$$,
        'get_user_id test - key does not exist'
    );

-- Test get_user_id negative cases
SELECT
    results_eq(
        'SELECT get_user_id('''')',
        $$VALUES (NULL::uuid)$$,
        'get_user_id test - empty string returns null'
    );

SELECT
    results_eq(
        'SELECT get_user_id(''invalid-format-key'')',
        $$VALUES (NULL::uuid)$$,
        'get_user_id test - malformed key returns null'
    );

SELECT
    results_eq(
        $$
            SELECT count(*)::int
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
                AND p.proname = 'get_org_owner_id'
        $$,
        $$VALUES (0)$$,
        'get_org_owner_id old API key owner helper is removed'
    );

-- Test get_user_main_org_id_by_app_id
SELECT tests.authenticate_as('test_admin');

SELECT
    results_eq(
        'SELECT get_user_main_org_id_by_app_id(''com.demoadmin.app'')',
        $$VALUES ('22dbad8a-b885-4309-9b3b-a09f8460fb6d'::uuid)$$,
        'get_user_main_org_id_by_app_id test - correct org ID'
    );

SELECT
    results_eq(
        'SELECT get_user_main_org_id_by_app_id(''non_existent_app'')',
        $$VALUES (NULL::uuid)$$,
        'get_user_main_org_id_by_app_id test - app does not exist'
    );

-- Test get_user_main_org_id_by_app_id negative case
SELECT
    results_eq(
        'SELECT get_user_main_org_id_by_app_id('''')',
        $$VALUES (NULL::uuid)$$,
        'get_user_main_org_id_by_app_id test - empty string returns null'
    );

SELECT *
FROM
    finish();

ROLLBACK;
