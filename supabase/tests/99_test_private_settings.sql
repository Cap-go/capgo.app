BEGIN;

SELECT plan(15);

-- Access: only postgres reads private.settings; the API roles cannot reach it.
SELECT ok(
    NOT pg_catalog.has_schema_privilege('anon', 'private', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE')
    AND NOT pg_catalog.has_schema_privilege('service_role', 'private', 'USAGE'),
    'API roles have no usage on schema private'
);

SELECT ok(
    NOT pg_catalog.has_table_privilege('anon', 'private.settings', 'SELECT')
    AND NOT pg_catalog.has_table_privilege(
        'authenticated', 'private.settings', 'SELECT'
    )
    AND NOT pg_catalog.has_table_privilege(
        'service_role', 'private.settings', 'SELECT'
    ),
    'API roles cannot select private.settings'
);

SELECT ok(
    NOT pg_catalog.has_table_privilege(
        'anon', 'private.settings', 'INSERT,UPDATE,DELETE'
    )
    AND NOT pg_catalog.has_table_privilege(
        'authenticated', 'private.settings', 'INSERT,UPDATE,DELETE'
    )
    AND NOT pg_catalog.has_table_privilege(
        'service_role', 'private.settings', 'INSERT,UPDATE,DELETE'
    ),
    'API roles cannot write private.settings'
);

SELECT ok(
    NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_tables
        WHERE schemaname = 'private' AND tablename = 'settings'
    ),
    'private.settings is not replicated'
);

SELECT ok(
    NOT pg_catalog.has_function_privilege(
        'anon', 'public.get_mfa_email_otp_enforced_at()', 'EXECUTE'
    )
    AND NOT pg_catalog.has_function_privilege(
        'authenticated', 'public.get_mfa_email_otp_enforced_at()', 'EXECUTE'
    ),
    'get_mfa_email_otp_enforced_at is not callable by anon or authenticated'
);

-- No SQL function reads Vault any more.
SELECT is(
    (
        SELECT pg_catalog.count(*)::integer
        FROM pg_catalog.pg_proc AS p
        INNER JOIN pg_catalog.pg_namespace AS n ON p.pronamespace = n.oid
        WHERE
            n.nspname NOT IN ('vault', 'pg_catalog', 'information_schema')
            AND p.prosrc ILIKE '%vault.%'
    ),
    0,
    'no function outside the vault schema references vault'
);

-- The seed fills the settings the functions need.
SELECT
    is(public.get_apikey(), 'testsecret', 'get_apikey reads private.settings');
SELECT
    is(public.get_db_url(), 'http://kong:8000', 'get_db_url reads private.settings');
SELECT
    is(public.get_mfa_email_otp_enforced_at(), NULL, 'empty MFA cutoff means no cutoff');

-- Values and switches are read live from the table.
INSERT INTO private.settings (name, value)
VALUES ('CAPGO_MFA_EMAIL_OTP_ENFORCED_AT', '2026-01-01T00:00:00Z')
ON CONFLICT (name) DO UPDATE SET value = excluded.value;
SELECT is(
    public.get_mfa_email_otp_enforced_at(),
    '2026-01-01T00:00:00Z'::timestamptz,
    'MFA cutoff is parsed from private.settings'
);

DELETE FROM private.settings
WHERE name = 'CAPGO_UPDATES_CACHE_PURGE_ENABLED';
SELECT
    is(public.updates_cache_purge_enabled(), FALSE, 'purge switch defaults to off when absent');

INSERT INTO private.settings (name, value) VALUES (
    'CAPGO_UPDATES_CACHE_PURGE_ENABLED', ' On '
);
SELECT
    is(public.updates_cache_purge_enabled(), TRUE, 'purge switch reads private.settings');

INSERT INTO private.settings (name, value)
VALUES ('CAPGO_DELTA_SESSIONS_ENABLED', 'off')
ON CONFLICT (name) DO UPDATE SET value = excluded.value;
SELECT is(
    public.delta_storage_setting('CAPGO_DELTA_SESSIONS_ENABLED', TRUE),
    FALSE,
    'delta switch reads private.settings'
);
SELECT is(
    public.delta_storage_setting('CAPGO_TEST_MISSING_SWITCH', TRUE),
    TRUE,
    'missing delta switch falls back to its default'
);

INSERT INTO private.settings (name, value)
VALUES ('CAPGO_PLUGIN_STATE_SYNC_ENABLED', 'true')
ON CONFLICT (name) DO UPDATE SET value = excluded.value;
SELECT is(
    public.plugin_state_sync_enabled(),
    TRUE,
    'plugin state sync switch reads private.settings'
);

SELECT * FROM finish();

ROLLBACK;
