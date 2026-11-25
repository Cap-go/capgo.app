BEGIN;

SELECT plan(5);

SELECT ok(
  to_regclass('auth_cf.users') IS NOT NULL AND to_regclass('auth_cf.mfa_factors') IS NOT NULL,
  'auth_cf.users and auth_cf.mfa_factors exist (GoTrue tables in production, views of auth elsewhere)'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend AS d WHERE d.objid = p.oid AND d.deptype = 'e')
      AND pg_get_functiondef(p.oid) ~ '(^|[^[:alnum:]_."])"?auth"?\.("?)(users|identities|mfa_factors|sessions|sso_providers|sso_domains|saml_providers|one_time_tokens)\M'
  ),
  'no public function reads auth.* tables: they read auth_cf'
);

SELECT ok(
  pg_get_functiondef('public.verify_mfa()'::regprocedure) ~ 'auth_cf\.mfa_factors',
  'verify_mfa reads auth_cf.mfa_factors'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.copy_auth_to_auth_cf(boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.copy_auth_to_auth_cf(boolean)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.copy_auth_to_auth_cf(boolean)', 'EXECUTE'),
  'only postgres can run the auth copy'
);

SELECT throws_ok(
  'SELECT public.copy_auth_to_auth_cf(false)',
  'auth_cf.users is not a GoTrue table',
  'the copy refuses to run where auth_cf holds views of auth'
);

SELECT * FROM finish();

ROLLBACK;
