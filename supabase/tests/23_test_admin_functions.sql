BEGIN;


SELECT plan(8);

-- =============================================================================
-- Test that internal functions WORK for postgres
-- =============================================================================


SELECT
    lives_ok(
        'SELECT delete_old_deleted_apps()',
        'delete_old_deleted_apps test - works for service_role'
    );

SELECT
    lives_ok(
        'SELECT cleanup_frequent_job_details()',
        'cleanup_frequent_job_details test - works for service_role'
    );

SELECT
    lives_ok(
        'SELECT remove_old_jobs()',
        'remove_old_jobs test - works for service_role'
    );

-- Test delete_user (should be safe to test as it requires authentication)
SELECT tests.authenticate_as('test_user');

-- Note: This function deletes the current user, so we test it exists but don't actually call it
SELECT
    ok(
        pg_get_functiondef('delete_user()'::regprocedure) IS NOT NULL,
        'delete_user test - function exists'
    );

SELECT tests.clear_authentication();

-- =============================================================================
-- Test that internal functions are DENIED to authenticated users
-- =============================================================================

-- Test delete_old_deleted_apps (internal cron function - should be denied to authenticated users)
SELECT tests.authenticate_as('test_admin');

SELECT
    throws_ok(
        'SELECT delete_old_deleted_apps()',
        '42501',
        'permission denied for function delete_old_deleted_apps',
        'delete_old_deleted_apps test - throws permission error for authenticated user'
    );

SELECT tests.clear_authentication();

-- Test cleanup_frequent_job_details (internal cron function - should be denied to authenticated users)
SELECT tests.authenticate_as('test_admin');

SELECT
    throws_ok(
        'SELECT cleanup_frequent_job_details()',
        '42501',
        'permission denied for function cleanup_frequent_job_details',
        'cleanup_frequent_job_details test - throws permission error for authenticated user'
    );

SELECT tests.clear_authentication();

-- Test remove_old_jobs (internal cron function - should be denied to authenticated users)
SELECT tests.authenticate_as('test_admin');

SELECT
    throws_ok(
        'SELECT remove_old_jobs()',
        '42501',
        'permission denied for function remove_old_jobs',
        'remove_old_jobs test - throws permission error for authenticated user'
    );

SELECT tests.clear_authentication();

-- =============================================================================
-- Other tests
-- =============================================================================

-- Test verify_mfa (returns true when not authenticated in test environment)
SELECT
    is(
        verify_mfa(),
        TRUE,
        'verify_mfa test - returns true in test environment'
    );

SELECT *
FROM
    finish();

ROLLBACK;
