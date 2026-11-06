BEGIN;

SELECT plan(2);

SELECT tests.create_supabase_user('console_apikey_role', 'console-apikey-role@example.com');

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('console_apikey_role'),
  'console-apikey-role@example.com',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apikeys (id, user_id, key, name)
VALUES (
  89001,
  tests.get_supabase_uid('console_apikey_role'),
  'kept-server-key',
  'kept-server-key'
);

SELECT is(
  (SELECT key FROM public.apikeys WHERE id = 89001),
  'kept-server-key',
  'a postgres session with no request role still supplies the key'
);

DELETE FROM public.apikeys WHERE id = 89001;

SELECT set_config('request.jwt.claim.role', 'authenticated', true);

INSERT INTO public.apikeys (id, user_id, key, name)
VALUES (
  89002,
  tests.get_supabase_uid('console_apikey_role'),
  'caller-supplied-key',
  'caller-supplied-key'
);

SELECT is(
  (SELECT key FROM public.apikeys WHERE id = 89002) IS DISTINCT FROM 'caller-supplied-key',
  true,
  'an authenticated request role regenerates the key when session_user is postgres'
);

SELECT * FROM finish();

ROLLBACK;
