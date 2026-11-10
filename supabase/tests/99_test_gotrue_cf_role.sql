BEGIN;

SELECT plan(5);

SELECT ok(
  (SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'gotrue_cf'),
  'gotrue_cf can log in'
);

SELECT ok(
  NOT (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'gotrue_cf'),
  'gotrue_cf has no elevated attributes'
);

SELECT schema_owner_is('auth_cf', 'gotrue_cf', 'auth_cf is owned by gotrue_cf');

SELECT is(
  (SELECT rolconfig FROM pg_catalog.pg_roles WHERE rolname = 'gotrue_cf'),
  ARRAY['search_path=auth_cf'],
  'gotrue_cf search_path is auth_cf'
);

SELECT ok(
  pg_catalog.pg_has_role('postgres', 'gotrue_cf', 'USAGE'),
  'postgres inherits gotrue_cf privileges'
);

SELECT * FROM finish();

ROLLBACK;
