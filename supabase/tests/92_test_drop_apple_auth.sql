BEGIN;

SELECT plan(3);

SELECT ok(pg_catalog.to_regclass('public.apple_auth_names') IS NULL, 'apple_auth_names is removed');
SELECT ok(pg_catalog.to_regclass('public.apple_auth_attempts') IS NULL, 'apple_auth_attempts is removed');
SELECT ok(pg_catalog.to_regclass('public.apple_auth_token_uses') IS NULL, 'apple_auth_token_uses is removed');

SELECT * FROM finish();

ROLLBACK;
