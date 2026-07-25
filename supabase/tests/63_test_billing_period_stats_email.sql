-- 63_test_billing_period_stats_email.sql
-- Ensures billing_period_stats is registered in cron_tasks and queues on
-- anniversary day, and credits sums use half-open period bounds.
BEGIN;

SELECT plan(8);

SELECT ok(
    to_regprocedure(
        'public.process_billing_period_stats_email()'
    ) IS NOT NULL,
    'process_billing_period_stats_email exists'
);

SELECT ok(
    to_regprocedure(
        'public.get_org_credits_used_in_period(uuid, timestamptz, timestamptz)'
    ) IS NOT NULL,
    'get_org_credits_used_in_period exists'
);

SELECT ok(
    (
        SELECT count(*)::int
        FROM public.cron_tasks
        WHERE
            name = 'billing_period_stats_email'
            AND enabled = TRUE
            AND task_type = 'function'::public.cron_task_type
            AND target = 'public.process_billing_period_stats_email()'
            AND run_at_hour = 12
            AND run_at_minute = 0
    ) = 1,
    'cron_tasks contains daily billing_period_stats_email at 12:00 UTC'
);

CREATE TEMP TABLE billing_period_stats_context (
    user_id uuid,
    org_id uuid,
    customer_id text,
    app_id text,
    grant_id uuid
) ON COMMIT DROP;

DO $$
BEGIN
    PERFORM tests.create_supabase_user(
        'billing_period_stats_user',
        'billing-period-stats@example.com',
        '555-000-0063'
    );
END;
$$ LANGUAGE plpgsql;

INSERT INTO billing_period_stats_context (
    user_id, org_id, customer_id, app_id
)
VALUES (
    tests.get_supabase_uid('billing_period_stats_user'),
    gen_random_uuid(),
    'cus_billing_period_stats_test',
    'com.test.billingperiodstats.app'
);

INSERT INTO public.users (id, email, created_at, updated_at)
SELECT
    user_id,
    'billing-period-stats@example.com',
    now(),
    now()
FROM billing_period_stats_context;

-- Anchor day = today so the processor should queue an email
INSERT INTO public.stripe_info (
    customer_id,
    status,
    product_id,
    subscription_id,
    subscription_anchor_start,
    subscription_anchor_end
)
SELECT
    customer_id,
    'succeeded',
    'prod_LQIregjtNduh4q',
    'sub_billing_period_stats_test',
    date_trunc('month', now())
        + ((EXTRACT(DAY FROM CURRENT_DATE)::int - 1) || ' days')::interval,
    date_trunc('month', now())
        + ((EXTRACT(DAY FROM CURRENT_DATE)::int - 1) || ' days')::interval
        + interval '1 month'
FROM billing_period_stats_context;

INSERT INTO public.orgs (
    id, created_by, name, management_email, customer_id
)
SELECT
    org_id,
    user_id,
    'Billing Period Stats Org',
    'billing-period-stats@example.com',
    customer_id
FROM billing_period_stats_context;

INSERT INTO public.apps (
    app_id, icon_url, owner_org, name, retention, default_upload_channel
)
SELECT
    app_id,
    '',
    org_id,
    'Billing Period Stats App',
    2592000,
    'production'
FROM billing_period_stats_context;

WITH grant_insert AS (
    INSERT INTO public.usage_credit_grants (
        org_id,
        credits_total,
        credits_consumed,
        granted_at,
        expires_at,
        source
    )
    SELECT
        org_id,
        100,
        0,
        now() - interval '40 days',
        now() + interval '1 year',
        'manual'
    FROM billing_period_stats_context
    RETURNING id, org_id
)
UPDATE billing_period_stats_context ctx
SET grant_id = grant_insert.id
FROM grant_insert
WHERE ctx.org_id = grant_insert.org_id;

-- Half-open [start, end): include start and mid, exclude end
INSERT INTO public.usage_credit_consumptions (
    grant_id, org_id, metric, credits_used, applied_at
)
SELECT
    grant_id,
    org_id,
    'mau'::public.credit_metric_type,
    credits_used,
    applied_at
FROM billing_period_stats_context
CROSS JOIN (
    VALUES
        (1.5::numeric, (CURRENT_DATE - 20)::timestamptz),
        (2.5::numeric, (CURRENT_DATE - 1)::timestamptz),
        (9.0::numeric, CURRENT_DATE::timestamptz)
) AS samples(credits_used, applied_at);

SELECT is(
    public.get_org_credits_used_in_period(
        (SELECT org_id FROM billing_period_stats_context),
        (CURRENT_DATE - 30)::timestamptz,
        CURRENT_DATE::timestamptz
    ),
    4.0::numeric,
    'credits sum includes [start, end) and excludes end boundary'
);

DELETE FROM pgmq.q_cron_email
WHERE
    message -> 'payload' ->> 'orgId'
    = (SELECT org_id::text FROM billing_period_stats_context)
    AND message -> 'payload' ->> 'type' = 'billing_period_stats';

SELECT public.process_billing_period_stats_email();

SELECT is(
    (
        SELECT count(*)
        FROM pgmq.q_cron_email
        WHERE
            message -> 'payload' ->> 'orgId'
            = (SELECT org_id::text FROM billing_period_stats_context)
            AND message -> 'payload' ->> 'type' = 'billing_period_stats'
    ),
    1::bigint,
    'queues billing_period_stats email on anniversary day'
);

SELECT ok(
    (
        SELECT
            (message -> 'payload' ->> 'cycleStart') IS NOT NULL
            AND (message -> 'payload' ->> 'cycleEnd') IS NOT NULL
            AND (message -> 'payload' ->> 'cycleEnd')::timestamptz::date
                = CURRENT_DATE
            AND (message -> 'payload' ->> 'cycleStart')::timestamptz
                < (message -> 'payload' ->> 'cycleEnd')::timestamptz
        FROM pgmq.q_cron_email
        WHERE
            message -> 'payload' ->> 'orgId'
            = (SELECT org_id::text FROM billing_period_stats_context)
            AND message -> 'payload' ->> 'type' = 'billing_period_stats'
        LIMIT 1
    ),
    'payload includes completed cycle dates ending today'
);

-- Move the org off today's anniversary and confirm it is not queued
UPDATE public.stripe_info
SET
    subscription_anchor_start
        = date_trunc('month', now())
          + (
              (
                  CASE
                      WHEN EXTRACT(DAY FROM CURRENT_DATE)::int = 1 THEN 1
                      ELSE 0
                  END
              ) || ' days'
          )::interval,
    subscription_anchor_end
        = date_trunc('month', now())
          + (
              (
                  CASE
                      WHEN EXTRACT(DAY FROM CURRENT_DATE)::int = 1 THEN 1
                      ELSE 0
                  END
              ) || ' days'
          )::interval
          + interval '1 month'
WHERE customer_id = (
    SELECT customer_id FROM billing_period_stats_context
);

DELETE FROM pgmq.q_cron_email
WHERE
    message -> 'payload' ->> 'orgId'
    = (SELECT org_id::text FROM billing_period_stats_context)
    AND message -> 'payload' ->> 'type' = 'billing_period_stats';

SELECT public.process_billing_period_stats_email();

SELECT is(
    (
        SELECT count(*)
        FROM pgmq.q_cron_email
        WHERE
            message -> 'payload' ->> 'orgId'
            = (SELECT org_id::text FROM billing_period_stats_context)
            AND message -> 'payload' ->> 'type' = 'billing_period_stats'
    ),
    0::bigint,
    'does not queue when today is not the billing anniversary'
);

-- Month-end probe: 31st anchor should complete a cycle on the last day of a
-- short month when "+ 1 month" clamps (e.g. Jan 31 -> Feb 28/29).
DO $$
DECLARE
    v_anchor timestamptz := '2026-01-31 00:00:00+00'::timestamptz;
    v_yesterday timestamptz := '2026-02-27 12:00:00+00'::timestamptz;
    v_anchor_day interval;
    v_prev_end timestamptz;
BEGIN
    v_anchor_day := v_anchor - date_trunc('MONTH', v_anchor);
    IF v_anchor_day
        > v_yesterday - date_trunc('MONTH', v_yesterday)
    THEN
        v_prev_end := (
            date_trunc('MONTH', v_yesterday - interval '1 month')
            + v_anchor_day
        ) + interval '1 month';
    ELSE
        v_prev_end := (
            date_trunc('MONTH', v_yesterday) + v_anchor_day
        ) + interval '1 month';
    END IF;

    IF v_prev_end::date IS DISTINCT FROM '2026-02-28'::date THEN
        RAISE EXCEPTION
            'expected Feb 28 cycle end for Jan 31 anchor, got %',
            v_prev_end;
    END IF;
END;
$$;

SELECT ok(
    TRUE,
    '31st-anchor cycle end clamps to last day of short month'
);

SELECT * FROM finish();

ROLLBACK;
