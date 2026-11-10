-- Registration for process_trial_usage_recap_email, queue payloads, and smoke run.

BEGIN;

SELECT plan(5);

SELECT ok(
    to_regprocedure('public.process_trial_usage_recap_email()') IS NOT NULL,
    'process_trial_usage_recap_email exists'
);

SELECT ok(
    (
        SELECT count(*)::int
        FROM public.cron_tasks
        WHERE
            name = 'trial_usage_recap_email'
            AND enabled = TRUE
            AND task_type = 'function'::public.cron_task_type
            AND target = 'public.process_trial_usage_recap_email()'
            AND run_at_hour = 9
            AND run_at_minute = 0
    ) = 1,
    'cron_tasks contains trial_usage_recap_email at 09:00 UTC'
);

DO $$
BEGIN
  PERFORM tests.create_supabase_user(
      'trial_usage_recap_queue_user',
      'trial-usage-recap-queue@example.com',
      '555-000-0100'
  );
END;
$$ LANGUAGE plpgsql;

CREATE TEMP TABLE trial_usage_recap_queue_ctx (
    user_id uuid,
    org_minus3 uuid,
    org_minus1 uuid,
    customer_minus3 text,
    customer_minus1 text,
    trial_day_minus3 date,
    trial_day_minus1 date
) ON COMMIT DROP;

INSERT INTO trial_usage_recap_queue_ctx (
    user_id,
    org_minus3,
    org_minus1,
    customer_minus3,
    customer_minus1,
    trial_day_minus3,
    trial_day_minus1
)
VALUES (
    tests.get_supabase_uid('trial_usage_recap_queue_user'),
    gen_random_uuid(),
    gen_random_uuid(),
    'cus_trial_recap_minus3_test',
    'cus_trial_recap_minus1_test',
    (CURRENT_DATE AT TIME ZONE 'UTC')::date + 3,
    (CURRENT_DATE AT TIME ZONE 'UTC')::date + 1
);

INSERT INTO public.users (id, email, created_at, updated_at)
SELECT
    user_id,
    'trial-usage-recap-queue@example.com',
    now() - interval '30 days',
    now()
FROM trial_usage_recap_queue_ctx;

INSERT INTO public.stripe_info (
    customer_id,
    status,
    product_id,
    trial_at,
    is_good_plan,
    subscription_id
)
SELECT
    customer_minus3,
    'created'::public.stripe_status,
    'prod_LQIregjtNduh4q',
    make_timestamptz(
        EXTRACT(YEAR FROM trial_day_minus3)::int,
        EXTRACT(MONTH FROM trial_day_minus3)::int,
        EXTRACT(DAY FROM trial_day_minus3)::int,
        12,
        0,
        0,
        'UTC'
    ),
    true,
    'sub_trial_recap_minus3_test'
FROM trial_usage_recap_queue_ctx
UNION ALL
SELECT
    customer_minus1,
    'created'::public.stripe_status,
    'prod_LQIregjtNduh4q',
    make_timestamptz(
        EXTRACT(YEAR FROM trial_day_minus1)::int,
        EXTRACT(MONTH FROM trial_day_minus1)::int,
        EXTRACT(DAY FROM trial_day_minus1)::int,
        12,
        0,
        0,
        'UTC'
    ),
    true,
    'sub_trial_recap_minus1_test'
FROM trial_usage_recap_queue_ctx;

INSERT INTO public.orgs (id, created_by, name, management_email, customer_id, created_at)
SELECT
    org_minus3,
    user_id,
    'Trial recap minus3 org',
    'trial-usage-recap-queue@example.com',
    customer_minus3,
    now() - interval '30 days'
FROM trial_usage_recap_queue_ctx
UNION ALL
SELECT
    org_minus1,
    user_id,
    'Trial recap minus1 org',
    'trial-usage-recap-queue@example.com',
    customer_minus1,
    now() - interval '30 days'
FROM trial_usage_recap_queue_ctx;

DELETE FROM pgmq.q_cron_email
WHERE
    message -> 'payload' ->> 'orgId' IN (
        SELECT org_minus3::text FROM trial_usage_recap_queue_ctx
        UNION ALL
        SELECT org_minus1::text FROM trial_usage_recap_queue_ctx
    )
    AND message -> 'payload' ->> 'type' IN ('trial_usage_recap', 'trial_end_usage_recap');

SELECT public.process_trial_usage_recap_email();

SELECT is(
    (
        SELECT count(*)::bigint
        FROM pgmq.q_cron_email
        WHERE
            message -> 'payload' ->> 'orgId' = (SELECT org_minus3::text FROM trial_usage_recap_queue_ctx)
            AND message -> 'payload' ->> 'type' = 'trial_usage_recap'
            AND message -> 'payload' ->> 'trialEndDate' = (SELECT trial_day_minus3::text FROM trial_usage_recap_queue_ctx)
            AND message -> 'payload' ->> 'email' = 'trial-usage-recap-queue@example.com'
    ),
    1::bigint,
    'queues trial_usage_recap three days before trial'
);

SELECT is(
    (
        SELECT count(*)::bigint
        FROM pgmq.q_cron_email
        WHERE
            message -> 'payload' ->> 'orgId' = (SELECT org_minus1::text FROM trial_usage_recap_queue_ctx)
            AND message -> 'payload' ->> 'type' = 'trial_end_usage_recap'
            AND message -> 'payload' ->> 'trialEndDate' = (SELECT trial_day_minus1::text FROM trial_usage_recap_queue_ctx)
    ),
    1::bigint,
    'queues trial_end_usage_recap one day before trial'
);

SELECT lives_ok(
    $$SELECT public.process_trial_usage_recap_email()$$,
    'process_trial_usage_recap_email runs'
);

SELECT * FROM finish();

ROLLBACK;
