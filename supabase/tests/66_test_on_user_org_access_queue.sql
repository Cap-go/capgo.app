BEGIN;

SELECT plan(20);

CREATE OR REPLACE FUNCTION pg_temp.on_user_org_access_messages(
    p_binding_id uuid
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF pg_catalog.to_regclass('pgmq.q_on_user_org_access') IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY EXECUTE
        'SELECT message
         FROM pgmq.q_on_user_org_access
         WHERE message -> ''payload'' -> ''record'' ->> ''id'' = $1
            OR message -> ''payload'' -> ''old_record'' ->> ''id'' = $1'
        USING p_binding_id::text;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.delete_on_user_org_access_messages(
    p_binding_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF pg_catalog.to_regclass('pgmq.q_on_user_org_access') IS NULL THEN
        RETURN;
    END IF;

    EXECUTE
        'DELETE FROM pgmq.q_on_user_org_access
         WHERE message -> ''payload'' -> ''record'' ->> ''id'' = $1
            OR message -> ''payload'' -> ''old_record'' ->> ''id'' = $1'
        USING p_binding_id::text;
END;
$$;

SELECT tests.create_supabase_user(
    'on_user_org_access_actor',
    'on-user-org-access-actor@test.local'
);

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
    tests.get_supabase_uid('on_user_org_access_actor'),
    'on-user-org-access-actor@test.local',
    pg_catalog.now(),
    pg_catalog.now()
);

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
    '66000000-0000-4000-8000-000000000100'::uuid,
    tests.get_supabase_uid('on_user_org_access_actor'),
    'On User Org Access Queue Test Org',
    'on-user-org-access-org@test.local'
);

INSERT INTO public.apps (id, app_id, icon_url, user_id, name, owner_org)
VALUES (
    '66000000-0000-4000-8000-000000000200'::uuid,
    'com.test.on-user-org-access-queue',
    '',
    tests.get_supabase_uid('on_user_org_access_actor'),
    'On User Org Access Queue Test App',
    '66000000-0000-4000-8000-000000000100'::uuid
);

CREATE TEMP TABLE on_user_org_access_context AS
SELECT
    '66000000-0000-4000-8000-000000000100'::uuid AS org_id,
    '66000000-0000-4000-8000-000000000200'::uuid AS app_id,
    tests.get_supabase_uid('on_user_org_access_actor') AS actor_id,
    (
        SELECT id
        FROM public.roles
        WHERE name = public.rbac_role_org_member()
        LIMIT 1
    ) AS org_role_id,
    (
        SELECT id
        FROM public.roles
        WHERE name = public.rbac_role_app_developer()
        LIMIT 1
    ) AS app_role_id;

SELECT ok(
    EXISTS (
        SELECT 1
        FROM pgmq.list_queues()
        WHERE queue_name = 'on_user_org_access'
    ),
    'on_user_org_access queue exists'
);

SELECT is(
    (
        SELECT target::jsonb
        FROM public.cron_tasks
        WHERE name = 'high_frequency_queues'
    ),
    '[
        "credit_usage_alerts",
        "on_app_create",
        "on_app_delete",
        "on_app_update",
        "on_channel_update",
        "on_org_update",
        "on_organization_create",
        "on_user_create",
        "on_user_delete",
        "on_user_update",
        "on_version_create",
        "on_version_delete",
        "on_version_update",
        "webhook_dispatcher",
        "webhook_delivery",
        "credit_usage_posthog",
        "on_user_org_access",
        "canceled_org_retention_alerts"
    ]'::jsonb,
    'high-frequency queues retain order and append on_user_org_access then canceled_org_retention_alerts'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.cron_tasks AS cron
        CROSS JOIN
            LATERAL jsonb_array_elements_text(cron.target::jsonb)
                AS queue_name (value)
        WHERE
            cron.name = 'high_frequency_queues'
            AND queue_name.value = 'on_user_org_access'
    ),
    1::bigint,
    'high_frequency_queues contains on_user_org_access exactly once'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.cron_tasks
        WHERE
            name = 'high_frequency_queues'
            AND task_type = 'function_queue'::public.cron_task_type
            AND batch_size = 100
            AND second_interval = 10
            AND minute_interval IS NULL
            AND hour_interval IS NULL
            AND run_at_hour IS NULL
            AND run_at_minute IS NULL
            AND run_at_second IS NULL
            AND run_on_dow IS NULL
            AND run_on_day IS NULL
            AND enabled IS TRUE
    ),
    1::bigint,
    'high-frequency queues retain task type, batch, interval, and schedule'
);

SELECT is(
    (
        SELECT count(*)
        FROM pg_catalog.pg_trigger AS trg
        INNER JOIN
            pg_catalog.pg_class AS rel
            ON trg.tgrelid = rel.oid
        INNER JOIN
            pg_catalog.pg_namespace AS ns
            ON rel.relnamespace = ns.oid
        INNER JOIN
            pg_catalog.pg_proc AS pgproc
            ON trg.tgfoid = pgproc.oid
        WHERE
            NOT trg.tgisinternal
            AND ns.nspname = 'public'
            AND rel.relname = 'role_bindings'
            AND trg.tgname = 'on_user_org_access'
            AND pgproc.proname = 'trigger_http_queue_post_to_function'
    ),
    1::bigint,
    'role_bindings has exactly one on_user_org_access generic queue trigger'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trg
        INNER JOIN
            pg_catalog.pg_class AS rel
            ON trg.tgrelid = rel.oid
        INNER JOIN
            pg_catalog.pg_namespace AS ns
            ON rel.relnamespace = ns.oid
        WHERE
            NOT trg.tgisinternal
            AND ns.nspname = 'public'
            AND rel.relname = 'role_bindings'
            AND trg.tgname = 'on_user_org_access'
            AND (trg.tgtype & 1) = 1
            AND (trg.tgtype & 2) = 0
            AND (trg.tgtype & 4) = 4
            AND (trg.tgtype & 8) = 0
            AND (trg.tgtype & 16) = 16
    ),
    'on_user_org_access is row-level AFTER INSERT/UPDATE without DELETE'
);

SELECT is(
    (
        SELECT
            pg_catalog.string_agg(
                attr.attname,
                ',' ORDER BY attr.attname
            )
        FROM pg_catalog.pg_trigger AS trg
        INNER JOIN
            pg_catalog.pg_class AS rel
            ON trg.tgrelid = rel.oid
        INNER JOIN
            pg_catalog.pg_namespace AS ns
            ON rel.relnamespace = ns.oid
        CROSS JOIN
            LATERAL pg_catalog.unnest(trg.tgattr::smallint [])
                AS update_column (attnum)
        INNER JOIN pg_catalog.pg_attribute AS attr
            ON
                rel.oid = attr.attrelid
                AND update_column.attnum = attr.attnum
        WHERE
            NOT trg.tgisinternal
            AND ns.nspname = 'public'
            AND rel.relname = 'role_bindings'
            AND trg.tgname = 'on_user_org_access'
    ),
    'expires_at,is_direct,org_id,principal_id,principal_type,scope_type',
    'UPDATE events are limited to activation-relevant columns'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trg
        INNER JOIN
            pg_catalog.pg_class AS rel
            ON trg.tgrelid = rel.oid
        INNER JOIN
            pg_catalog.pg_namespace AS ns
            ON rel.relnamespace = ns.oid
        CROSS JOIN
            LATERAL (
                SELECT pg_catalog.pg_get_triggerdef(trg.oid) AS definition
            ) AS predicate
        WHERE
            NOT trg.tgisinternal
            AND ns.nspname = 'public'
            AND rel.relname = 'role_bindings'
            AND trg.tgname = 'on_user_org_access'
            AND predicate.definition LIKE '%principal_type%user%'
            AND predicate.definition LIKE '%scope_type%org%'
            AND predicate.definition LIKE '%org_id%IS NOT NULL%'
            AND predicate.definition LIKE '%is_direct%'
            AND predicate.definition LIKE '%expires_at%IS NULL%'
            AND predicate.definition LIKE '%expires_at%now()%'
    ),
    'trigger has an active direct user-to-organization WHEN predicate'
);

INSERT INTO public.role_bindings (
    id,
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    granted_by,
    reason,
    is_direct
)
SELECT
    '66000000-0000-4000-8000-000000000001'::uuid AS id,
    public.rbac_principal_user() AS principal_type,
    '66000000-0000-4000-8000-000000001001'::uuid AS principal_id,
    org_role_id AS role_id,
    public.rbac_scope_org() AS scope_type,
    org_id,
    actor_id AS granted_by,
    'qualifying active direct binding' AS reason,
    TRUE AS is_direct
FROM on_user_org_access_context;

SELECT is(
    (
        SELECT message
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000001'::uuid
        ) AS message
    ),
    (
        SELECT
            pg_catalog.jsonb_build_object(
                'function_name', 'on_user_org_access',
                'function_type', 'cloudflare',
                'payload', pg_catalog.jsonb_build_object(
                    'old_record', 'null'::jsonb,
                    'record', pg_catalog.to_jsonb(rb), -- noqa: RF03
                    'type', 'INSERT',
                    'table', 'role_bindings',
                    'schema', 'public'
                )
            )
        FROM public.role_bindings AS rb
        WHERE rb.id = '66000000-0000-4000-8000-000000000001'::uuid -- noqa: RF03
    ),
    'active direct user/org INSERT queues the exact generic envelope'
);

INSERT INTO public.role_bindings (
    id,
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    granted_by,
    expires_at,
    reason,
    is_direct
)
SELECT
    '66000000-0000-4000-8000-000000000002'::uuid AS id,
    public.rbac_principal_user() AS principal_type,
    '66000000-0000-4000-8000-000000001002'::uuid AS principal_id,
    org_role_id AS role_id,
    public.rbac_scope_org() AS scope_type,
    org_id,
    actor_id AS granted_by,
    pg_catalog.now() - interval '1 hour' AS expires_at,
    'expired binding' AS reason,
    TRUE AS is_direct
FROM on_user_org_access_context;

SELECT is(
    (
        SELECT count(*)
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000002'::uuid
        )
    ),
    0::bigint,
    'expired user-to-organization INSERT does not queue'
);

INSERT INTO public.role_bindings (
    id,
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    granted_by,
    reason,
    is_direct
)
SELECT
    '66000000-0000-4000-8000-000000000003'::uuid AS id,
    public.rbac_principal_apikey() AS principal_type,
    '66000000-0000-4000-8000-000000001003'::uuid AS principal_id,
    org_role_id AS role_id,
    public.rbac_scope_org() AS scope_type,
    org_id,
    actor_id AS granted_by,
    'API key binding' AS reason,
    TRUE AS is_direct
FROM on_user_org_access_context;

SELECT is(
    (
        SELECT count(*)
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000003'::uuid
        )
    ),
    0::bigint,
    'API key organization binding INSERT does not queue'
);

INSERT INTO public.role_bindings (
    id,
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    app_id,
    granted_by,
    reason,
    is_direct
)
SELECT
    '66000000-0000-4000-8000-000000000004'::uuid AS id,
    public.rbac_principal_user() AS principal_type,
    '66000000-0000-4000-8000-000000001004'::uuid AS principal_id,
    app_role_id AS role_id,
    public.rbac_scope_app() AS scope_type,
    org_id,
    app_id,
    actor_id AS granted_by,
    'app-scoped binding' AS reason,
    TRUE AS is_direct
FROM on_user_org_access_context;

SELECT is(
    (
        SELECT count(*)
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000004'::uuid
        )
    ),
    0::bigint,
    'app-scoped user binding INSERT does not queue'
);

SELECT throws_ok(
    $q$
        INSERT INTO public.role_bindings (
            id,
            principal_type,
            principal_id,
            role_id,
            scope_type,
            org_id,
            granted_by,
            reason,
            is_direct
        )
        SELECT
            '66000000-0000-4000-8000-000000000005'::uuid,
            public.rbac_principal_user(),
            '66000000-0000-4000-8000-000000001005'::uuid,
            org_role_id,
            public.rbac_scope_org(),
            NULL,
            actor_id,
            'invalid null-org binding',
            true
        FROM on_user_org_access_context;
    $q$,
    '23514',
    pg_catalog.concat(
        'new row for relation "role_bindings" violates check constraint ',
        '"role_bindings_check"'
    ),
    'organization-scoped binding with a null organization is rejected'
);

SELECT is(
    (
        SELECT count(*)
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000005'::uuid
        )
    ),
    0::bigint,
    'rejected null-organization INSERT does not queue'
);

INSERT INTO public.role_bindings (
    id,
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    granted_by,
    reason,
    is_direct
)
SELECT
    '66000000-0000-4000-8000-000000000006'::uuid AS id,
    public.rbac_principal_user() AS principal_type,
    '66000000-0000-4000-8000-000000001006'::uuid AS principal_id,
    org_role_id AS role_id,
    public.rbac_scope_org() AS scope_type,
    org_id,
    actor_id AS granted_by,
    'indirect binding' AS reason,
    FALSE AS is_direct
FROM on_user_org_access_context;

SELECT is(
    (
        SELECT count(*)
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000006'::uuid
        )
    ),
    0::bigint,
    'indirect user-to-organization INSERT does not queue'
);

CREATE TEMP TABLE on_user_org_access_old_records AS
SELECT
    rb.id AS binding_id,
    pg_catalog.to_jsonb(rb) AS record -- noqa: RF03
FROM public.role_bindings AS rb
WHERE rb.id IN (
    '66000000-0000-4000-8000-000000000002'::uuid,
    '66000000-0000-4000-8000-000000000006'::uuid
);

UPDATE public.role_bindings
SET expires_at = NULL
WHERE id = '66000000-0000-4000-8000-000000000002'::uuid;

SELECT is(
    (
        SELECT message
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000002'::uuid
        ) AS message
    ),
    (
        SELECT
            pg_catalog.jsonb_build_object(
                'function_name', 'on_user_org_access',
                'function_type', 'cloudflare',
                'payload', pg_catalog.jsonb_build_object(
                    'old_record', old_record.record,
                    'record', pg_catalog.to_jsonb(rb), -- noqa: RF02
                    'type', 'UPDATE',
                    'table', 'role_bindings',
                    'schema', 'public'
                )
            )
        FROM public.role_bindings AS rb
        INNER JOIN on_user_org_access_old_records AS old_record
            ON rb.id = old_record.binding_id
        WHERE rb.id = '66000000-0000-4000-8000-000000000002'::uuid
    ),
    'expired-to-active UPDATE queues the exact generic old/new envelope'
);

DO $$
BEGIN
    PERFORM pg_temp.delete_on_user_org_access_messages(
        '66000000-0000-4000-8000-000000000002'::uuid
    );
END;
$$;

UPDATE public.role_bindings
SET expires_at = pg_catalog.now() + interval '1 day'
WHERE id = '66000000-0000-4000-8000-000000000002'::uuid;

SELECT is(
    (
        SELECT count(*)
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000002'::uuid
        )
    ),
    1::bigint,
    'active-to-active UPDATE queues again for self-healing delivery'
);

UPDATE public.role_bindings
SET is_direct = TRUE
WHERE id = '66000000-0000-4000-8000-000000000006'::uuid;

SELECT is(
    (
        SELECT message
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000006'::uuid
        ) AS message
    ),
    (
        SELECT
            pg_catalog.jsonb_build_object(
                'function_name', 'on_user_org_access',
                'function_type', 'cloudflare',
                'payload', pg_catalog.jsonb_build_object(
                    'old_record', old_record.record,
                    'record', pg_catalog.to_jsonb(rb), -- noqa: RF02
                    'type', 'UPDATE',
                    'table', 'role_bindings',
                    'schema', 'public'
                )
            )
        FROM public.role_bindings AS rb
        INNER JOIN on_user_org_access_old_records AS old_record
            ON rb.id = old_record.binding_id
        WHERE rb.id = '66000000-0000-4000-8000-000000000006'::uuid
    ),
    'indirect-to-direct UPDATE queues the exact generic old/new envelope'
);

DO $$
BEGIN
    PERFORM pg_temp.delete_on_user_org_access_messages(
        '66000000-0000-4000-8000-000000000001'::uuid
    );
END;
$$;

UPDATE public.role_bindings
SET reason = 'reason-only update must not queue'
WHERE id = '66000000-0000-4000-8000-000000000001'::uuid;

SELECT is(
    (
        SELECT count(*)
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000001'::uuid
        )
    ),
    0::bigint,
    'reason-only UPDATE does not queue'
);

DELETE FROM public.role_bindings
WHERE id = '66000000-0000-4000-8000-000000000001'::uuid;

SELECT is(
    (
        SELECT count(*)
        FROM pg_temp.on_user_org_access_messages(
            '66000000-0000-4000-8000-000000000001'::uuid
        )
    ),
    0::bigint,
    'DELETE does not queue'
);

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
