-- Tests for 20260804075209_user_onboarding.sql
BEGIN;

SELECT plan(26);

CREATE TEMP TABLE user_onboarding_test_context (
  jwt_id bigint,
  feature_id bigint,
  private_feature_id bigint,
  apikey_id bigint,
  service_id bigint
) ON COMMIT DROP;

GRANT ALL ON user_onboarding_test_context TO public;

SELECT has_table(
  'public',
  'user_onboarding',
  'user_onboarding table exists'
);

SELECT ok(
  (
    SELECT relrowsecurity
    FROM pg_class
    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_class.relname = 'user_onboarding'
  ),
  'user_onboarding has RLS enabled'
);

SELECT is(
  (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_onboarding'
      AND column_name = 'type'
  ),
  'text',
  'type is text'
);

SELECT is(
  (
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_onboarding'
      AND column_name = 'type'
  ),
  'NO',
  'type is not nullable'
);

SELECT is(
  (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_onboarding'
      AND column_name = 'id'
  ),
  'bigint',
  'id is a bigint'
);

SELECT is(
  (
    SELECT is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_onboarding'
      AND column_name = 'id'
  ),
  'YES',
  'id is an identity column'
);

SELECT is(
  (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_onboarding'
      AND column_name = 'user_id'
  ),
  'uuid',
  'user_id is a UUID foreign-key column'
);

SELECT is(
  (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_onboarding'
      AND column_name = 'details'
  ),
  'jsonb',
  'details is JSONB'
);

SELECT is(
  (
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_onboarding'
      AND column_name = 'source'
  ),
  'text',
  'source is a text column'
);

SELECT is(
  (
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_onboarding'
      AND column_name = 'created_at'
  ),
  'NO',
  'created_at is not nullable'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_index
    JOIN pg_class AS index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = 'public.user_onboarding'::regclass
      AND pg_index.indisprimary
      AND index_class.relname = 'user_onboarding_pkey'
  ),
  'primary key index exists for id'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'user_onboarding'
      AND indexname = 'user_onboarding_user_id_idx'
  ),
  'user_id index exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'user_onboarding'
      AND indexname = 'user_onboarding_user_id_type_idx'
  ),
  'user_id and type index exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_index
    JOIN pg_class AS index_class ON index_class.oid = pg_index.indexrelid
    WHERE indrelid = 'public.user_onboarding'::regclass
      AND index_class.relname = 'user_onboarding_feature_date_feature_idx'
      AND pg_get_expr(indpred, indrelid) LIKE '%feature_date%'
      AND pg_get_expr(indexprs, indrelid) LIKE '%details%'
      AND pg_get_expr(indexprs, indrelid) LIKE '%feature%'
  ),
  'feature_date feature-name partial expression index exists'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '6aa76066-55ef-4238-ade6-0b32334a4097', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{"sub":"6aa76066-55ef-4238-ade6-0b32334a4097","role":"authenticated"}', true);
SELECT set_config('request.headers', '{"capgkey":"invalid-key"}', true);

WITH inserted AS (
  INSERT INTO public.user_onboarding (type, user_id, details, source)
  VALUES (
    'dashboard_test',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    '{"step":"dashboard"}'::jsonb,
    'CLI'
  )
  RETURNING id
)
INSERT INTO user_onboarding_test_context (jwt_id)
SELECT id
FROM inserted;

SELECT is(
  (
    SELECT source
    FROM public.user_onboarding
    WHERE id = (SELECT jwt_id FROM user_onboarding_test_context)
  ),
  'dashboard',
  'JWT inserts always receive dashboard as source'
);

SELECT ok(
  (
    SELECT created_at IS NOT NULL
    FROM public.user_onboarding
    WHERE id = (SELECT jwt_id FROM user_onboarding_test_context)
  ),
  'created_at is populated automatically'
);

SELECT tests.authenticate_as_service_role();

WITH inserted AS (
  INSERT INTO public.user_onboarding (type, user_id, source)
  VALUES (
    'service_test',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    'CLI'
  )
  RETURNING id
)
UPDATE user_onboarding_test_context AS context
SET service_id = inserted.id
FROM inserted;

SELECT is(
  (
    SELECT source
    FROM public.user_onboarding
    WHERE id = (SELECT service_id FROM user_onboarding_test_context)
  ),
  'CLI',
  'service-role inserts preserve an explicit valid source'
);

WITH inserted AS (
  INSERT INTO public.user_onboarding (type, user_id, details, source)
  VALUES
    ('feature_date', NULL, '{"step":"public"}'::jsonb, 'CLI'),
    ('feature_date', '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', '{"step":"private"}'::jsonb, 'dashboard')
  RETURNING id, user_id
)
UPDATE user_onboarding_test_context AS context
SET
  feature_id = ids.feature_id,
  private_feature_id = ids.private_feature_id
FROM (
  SELECT
    max(id) FILTER (WHERE user_id IS NULL) AS feature_id,
    max(id) FILTER (WHERE user_id IS NOT NULL) AS private_feature_id
  FROM inserted
) AS ids;

SELECT is(
  (
    SELECT source
    FROM public.user_onboarding
    WHERE id = (SELECT feature_id FROM user_onboarding_test_context)
  ),
  NULL,
  'feature_date source is cleared by the trigger'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '6aa76066-55ef-4238-ade6-0b32334a4097', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{"sub":"6aa76066-55ef-4238-ade6-0b32334a4097","role":"authenticated"}', true);
SELECT set_config('request.headers', '', true);

SELECT is(
  (
    SELECT count(*)
    FROM public.user_onboarding
    WHERE id IN (
      (SELECT jwt_id FROM user_onboarding_test_context),
      (SELECT feature_id FROM user_onboarding_test_context),
      (SELECT private_feature_id FROM user_onboarding_test_context)
    )
  ),
  2::bigint,
  'JWT users see their own entries and public feature dates only'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.user_onboarding
    WHERE id = (SELECT private_feature_id FROM user_onboarding_test_context)
  ),
  0::bigint,
  'JWT users cannot see another user''s feature date'
);

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claim.role', 'anon', true);
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('request.headers', '', true);

SELECT is(
  (
    SELECT count(*)
    FROM public.user_onboarding
    WHERE id IN (
      (SELECT jwt_id FROM user_onboarding_test_context),
      (SELECT feature_id FROM user_onboarding_test_context),
      (SELECT private_feature_id FROM user_onboarding_test_context)
    )
  ),
  1::bigint,
  'anonymous users see public feature dates only'
);

SELECT set_config('request.headers', '{"capgkey":"ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);

WITH inserted AS (
  INSERT INTO public.user_onboarding (type, user_id, details, source)
  VALUES (
    'cli_test',
    public.get_user_id('ae6e7458-c46d-4c00-aa3b-153b0b8520ea'),
    '{"step":"cli"}'::jsonb,
    'dashboard'
  )
  RETURNING id
)
UPDATE user_onboarding_test_context AS context
SET apikey_id = inserted.id
FROM inserted;

SELECT is(
  (
    SELECT source
    FROM public.user_onboarding
    WHERE id = (SELECT apikey_id FROM user_onboarding_test_context)
  ),
  'CLI',
  'API-key inserts always receive CLI as source'
);

DO $$
DECLARE
  captured_sqlstate text;
BEGIN
  BEGIN
    INSERT INTO public.user_onboarding (type, details)
    VALUES ('feature_date', '{"step":"blocked"}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    captured_sqlstate := SQLSTATE;
  END;
  PERFORM set_config('tests.user_onboarding_feature_insert_sqlstate', COALESCE(captured_sqlstate, 'success'), true);
END
$$;

SELECT is(
  current_setting('tests.user_onboarding_feature_insert_sqlstate', true),
  '42501',
  'anonymous and API-key callers cannot create feature dates'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '6aa76066-55ef-4238-ade6-0b32334a4097', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{"sub":"6aa76066-55ef-4238-ade6-0b32334a4097","role":"authenticated"}', true);
SELECT set_config('request.headers', '', true);

UPDATE public.user_onboarding
SET details = '{"changed":true}'::jsonb
WHERE id = (SELECT jwt_id FROM user_onboarding_test_context);

SELECT is(
  (
    SELECT details
    FROM public.user_onboarding
    WHERE id = (SELECT jwt_id FROM user_onboarding_test_context)
  ),
  '{"step":"dashboard"}'::jsonb,
  'users cannot update onboarding entries'
);

DELETE FROM public.user_onboarding
WHERE id = (SELECT jwt_id FROM user_onboarding_test_context);

SELECT is(
  (
    SELECT count(*)
    FROM public.user_onboarding
    WHERE id = (SELECT jwt_id FROM user_onboarding_test_context)
  ),
  1::bigint,
  'users cannot delete onboarding entries'
);

SELECT tests.authenticate_as_service_role();

DO $$
DECLARE
  captured_sqlstate text;
BEGIN
  BEGIN
    INSERT INTO public.user_onboarding (type, details)
    VALUES ('non_feature_without_user', '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    captured_sqlstate := SQLSTATE;
  END;
  PERFORM set_config('tests.user_onboarding_user_required_sqlstate', COALESCE(captured_sqlstate, 'success'), true);
END
$$;

SELECT is(
  current_setting('tests.user_onboarding_user_required_sqlstate', true),
  '23514',
  'non-feature entries require a user_id'
);

SELECT *
FROM finish();

ROLLBACK;
