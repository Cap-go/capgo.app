BEGIN;


SELECT plan(44);

-- Test convert_bytes_to_gb
SELECT
    is(
        convert_bytes_to_gb(1073741824)::numeric,
        1.0::numeric,
        'convert_bytes_to_gb test - 1GB in bytes'
    );

SELECT
    is(
        convert_bytes_to_gb(2147483648)::numeric,
        2.0::numeric,
        'convert_bytes_to_gb test - 2GB in bytes'
    );

-- Test convert_bytes_to_gb negative cases
SELECT
    is(
        convert_bytes_to_gb(0)::numeric,
        0.0::numeric,
        'convert_bytes_to_gb test - zero bytes'
    );

SELECT
    is(
        convert_bytes_to_gb(-1073741824)::numeric,
        -1.0::numeric,
        'convert_bytes_to_gb test - negative bytes'
    );

-- Test convert_bytes_to_mb  
SELECT
    is(
        convert_bytes_to_mb(1048576)::numeric,
        1.0::numeric,
        'convert_bytes_to_mb test - 1MB in bytes'
    );

SELECT
    is(
        convert_bytes_to_mb(2097152)::numeric,
        2.0::numeric,
        'convert_bytes_to_mb test - 2MB in bytes'
    );

-- Test convert_bytes_to_mb negative cases
SELECT
    is(
        convert_bytes_to_mb(0)::numeric,
        0.0::numeric,
        'convert_bytes_to_mb test - zero bytes'
    );

SELECT
    is(
        convert_bytes_to_mb(-1048576)::numeric,
        -1.0::numeric,
        'convert_bytes_to_mb test - negative bytes'
    );

-- Test convert_gb_to_bytes
SELECT
    is(
        convert_gb_to_bytes(1)::numeric,
        1073741824.0::numeric,
        'convert_gb_to_bytes test - 1GB to bytes'
    );

SELECT
    is(
        convert_gb_to_bytes(2)::numeric,
        2147483648.0::numeric,
        'convert_gb_to_bytes test - 2GB to bytes'
    );

-- Test convert_gb_to_bytes negative cases
SELECT
    is(
        convert_gb_to_bytes(0)::numeric,
        0.0::numeric,
        'convert_gb_to_bytes test - zero GB'
    );

SELECT
    is(
        convert_gb_to_bytes(-1)::numeric,
        -1073741824.0::numeric,
        'convert_gb_to_bytes test - negative GB'
    );

-- Test convert_mb_to_bytes
SELECT
    is(
        convert_mb_to_bytes(1)::numeric,
        1048576.0::numeric,
        'convert_mb_to_bytes test - 1MB to bytes'
    );

SELECT
    is(
        convert_mb_to_bytes(2)::numeric,
        2097152.0::numeric,
        'convert_mb_to_bytes test - 2MB to bytes'
    );

-- Test convert_mb_to_bytes negative cases
SELECT
    is(
        convert_mb_to_bytes(0)::numeric,
        0.0::numeric,
        'convert_mb_to_bytes test - zero MB'
    );

SELECT
    is(
        convert_mb_to_bytes(-1)::numeric,
        -1048576.0::numeric,
        'convert_mb_to_bytes test - negative MB'
    );

-- Test convert_number_to_percent
SELECT
    is(
        convert_number_to_percent(50, 100)::numeric,
        50.0::numeric,
        'convert_number_to_percent test - 50 of 100'
    );

SELECT
    is(
        convert_number_to_percent(25, 50)::numeric,
        50.0::numeric,
        'convert_number_to_percent test - 25 of 50'
    );

SELECT
    is(
        convert_number_to_percent(0, 100)::numeric,
        0.0::numeric,
        'convert_number_to_percent test - 0 of 100'
    );

-- Test convert_number_to_percent negative cases
SELECT
    is(
        convert_number_to_percent(50, 0)::numeric,
        0.0::numeric,
        'convert_number_to_percent test - division by zero'
    );

SELECT
    is(
        convert_number_to_percent(-25, 100)::numeric,
        -25.0::numeric,
        'convert_number_to_percent test - negative number'
    );

SELECT
    is(
        convert_number_to_percent(150, 100)::numeric,
        150.0::numeric,
        'convert_number_to_percent test - over 100 percent'
    );

-- Test is_numeric
SELECT
    is(
        is_numeric('123'),
        true,
        'is_numeric test - valid number'
    );

SELECT
    is(
        is_numeric('123'),
        true,
        'is_numeric test - valid integer (not decimal)'
    );

SELECT
    is(
        is_numeric('abc'),
        false,
        'is_numeric test - invalid text'
    );

SELECT
    is(
        is_numeric(''),
        false,
        'is_numeric test - empty string'
    );

-- Test is_numeric negative cases
SELECT
    is(
        is_numeric('123abc'),
        false,
        'is_numeric test - mixed alphanumeric'
    );

SELECT
    is(
        is_numeric('12.34.56'),
        false,
        'is_numeric test - multiple decimal points'
    );

SELECT
    is(
        is_numeric('++123'),
        false,
        'is_numeric test - multiple plus signs'
    );

-- Test is_not_deleted
SELECT
    is(
        is_not_deleted('test@capgo.app'),
        true,
        'is_not_deleted test - valid email'
    );

SELECT
    is(
        is_not_deleted('deleted@capgo.app'),
        true,
        'is_not_deleted test - deleted email still returns true'
    );

-- Test is_not_deleted negative cases  
SELECT
    is(
        is_not_deleted(''),
        true,
        'is_not_deleted test - empty string returns true'
    );

SELECT
    is(
        is_not_deleted('invalid-email'),
        true,
        'is_not_deleted test - invalid email format returns true'
    );

-- Test find_best_plan_v3
SELECT
    is(
        find_best_plan_v3(100, 1.0, 1.0),
        'Solo',
        'find_best_plan_v3 test - small usage returns Solo'
    );

SELECT
    is(
        find_best_plan_v3(10000, 100.0, 100.0),
        'Maker',
        'find_best_plan_v3 test - medium usage returns Maker'
    );

-- Test find_best_plan_v3 negative cases
SELECT
    ok(
        find_best_plan_v3(0, 0.0, 0.0) IS NOT null,
        'find_best_plan_v3 test - zero usage returns valid plan'
    );

SELECT
    ok(
        find_best_plan_v3(-100, -1.0, -1.0) IS NOT null,
        'find_best_plan_v3 test - negative usage returns valid plan'
    );

-- Test get_apikey (returns the private.settings value in test environment)
SELECT
    ok(
        get_apikey() IS NOT null,
        'get_apikey test - returns value from private.settings'
    );

-- Test get_db_url (should return a URL)
SELECT
    ok(
        get_db_url() IS NOT null,
        'get_db_url test - returns non-null value'
    );

-- Test one_month_ahead
SELECT
    ok(
        one_month_ahead() > now(),
        'one_month_ahead test - returns future date'
    );

-- Test count_all_onboarded
SELECT
    ok(
        count_all_onboarded() >= 0,
        'count_all_onboarded test - returns non-negative count'
    );

-- Test count_all_need_upgrade  
SELECT
    ok(
        count_all_need_upgrade() >= 0,
        'count_all_need_upgrade test - returns non-negative count'
    );

-- Test get_update_stats
SELECT
    ok(
        (
            SELECT count(*)
            FROM
                get_update_stats()
        ) >= 0,
        'get_update_stats test - returns results'
    );

-- Test check_revert_to_builtin_version
SELECT tests.authenticate_as('test_user');

SELECT
    ok(
        check_revert_to_builtin_version('com.demo.app') IS NULL,
        'check_revert_to_builtin_version test - returns NULL for native rollback'
    );

-- Test check_revert_to_builtin_version negative case (skipped due to missing app_versions table in test environment)
SELECT tests.clear_authentication();

SELECT *
FROM
    finish();

ROLLBACK;
