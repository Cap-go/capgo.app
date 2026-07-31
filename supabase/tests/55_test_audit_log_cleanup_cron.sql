BEGIN;

SELECT plan(7);

SELECT tests.authenticate_as_service_role();

SELECT ok(
    to_regprocedure('public.cleanup_old_audit_logs()') IS NOT NULL,
    'cleanup_old_audit_logs exists'
);

SELECT is(
    has_function_privilege(
        'anon',
        'public.cleanup_old_audit_logs()',
        'EXECUTE'
    ),
    FALSE,
    'anon cannot execute cleanup_old_audit_logs'
);

SELECT is(
    has_function_privilege(
        'authenticated',
        'public.cleanup_old_audit_logs()',
        'EXECUTE'
    ),
    FALSE,
    'authenticated cannot execute cleanup_old_audit_logs'
);

SELECT is(
    has_function_privilege(
        'service_role',
        'public.cleanup_old_audit_logs()',
        'EXECUTE'
    ),
    TRUE,
    'service_role can execute cleanup_old_audit_logs'
);

SELECT ok(
    (
        SELECT count(*)::int
        FROM public.cron_tasks
        WHERE
            name = 'cleanup_old_audit_logs'
            AND enabled = TRUE
            AND task_type = 'function'::public.cron_task_type
            AND target = 'public.cleanup_old_audit_logs()'
            AND run_at_hour = 3
            AND run_at_minute = 0
            AND run_at_second = 0
    ) = 1,
    'cron_tasks contains daily cleanup_old_audit_logs task'
);

INSERT INTO public.audit_logs (
    created_at,
    table_name,
    record_id,
    operation,
    user_id,
    org_id,
    old_record,
    new_record,
    changed_fields
)
VALUES
(
    now() - interval '31 days',
    'audit_log_retention_test',
    'audit-log-retention-old',
    'INSERT',
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
    '{}'::jsonb,
    '{}'::jsonb,
    ARRAY['retention_probe']::text []
),
(
    now() - interval '29 days',
    'audit_log_retention_test',
    'audit-log-retention-fresh',
    'INSERT',
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
    '{}'::jsonb,
    '{}'::jsonb,
    ARRAY['retention_probe']::text []
);

SELECT public.cleanup_old_audit_logs();

SELECT is(
    (
        SELECT count(*)::int
        FROM public.audit_logs
        WHERE
            record_id = 'audit-log-retention-old'
            AND table_name = 'audit_log_retention_test'
    ),
    0,
    'cleanup_old_audit_logs deletes rows older than 30 days'
);

SELECT is(
    (
        SELECT count(*)::int
        FROM public.audit_logs
        WHERE
            record_id = 'audit-log-retention-fresh'
            AND table_name = 'audit_log_retention_test'
    ),
    1,
    'cleanup_old_audit_logs keeps rows newer than 30 days'
);

SELECT tests.clear_authentication();

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
