BEGIN;

SELECT plan(10);

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

SELECT ok(
  pg_catalog.has_schema_privilege('gotrue_cf', 'auth_cf', 'CREATE'),
  'gotrue_cf can create objects in auth_cf'
);

SELECT ok(
  pg_catalog.has_schema_privilege('postgres', 'auth_cf', 'CREATE'),
  'postgres can create objects in auth_cf'
);

SELECT ok(
  NOT pg_catalog.has_schema_privilege('public', 'auth_cf', 'CREATE'),
  'PUBLIC cannot create objects in auth_cf'
);

SELECT ok(
  pg_catalog.has_function_privilege('gotrue_cf', 'public.hook_send_email(jsonb)', 'EXECUTE'),
  'gotrue_cf can call the send-email auth hook'
);

SELECT ok(
  pg_catalog.has_function_privilege('gotrue_cf', 'public.hook_before_user_created(jsonb)', 'EXECUTE'),
  'gotrue_cf can call the before-user-created auth hook'
);

SELECT * FROM finish();

ROLLBACK;
