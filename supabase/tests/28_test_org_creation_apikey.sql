-- Reproduce org creation behavior with API key vs JWT (RLS).
-- Direct table inserts are JWT-only; API-key org creation goes through the checked API route.
BEGIN;

SELECT plan(2);

DO $$
DECLARE
  captured_sqlstate text;
BEGIN
  SET LOCAL role TO anon;
  PERFORM set_config('request.headers', '{"capgkey": "ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);

  BEGIN
    INSERT INTO public.orgs (created_by, name, management_email)
    VALUES ('6aa76066-55ef-4238-ade6-0b32334a4097', 'SQL Apikey Org', 'test@capgo.app');
  EXCEPTION WHEN OTHERS THEN
    captured_sqlstate := SQLSTATE;
  END;

  PERFORM set_config('tests.org_creation_apikey_sqlstate', COALESCE(captured_sqlstate, 'success'), true);
END $$;

SELECT
    is(
        current_setting('tests.org_creation_apikey_sqlstate', true),
        '42501',
        'API key direct org insert is rejected by JWT-only org RLS'
    );

DO $$
BEGIN
  SET LOCAL role TO authenticated;
  SET LOCAL request.jwt.claims TO '{"sub": "6aa76066-55ef-4238-ade6-0b32334a4097", "aal": "aal1"}';

  INSERT INTO public.orgs (created_by, name, management_email)
  VALUES ('6aa76066-55ef-4238-ade6-0b32334a4097', 'SQL JWT Org', 'test@capgo.app');
EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION 'Authenticated insert failed: %', SQLERRM;
END $$;

SELECT tests.authenticate_as_service_role();

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM public.orgs
            WHERE created_by = '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid
              AND name = 'SQL JWT Org'
        ),
        'Authenticated user direct org insert succeeded'
    );

SELECT *
FROM
    finish();

ROLLBACK;
