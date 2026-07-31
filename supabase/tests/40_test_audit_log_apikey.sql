-- Test that audit logs are created correctly when using API key authentication
-- This verifies API-key actor attribution in audit_logs through the current
-- request_actor_user_id() identity helper.
BEGIN;

-- Use existing seed identities:
-- API key: ae6e7458-c46d-4c00-aa3b-153b0b8520ea
-- mode: all, user: 6aa76066-55ef-4238-ade6-0b32334a4097
-- Org: 046a36ac-e03c-4590-9257-bd6c9dba9ee8
-- App: com.demo.app

SELECT plan(19);

-- Test 1: audit_logs_allowed_orgs should fail fast when no auth and no
-- API key header is set
DO $$
BEGIN
  PERFORM set_config('request.headers', '{}', true);
END $$;

SELECT
    is(
        public.audit_logs_allowed_orgs(),
        '{}'::uuid [],
        'audit_logs_allowed_orgs returns empty without auth or API key'
    );

-- Test 2: audit_logs_allowed_orgs should include the org for a valid API key
DO $$
BEGIN
  PERFORM set_config('request.headers', '{"capgkey": "ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);
END $$;

SELECT
    ok(
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid
        = any(public.audit_logs_allowed_orgs()),
        'audit_logs_allowed_orgs includes the org for API key requests'
    );

-- Test 3: policy should wrap audit_logs_allowed_orgs in SELECT (initPlan)
SELECT
    ok(
        position(
            'audit_logs_allowed_orgs' IN (
                SELECT pg_get_expr(p.polqual, p.polrelid)
                FROM pg_policy AS p
                INNER JOIN pg_class AS c ON p.polrelid = c.oid
                INNER JOIN pg_namespace AS n ON c.relnamespace = n.oid
                WHERE
                    n.nspname = 'public'
                    AND c.relname = 'audit_logs'
                    AND p.polname
                    = 'Allow select via RBAC'
            )
        ) > 0
        AND (
            SELECT pg_get_expr(p.polqual, p.polrelid)
            FROM pg_policy AS p
            INNER JOIN pg_class AS c ON p.polrelid = c.oid
            INNER JOIN pg_namespace AS n ON c.relnamespace = n.oid
            WHERE
                n.nspname = 'public'
                AND c.relname = 'audit_logs'
                AND p.polname
                    = 'Allow select via RBAC'
        ) ~* 'ANY\s*\([^;]*SELECT[^;]*audit_logs_allowed_orgs',
        'audit_logs SELECT policy uses initPlan-wrapped'
        || ' audit_logs_allowed_orgs()'
    );

-- Test 4: audit_logs direct table reads should keep API key support
SELECT
    ok(
        'anon'::regrole::oid = any(p.polroles)
        AND 'authenticated'::regrole::oid = any(p.polroles),
        'audit_logs SELECT policy targets anon and authenticated'
    )
FROM pg_policy AS p
INNER JOIN pg_class AS c ON p.polrelid = c.oid
INNER JOIN pg_namespace AS n ON c.relnamespace = n.oid
WHERE
    n.nspname = 'public'
    AND c.relname = 'audit_logs'
    AND p.polname = 'Allow select via RBAC';

-- Test 5: anon without a Capgo API key gets an empty result through RLS
INSERT INTO public.audit_logs (
    table_name,
    record_id,
    operation,
    user_id,
    org_id,
    old_record,
    new_record,
    changed_fields
) VALUES (
    'test_rls_probe',
    'rls-probe',
    'INSERT',
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
    '{}'::jsonb,
    '{}'::jsonb,
    ARRAY['rls_probe']::text []
);

SET LOCAL ROLE anon;

DO $$
DECLARE
  v_visible boolean;
BEGIN
  PERFORM set_config('request.headers', '{}', true);

  SELECT EXISTS(SELECT 1 FROM public.audit_logs LIMIT 1) INTO v_visible;

  IF v_visible THEN
    RAISE EXCEPTION 'anon without capgkey can read audit_logs';
  END IF;
END $$;

RESET ROLE;

SELECT ok(TRUE, 'anon without capgkey cannot read audit_logs directly');

-- Test 6: Verify the current request identity helper resolves the API-key user.
SELECT set_config('request.headers', '{"capgkey": "ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);
SELECT
  is(
    public.request_actor_user_id(),
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
    'request_actor_user_id returns the API-key user'
  );

-- Test 7: Legacy identity helpers must not survive the RBAC cleanup.
SELECT
  ok(
    to_regprocedure('public.get_identity()') IS NULL,
    'legacy get_identity helper is removed'
  );

-- Test 8: Insert app_version with API key context and verify audit log is
-- created
DO $$
DECLARE
  v_version_id bigint;
  v_audit_count int;
BEGIN
  -- Set API key context
  PERFORM set_config('request.headers', '{"capgkey": "ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);

  -- Insert a new app_version
  INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
  VALUES ('com.demo.app', '99.0.0-test-audit', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', 'r2')
  RETURNING id INTO v_version_id;

  -- Check that an audit log was created
  SELECT COUNT(*) INTO v_audit_count
  FROM public.audit_logs
  WHERE table_name = 'app_versions'
    AND record_id = v_version_id::text
    AND operation = 'INSERT'
    AND user_id = '6aa76066-55ef-4238-ade6-0b32334a4097';

  IF v_audit_count = 0 THEN
    RAISE EXCEPTION 'No audit log created for app_version INSERT with API key';
  END IF;

  RAISE NOTICE 'Audit log created for app_version INSERT (version_id: %)', v_version_id;
END $$;

SELECT ok(TRUE, 'app_version INSERT with API key creates audit log');

-- Test 9: Update app_version with API key context and verify audit log is
-- created
DO $$
DECLARE
  v_version_id bigint;
  v_audit_count int;
BEGIN
  -- Set API key context
  PERFORM set_config('request.headers', '{"capgkey": "ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);

  SELECT id INTO v_version_id
  FROM public.app_versions
  WHERE name = '99.0.0-test-audit' AND app_id = 'com.demo.app';

  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'No app_version found for API key audit UPDATE test';
  END IF;

  -- Update the app_version
  UPDATE public.app_versions
  SET comment = 'Updated via API key test'
  WHERE id = v_version_id;

  -- Check that an audit log was created for the UPDATE
  SELECT COUNT(*) INTO v_audit_count
  FROM public.audit_logs
  WHERE table_name = 'app_versions'
    AND record_id = v_version_id::text
    AND operation = 'UPDATE'
    AND user_id = '6aa76066-55ef-4238-ade6-0b32334a4097'
    AND 'comment' = ANY(changed_fields);

  IF v_audit_count = 0 THEN
    RAISE EXCEPTION 'No audit log created for app_version UPDATE with API key';
  END IF;

  RAISE NOTICE 'Audit log created for app_version UPDATE';
END $$;

SELECT
    ok(
        TRUE,
        'app_version UPDATE with API key creates audit log'
        || ' with changed_fields'
    );

-- Test 10: Delete app_version with API key context and verify audit log is
-- created
DO $$
DECLARE
  v_version_id bigint;
  v_audit_count int;
BEGIN
  -- Set API key context
  PERFORM set_config('request.headers', '{"capgkey": "ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);

  -- Get the version id before deleting
  SELECT id INTO v_version_id
  FROM public.app_versions
  WHERE name = '99.0.0-test-audit' AND app_id = 'com.demo.app';

  -- Delete the app_version
  DELETE FROM public.app_versions
  WHERE name = '99.0.0-test-audit' AND app_id = 'com.demo.app';

  -- Check that an audit log was created for the DELETE
  SELECT COUNT(*) INTO v_audit_count
  FROM public.audit_logs
  WHERE table_name = 'app_versions'
    AND record_id = v_version_id::text
    AND operation = 'DELETE'
    AND user_id = '6aa76066-55ef-4238-ade6-0b32334a4097';

  IF v_audit_count = 0 THEN
    RAISE EXCEPTION 'No audit log created for app_version DELETE with API key';
  END IF;

  RAISE NOTICE 'Audit log created for app_version DELETE (version_id: %)', v_version_id;
END $$;

SELECT ok(TRUE, 'app_version DELETE with API key creates audit log');

-- Test 11: Verify audit log contains correct old_record and new_record data
DO $$
DECLARE
  v_version_id bigint;
  v_audit_record record;
BEGIN
  -- Set API key context
  PERFORM set_config('request.headers', '{"capgkey": "ae6e7458-c46d-4c00-aa3b-153b0b8520ea"}', true);

  -- Insert a new app_version
  INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider, comment)
  VALUES ('com.demo.app', '99.0.1-test-audit', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', 'r2', 'Initial comment')
  RETURNING id INTO v_version_id;

  -- Check the INSERT audit log
  SELECT * INTO v_audit_record
  FROM public.audit_logs
  WHERE table_name = 'app_versions'
    AND record_id = v_version_id::text
    AND operation = 'INSERT'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_audit_record.old_record IS NOT NULL THEN
    RAISE EXCEPTION 'INSERT audit log should have NULL old_record';
  END IF;

  IF v_audit_record.new_record IS NULL THEN
    RAISE EXCEPTION 'INSERT audit log should have non-NULL new_record';
  END IF;

  IF v_audit_record.new_record->>'name' != '99.0.1-test-audit' THEN
    RAISE EXCEPTION 'INSERT audit log new_record should contain the version name';
  END IF;

  -- Update the version
  UPDATE public.app_versions
  SET comment = 'Updated comment'
  WHERE id = v_version_id;

  -- Check the UPDATE audit log
  SELECT * INTO v_audit_record
  FROM public.audit_logs
  WHERE table_name = 'app_versions'
    AND record_id = v_version_id::text
    AND operation = 'UPDATE'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_audit_record.old_record IS NULL THEN
    RAISE EXCEPTION 'UPDATE audit log should have non-NULL old_record';
  END IF;

  IF v_audit_record.new_record IS NULL THEN
    RAISE EXCEPTION 'UPDATE audit log should have non-NULL new_record';
  END IF;

  IF v_audit_record.old_record->>'comment' != 'Initial comment' THEN
    RAISE EXCEPTION 'UPDATE audit log old_record should contain the old comment';
  END IF;

  IF v_audit_record.new_record->>'comment' != 'Updated comment' THEN
    RAISE EXCEPTION 'UPDATE audit log new_record should contain the new comment';
  END IF;

  -- Cleanup
  DELETE FROM public.app_versions WHERE id = v_version_id;

  RAISE NOTICE 'Audit log old_record and new_record verification passed';
END $$;

SELECT ok(TRUE, 'audit log contains correct old_record and new_record data');

-- Tests 12-16: org ids stay safe for retained audit-log lookup
SELECT ok(
    EXISTS (
        SELECT 1
        FROM pg_trigger AS t
        INNER JOIN pg_class AS c ON c.oid = t.tgrelid
        INNER JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE
            n.nspname = 'public'
            AND c.relname = 'orgs'
            AND t.tgname = 'lock_org_tombstone_guard'
            AND NOT t.tgisinternal
            AND (t.tgtype & 1) = 1
            AND (t.tgtype & 2) = 2
            AND (t.tgtype & 4) = 4
            AND (t.tgtype & 8) = 8
            AND (t.tgtype & 16) = 16
    )
    AND position(
        'lock_rbac_orgs' IN pg_get_functiondef(
            'public.lock_org_tombstone_guard()'::regprocedure
        )
    ) > 0
    AND position(
        'LOCK TABLE' IN pg_get_functiondef(
            'public.lock_org_tombstone_guard()'::regprocedure
        )
    ) = 0,
    'org tombstone guard serializes matching org ids with a row-level lock'
);

INSERT INTO public.orgs (
    id,
    created_by,
    name,
    management_email
) VALUES (
    '0e5b4c90-f3fa-49d8-a9f7-1f83b57ec2a1'::uuid,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
    'Audit Tombstone Test Org',
    'audit-tombstone@test.com'
);

SELECT throws_ok(
    $q$
        UPDATE public.orgs
        SET id = '18a04286-8f89-4e8b-825f-d045e4c823b4'::uuid
        WHERE id = '0e5b4c90-f3fa-49d8-a9f7-1f83b57ec2a1'::uuid;
    $q$,
    'P0001',
    'org_id_update_forbidden',
    'org id cannot be changed after creation'
);

DELETE FROM public.orgs
WHERE id = '0e5b4c90-f3fa-49d8-a9f7-1f83b57ec2a1'::uuid;

SELECT ok(
    EXISTS (
        SELECT 1
        FROM public.org_id_tombstones
        WHERE
            org_id = '0e5b4c90-f3fa-49d8-a9f7-1f83b57ec2a1'::uuid
    ),
    'deleted org id is tombstoned'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM public.audit_logs
        WHERE
            org_id = '0e5b4c90-f3fa-49d8-a9f7-1f83b57ec2a1'::uuid
            AND table_name = 'orgs'
            AND operation = 'DELETE'
    ),
    'deleted org audit log remains retained'
);

SELECT throws_ok(
    $q$
        INSERT INTO public.orgs (
            id,
            created_by,
            name,
            management_email
        ) VALUES (
            '0e5b4c90-f3fa-49d8-a9f7-1f83b57ec2a1'::uuid,
            '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
            'Reused Audit Tombstone Test Org',
            'audit-tombstone-reuse@test.com'
        );
    $q$,
    'P0001',
    'org_id_reuse_forbidden',
    'deleted org id cannot be reused'
);


-- Test 18: background counter updates must not create audit or webhook work.
DO $$
DECLARE
    v_before_audit_id bigint;
BEGIN
    PERFORM set_config('request.headers', '{}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '{}', true);

    SELECT COALESCE(MAX(id), 0) INTO v_before_audit_id
    FROM public.audit_logs;

    UPDATE public.apps
    SET channel_device_count = channel_device_count + 1,
        updated_at = now()
    WHERE app_id = 'com.demo.app';

    IF EXISTS (
        SELECT 1
        FROM public.audit_logs
        WHERE id > v_before_audit_id
    ) THEN
        RAISE EXCEPTION 'background counter update created an audit log';
    END IF;
END $$;

SELECT ok(TRUE, 'background counter updates do not create audit logs');

-- Test 19: read-only keys cannot be attributed to a mutation.
DO $$
DECLARE
    v_version_id bigint;
    v_actor_type text;
BEGIN
    PERFORM set_config('request.headers', '{"capgkey": "67eeaff4-ae4c-49a6-8eb1-0875f5369de0"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '{}', true);

    INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider)
    VALUES (
        'com.demo.app',
        '99.0.3-test-read-key-audit',
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
        '6aa76066-55ef-4238-ade6-0b32334a4097',
        'r2'
    )
    RETURNING id INTO v_version_id;

    SELECT actor_type INTO v_actor_type
    FROM public.audit_logs
    WHERE table_name = 'app_versions'
      AND record_id = v_version_id::text
      AND operation = 'INSERT'
    ORDER BY id DESC
    LIMIT 1;

    IF v_actor_type IS DISTINCT FROM 'system' THEN
        RAISE EXCEPTION 'read-only key was attributed to a mutation';
    END IF;

    DELETE FROM public.app_versions WHERE id = v_version_id;
END $$;

SELECT ok(TRUE, 'read-only API keys are not attributed to mutations');
SELECT is(
    has_function_privilege(
        'anon',
        'public.delete_accounts_marked_for_deletion()'::regprocedure,
        'EXECUTE'
    ),
    false,
    'anon cannot execute delete_accounts_marked_for_deletion'
);

-- Finish
SELECT * FROM finish(); -- noqa: AM04

-- Roll back any changes done in this test
ROLLBACK;
