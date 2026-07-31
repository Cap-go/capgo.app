BEGIN;


SELECT plan(15);

SELECT tests.authenticate_as('test_user');

-- Test exist_app_v2
SELECT
    is(
        exist_app_v2('com.demo.app'),
        true,
        'exist_app_v2 test - app exists'
    );

SELECT
    is(
        exist_app_v2('non_existent_app'),
        false,
        'exist_app_v2 test - app does not exist'
    );

SELECT tests.clear_authentication();

-- Test exist_app_versions
SELECT tests.authenticate_as('test_user');

SELECT
    is(
        exist_app_versions('com.demo.app', '1.0.0'),
        true,
        'exist_app_versions test - version exists'
    );

SELECT
    is(
        exist_app_versions('com.demo.app', 'non_existent_version'),
        false,
        'exist_app_versions test - version does not exist'
    );

SELECT tests.clear_authentication();

-- Test exist_app_versions authorization
SELECT
    set_config('request.headers', '{}', true);

SELECT
    is(
        exist_app_versions('com.demo.app', '1.0.0'),
        false,
        'exist_app_versions test - anonymous caller without capgkey cannot enumerate version'
    );

SELECT
    set_config(
        'request.headers',
        '{"capgkey":"ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}',
        true
    );

SELECT
    is(
        exist_app_versions('com.demo.app', '1.0.0'),
        true,
        'exist_app_versions test - valid capgkey header can read existing version'
    );

SELECT
    set_config('request.headers', '{}', true);

SELECT
    is(
        exist_app_versions(
            'com.demo.app',
            '1.0.0',
            'ae6e7458-c46d-4c00-aa3b-153b0b8520ea'
        ),
        true,
        'exist_app_versions test - valid apikey argument can read existing version'
    );

SELECT
    is(
        exist_app_versions('com.demo.app', '1.0.0', 'not-a-real-key'),
        false,
        'exist_app_versions test - invalid apikey argument cannot enumerate version'
    );

SELECT tests.clear_authentication();

SELECT
    set_config('request.headers', '{}', true);

-- Test get_app_versions
SELECT tests.authenticate_as('test_user');

SELECT
    is(
        (
            SELECT apps.user_id
            FROM
                apps
            WHERE
                apps.app_id = 'com.demo.app'
        ),
        '6aa76066-55ef-4238-ade6-0b32334a4097',
        'Check if get_app_versions returns the correct user_id'
    );

SELECT
    is(
        get_user_main_org_id_by_app_id('com.demo.app'),
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
        'get_user_main_org_id_by_app_id test - find the org by appID'
    );

SELECT
    is(
        get_user_main_org_id('046a36ac-e03c-4590-9257-bd6c9dba9ee8'),
        null,
        'get_user_main_org_id test - find the org'
    );

SELECT
    is(
        is_member_of_org(
            '6aa76066-55ef-4238-ade6-0b32334a4097',
            '046a36ac-e03c-4590-9257-bd6c9dba9ee8'
        ),
        true,
        'is_member_of_org test - user is member of org'
    );

SELECT
    is(
        (
            SELECT user_id
            FROM
                apikeys
            WHERE
                key = 'ae6e7458-c46d-4c00-aa3b-153b0b8520ea'
        ),
        '6aa76066-55ef-4238-ade6-0b32334a4097',
        'Check if apikey is associated with the correct user'
    );

SELECT
    is(
        get_app_versions(
            'com.demo.app',
            '1.0.0',
            'ae6e7458-c46d-4c00-aa3b-153b0b8520ea'
        ),
        3,
        'get_app_versions test - version exists'
    );

SELECT
    is(
        get_app_versions(
            'com.demo.app',
            'non_existent_version',
            'ae6e7458-c46d-4c00-aa3b-153b0b8520eb'
        ),
        null,
        'get_app_versions test - version does not exist'
    );

SELECT tests.clear_authentication();

SELECT *
FROM
    finish();

ROLLBACK;
