BEGIN;

SELECT plan(33);

DO $$
BEGIN
  PERFORM tests.create_supabase_user('usage_credits_user', 'credits-test@example.com', '555-555-5555');
END;
$$ LANGUAGE plpgsql;

SELECT
    ok(
        pg_get_functiondef(
            'apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamptz, timestamptz, jsonb)'::regprocedure
        ) IS NOT NULL,
        'apply_usage_overage function exists'
    );

SELECT
    ok(
        pg_get_functiondef(
            'calculate_credit_cost(public.credit_metric_type, numeric)'::regprocedure
        ) IS NOT NULL,
        'calculate_credit_cost function exists'
    );

SELECT
    ok(
        pg_get_functiondef('expire_usage_credits()'::regprocedure) IS NOT NULL,
        'expire_usage_credits function exists'
    );

SELECT
    ok(
        position(
            't.source_ref' IN pg_get_functiondef(
                'top_up_usage_credits(uuid, numeric, timestamptz, text, jsonb, text)'::regprocedure
            )
        )
        > 0,
        'top_up_usage_credits qualifies source_ref lookups to avoid ambiguity'
    );

SELECT
    results_eq(
        $$SELECT price_per_unit
          FROM public.capgo_credits_steps
         WHERE type = 'build_time'
           AND org_id IS NULL
           AND step_min = 0
         ORDER BY step_max ASC
         LIMIT 1$$,
        $$VALUES (0.08::double precision)$$,
        'build_time credit pricing starts at $0.08 per minute'
    );

SELECT
    results_eq(
        $$SELECT price_per_unit
          FROM public.capgo_credits_steps
         WHERE type = 'build_time'
           AND org_id IS NULL
         ORDER BY step_max DESC, step_min DESC
         LIMIT 1$$,
        $$VALUES (0.04::double precision)$$,
        'build_time credit pricing floors at $0.04 per minute'
    );

SELECT
    results_eq(
        $$SELECT credits_required FROM public.calculate_credit_cost('build_time', 6000)$$,
        $$VALUES (8.0::numeric)$$,
        'calculate_credit_cost prices build_time through the shared credit ladder'
    );

CREATE TEMP TABLE test_credit_context (
    org_id uuid,
    grant_id uuid,
    credit_step_id bigint
) ON COMMIT DROP;

DELETE FROM public.capgo_credits_steps
WHERE type = 'mau';
DELETE FROM public.stripe_info
WHERE customer_id = 'cus_test_credits';

WITH plan_selection AS (
    SELECT
        id,
        stripe_id
    FROM public.plans
    ORDER BY created_at
    LIMIT 1
),

user_insert AS (
    INSERT INTO public.users (id, email, created_at, updated_at)
    SELECT
        tests.get_supabase_uid('usage_credits_user'),
        'credits-test@example.com',
        now(),
        now()
    RETURNING id
),

stripe_info_insert AS (
    INSERT INTO public.stripe_info (customer_id, product_id, status)
    SELECT
        'cus_test_credits',
        plan_selection.stripe_id,
        'succeeded'
    FROM plan_selection
    RETURNING customer_id
),

org_insert AS (
    INSERT INTO public.orgs (
        id,
        created_by,
        name,
        management_email,
        customer_id
    )
    SELECT
        gen_random_uuid(),
        user_insert.id,
        'Credits Test Org',
        'credits-test@example.com',
        stripe_info_insert.customer_id
    FROM user_insert,
        stripe_info_insert
    RETURNING id
),

grant_insert AS (
    INSERT INTO public.usage_credit_grants (
        org_id,
        credits_total,
        credits_consumed,
        granted_at,
        expires_at,
        source
    )
    SELECT
        org_insert.id,
        20,
        0,
        now(),
        now() + interval '1 year',
        'manual'
    FROM org_insert
    RETURNING
        id,
        org_id
),

step_insert AS (
    INSERT INTO public.capgo_credits_steps (
        type,
        step_min,
        step_max,
        price_per_unit,
        unit_factor,
        org_id
    )
    VALUES (
        'mau',
        0,
        1000000,
        0.1,
        1,
        NULL
    )
    RETURNING id
)

INSERT INTO
test_credit_context (org_id, grant_id, credit_step_id)
SELECT
    grant_insert.org_id,
    grant_insert.id,
    step_insert.id
FROM
    grant_insert,
    step_insert;

CREATE TEMP TABLE test_repricing_context (
    credit_step_id bigint,
    overage_event_id uuid
) ON COMMIT DROP;

WITH repricing_step AS (
    INSERT INTO public.capgo_credits_steps (
        type,
        step_min,
        step_max,
        price_per_unit,
        unit_factor,
        org_id
    )
    VALUES (
        'build_time',
        900000000,
        900006000,
        0.5,
        60,
        NULL
    )
    RETURNING id
),
repricing_overage AS (
    INSERT INTO public.usage_overage_events (
        org_id,
        metric,
        overage_amount,
        credits_estimated,
        credits_debited,
        credit_step_id,
        billing_cycle_start,
        billing_cycle_end,
        details
    )
    SELECT
        (SELECT org_id FROM test_credit_context),
        'build_time'::public.credit_metric_type,
        6000,
        50,
        0,
        repricing_step.id,
        current_date,
        current_date,
        '{}'::jsonb
    FROM repricing_step
    RETURNING id, credit_step_id
)
INSERT INTO test_repricing_context (credit_step_id, overage_event_id)
SELECT credit_step_id, id
FROM repricing_overage;

UPDATE public.capgo_credits_steps
SET
    price_per_unit = 0.08,
    unit_factor = 60
WHERE id = (SELECT credit_step_id FROM test_repricing_context);

SELECT
    is(
        (
            SELECT credit_step_id
            FROM public.usage_overage_events
            WHERE id = (SELECT overage_event_id FROM test_repricing_context)
        ),
        (SELECT credit_step_id FROM test_repricing_context),
        'repricing build_time tiers in place preserves usage_overage_events credit_step_id links'
    );

SELECT
    throws_ok(
        $sql$
      INSERT INTO public.usage_credit_grants (
        org_id,
        credits_total,
        credits_consumed,
        granted_at,
        expires_at,
        source
      )
      VALUES (
        (SELECT org_id FROM test_credit_context LIMIT 1),
        5,
        0,
        NOW(),
        NOW() + interval '1 day',
        'invalid_source'
      )
    $sql$,
        'new row for relation "usage_credit_grants" violates check constraint "usage_credit_grants_source_check"',
        'usage_credit_grants.source enforces allowed values'
    );

SELECT
    is(
        (
            SELECT overage_unpaid
            FROM public.apply_usage_overage(
                (SELECT org_id FROM test_credit_context),
                'mau',
                10,
                now(),
                now() + interval '1 month',
                '{}'::jsonb
            )
        ),
        0::numeric,
        'apply_usage_overage consumes credits when available'
    );

SELECT
    is(
        (
            SELECT overage_unpaid
            FROM public.apply_usage_overage(
                (SELECT org_id FROM test_credit_context),
                'mau',
                10,
                now(),
                now() + interval '1 month',
                '{}'::jsonb
            )
        ),
        0::numeric,
        'apply_usage_overage is idempotent for the same overage snapshot'
    );

SELECT
    is(
        (
            SELECT credits_consumed
            FROM
                public.usage_credit_grants
            WHERE
                id = (
                    SELECT grant_id
                    FROM
                        test_credit_context
                )
        ),
        1::numeric,
        'usage_credit_grants updated with consumed credits'
    );

UPDATE public.usage_credit_grants
SET
    expires_at = now() - interval '1 day'
WHERE
    id = (
        SELECT grant_id
        FROM
            test_credit_context
    );

SELECT
    is(
        public.expire_usage_credits(),
        1::bigint,
        'expire_usage_credits processes expired grants'
    );

SELECT
    is(
        (
            SELECT credits_consumed
            FROM
                public.usage_credit_grants
            WHERE
                id = (
                    SELECT grant_id
                    FROM
                        test_credit_context
                )
        ),
        20::numeric,
        'expire_usage_credits consumes remaining credits'
    );

INSERT INTO public.usage_credit_transactions (
    org_id,
    grant_id,
    transaction_type,
    amount,
    balance_after,
    description,
    source_ref
)
SELECT
    org_id,
    grant_id,
    'purchase'::public.credit_transaction_type,
    5,
    5,
    'Idempotency test transaction',
    jsonb_build_object(
        'sessionId',
        'cs_test_idempotent',
        'paymentIntentId',
        'pi_test_idempotent'
    )
FROM test_credit_context
LIMIT 1;

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM public.usage_credit_transactions
            WHERE
                org_id = (SELECT org_id FROM test_credit_context)
                AND transaction_type = 'purchase'
                AND (
                    source_ref ->> 'sessionId' = 'cs_test_idempotent'
                    OR source_ref ->> 'paymentIntentId' = 'pi_test_idempotent'
                )
        ),
        'credit top-up queries can locate existing purchases by session or payment intent reference'
    );

CREATE TEMP TABLE test_top_up_concurrency_results (
    run_label text,
    grant_id uuid,
    transaction_id bigint,
    available_credits numeric,
    total_credits numeric,
    next_expiration timestamptz
) ON COMMIT DROP;

INSERT INTO test_top_up_concurrency_results
SELECT
    'first',
    *
FROM public.top_up_usage_credits(
    (SELECT org_id FROM test_credit_context),
    5,
    NULL,
    'stripe_top_up',
    jsonb_build_object(
        'sessionId', 'cs_concurrent_top_up',
        'paymentIntentId', 'pi_concurrent_top_up'
    ),
    'concurrent top-up attempt'
);

INSERT INTO test_top_up_concurrency_results
SELECT
    'second',
    *
FROM public.top_up_usage_credits(
    (SELECT org_id FROM test_credit_context),
    5,
    NULL,
    'stripe_top_up',
    jsonb_build_object(
        'sessionId', 'cs_concurrent_top_up',
        'paymentIntentId', 'pi_concurrent_top_up'
    ),
    'concurrent top-up duplicate'
);

SELECT
    is(
        (
            SELECT transaction_id FROM test_top_up_concurrency_results
            WHERE run_label = 'first'
        ),
        (
            SELECT transaction_id FROM test_top_up_concurrency_results
            WHERE run_label = 'second'
        ),
        'duplicate top-up RPC calls return the same transaction id'
    );

SELECT
    is(
        (
            SELECT grant_id FROM test_top_up_concurrency_results
            WHERE run_label = 'first'
        ),
        (
            SELECT grant_id FROM test_top_up_concurrency_results
            WHERE run_label = 'second'
        ),
        'duplicate top-up RPC calls return the same grant id'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM public.usage_credit_transactions
            WHERE
                org_id = (SELECT org_id FROM test_credit_context)
                AND transaction_type = 'purchase'
                AND source_ref ->> 'sessionId' = 'cs_concurrent_top_up'
        ),
        1::bigint,
        'duplicate top-up RPC calls result in a single purchase transaction row'
    );

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM
                public.usage_credit_transactions
            WHERE
                grant_id = (
                    SELECT grant_id
                    FROM
                        test_credit_context
                )
                AND transaction_type = 'expiry'
        ),
        'expiry transaction recorded'
    );

CREATE TEMP TABLE test_credit_alerts_context (
    org_id uuid,
    grant_id uuid
) ON COMMIT DROP;

WITH alert_org AS (
    INSERT INTO public.orgs (
        id,
        created_by,
        name,
        management_email
    )
    VALUES (
        gen_random_uuid(),
        tests.get_supabase_uid('usage_credits_user'),
        'Credit Alert Org',
        'credit-alerts@example.com'
    )
    RETURNING id
),

alert_grant AS (
    INSERT INTO public.usage_credit_grants (
        org_id,
        credits_total,
        credits_consumed,
        granted_at,
        expires_at,
        source
    )
    SELECT
        id,
        100,
        0,
        now(),
        now() + interval '1 year',
        'manual'
    FROM alert_org
    RETURNING
        id,
        org_id
)

INSERT INTO test_credit_alerts_context (org_id, grant_id)
SELECT
    org_id,
    id
FROM alert_grant;

DELETE FROM pgmq.q_credit_usage_alerts
WHERE
    (message -> 'payload' ->> 'org_id')::uuid = (SELECT org_id FROM test_credit_alerts_context LIMIT 1);

UPDATE public.usage_credit_grants
SET credits_consumed = credits_consumed + 60
WHERE id = (SELECT grant_id FROM test_credit_alerts_context LIMIT 1);

INSERT INTO public.usage_credit_transactions (
    org_id,
    grant_id,
    transaction_type,
    amount,
    balance_after,
    description,
    source_ref
)
SELECT
    org_id,
    grant_id,
    'deduction'::public.credit_transaction_type,
    -60,
    40,
    'Credit alert threshold 50 test',
    jsonb_build_object('note', 'credit_usage_alert_test')
FROM test_credit_alerts_context
LIMIT 1;

UPDATE public.usage_credit_grants
SET credits_consumed = credits_consumed + 20
WHERE id = (SELECT grant_id FROM test_credit_alerts_context LIMIT 1);

INSERT INTO public.usage_credit_transactions (
    org_id,
    grant_id,
    transaction_type,
    amount,
    balance_after,
    description,
    source_ref
)
SELECT
    org_id,
    grant_id,
    'deduction'::public.credit_transaction_type,
    -20,
    20,
    'Credit alert threshold 75 test',
    jsonb_build_object('note', 'credit_usage_alert_test')
FROM test_credit_alerts_context
LIMIT 1;

UPDATE public.usage_credit_grants
SET credits_consumed = credits_total
WHERE id = (SELECT grant_id FROM test_credit_alerts_context LIMIT 1);

INSERT INTO public.usage_credit_transactions (
    org_id,
    grant_id,
    transaction_type,
    amount,
    balance_after,
    description,
    source_ref
)
SELECT
    org_id,
    grant_id,
    'deduction'::public.credit_transaction_type,
    -20,
    0,
    'Credit alert threshold 90-100 test',
    jsonb_build_object('note', 'credit_usage_alert_test')
FROM test_credit_alerts_context
LIMIT 1;

SELECT
    is(
        (
            SELECT count(*)
            FROM pgmq.q_credit_usage_alerts
            WHERE
                (message -> 'payload' ->> 'org_id')::uuid
                = (SELECT org_id FROM test_credit_alerts_context)
        ),
        4::bigint,
        'credit usage alerts enqueue once per threshold at 50/75/90/100 percent'
    );

SELECT
    is(
        (
            SELECT
                array_agg(
                    (message -> 'payload' ->> 'threshold')::int
                    ORDER BY (message -> 'payload' ->> 'threshold')::int
                )
            FROM pgmq.q_credit_usage_alerts
            WHERE
                (message -> 'payload' ->> 'org_id')::uuid
                = (SELECT org_id FROM test_credit_alerts_context)
        ),
        ARRAY[50, 75, 90, 100]::int [],
        'credit usage alert payloads include expected thresholds'
    );

CREATE TEMP TABLE test_usage_ledger_context (
    org_id uuid
) ON COMMIT DROP;

-- usage_credit_ledger view aggregates deductions per overage event
WITH setup AS (
    INSERT INTO public.orgs (
        id,
        created_by,
        name,
        management_email
    )
    VALUES (
        gen_random_uuid(),
        tests.get_supabase_uid('usage_credits_user'),
        'Usage Ledger Org',
        'usage-ledger@example.com'
    )
    RETURNING id AS org_id
),

context_insert AS (
    INSERT INTO test_usage_ledger_context (org_id)
    SELECT org_id FROM setup
    RETURNING org_id
),

grant_one AS (
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
        50,
        0,
        now(),
        now() + interval '1 year',
        'manual'
    FROM context_insert
    RETURNING
        id,
        org_id
),

grant_two AS (
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
        25,
        0,
        now(),
        now() + interval '1 year',
        'manual'
    FROM context_insert
    RETURNING
        id,
        org_id
),

overage AS (
    INSERT INTO public.usage_overage_events (
        org_id,
        metric,
        overage_amount,
        credits_estimated,
        credits_debited,
        billing_cycle_start,
        billing_cycle_end,
        details
    )
    SELECT
        org_id,
        'mau'::public.credit_metric_type,
        1000,
        10,
        10,
        current_date - interval '1 month',
        current_date,
        jsonb_build_object('note', 'ledger view test overage')
    FROM context_insert
    RETURNING
        id,
        org_id
),

consumptions AS (
    INSERT INTO public.usage_credit_consumptions (
        grant_id,
        org_id,
        overage_event_id,
        metric,
        credits_used,
        applied_at
    )
    SELECT
        g.id,
        g.org_id,
        o.id,
        'mau'::public.credit_metric_type,
        6,
        now()
    FROM grant_one AS g,
        overage AS o
    UNION ALL
    SELECT
        g.id,
        g.org_id,
        o.id,
        'mau'::public.credit_metric_type,
        4,
        now()
    FROM grant_two AS g,
        overage AS o
),

deductions AS (
    INSERT INTO public.usage_credit_transactions (
        org_id,
        grant_id,
        transaction_type,
        amount,
        balance_after,
        occurred_at,
        description,
        source_ref
    )
    SELECT
        o.org_id,
        g.id,
        'deduction'::public.credit_transaction_type,
        -6,
        94,
        now() - interval '2 minutes',
        'Overage deduction portion 1',
        jsonb_build_object('overage_event_id', o.id, 'metric', 'mau')
    FROM overage AS o,
        grant_one AS g
    UNION ALL
    SELECT
        o.org_id,
        g.id,
        'deduction'::public.credit_transaction_type,
        -4,
        90,
        now() - interval '1 minute',
        'Overage deduction portion 2',
        jsonb_build_object('overage_event_id', o.id, 'metric', 'mau')
    FROM overage AS o,
        grant_two AS g
)

SELECT 1;

SELECT
    is(
        (
            SELECT count(*)
            FROM public.usage_credit_ledger
            WHERE
                org_id = (SELECT org_id FROM test_usage_ledger_context)
                AND transaction_type = 'deduction'
        ),
        1::bigint,
        'usage_credit_ledger collapses multiple grant deductions for the same overage event into one row'
    );

SELECT
    is(
        (
            SELECT amount
            FROM public.usage_credit_ledger
            WHERE
                org_id = (SELECT org_id FROM test_usage_ledger_context)
                AND transaction_type = 'deduction'
        ),
        -10::numeric,
        'usage_credit_ledger aggregates deduction amounts by overage event'
    );

SELECT
    is(
        (
            SELECT auto_top_up_enabled
            FROM public.orgs
            WHERE id = (SELECT org_id FROM test_credit_context)
        ),
        false,
        'auto top-up is off by default'
    );

SELECT
    is(
        (
            SELECT auto_top_up_threshold
            FROM public.orgs
            WHERE id = (SELECT org_id FROM test_credit_context)
        ),
        10::numeric,
        'auto top-up threshold defaults to 10'
    );

SELECT
    throws_ok(
        $sql$
      UPDATE public.orgs
      SET auto_top_up_threshold = 9
      WHERE id = (SELECT org_id FROM test_credit_context)
    $sql$,
        'new row for relation "orgs" violates check constraint "orgs_auto_top_up_threshold_min"',
        'auto top-up threshold cannot be below 10'
    );

SELECT
    is(
        (
            SELECT claimed
            FROM public.try_claim_credit_auto_top_up((SELECT org_id FROM test_credit_context))
        ),
        false,
        'try_claim_credit_auto_top_up does not claim when auto top-up is disabled'
    );

CREATE TEMP TABLE test_credit_consume_context AS
WITH user_insert AS (
    SELECT id FROM auth.users WHERE email = 'credits-test@example.com' LIMIT 1
),
org_insert AS (
    INSERT INTO public.orgs (
        id,
        created_by,
        name,
        management_email
    )
    SELECT
        gen_random_uuid(),
        user_insert.id,
        'Credits Consume Org',
        'credits-consume@example.com'
    FROM user_insert
    RETURNING id
)
SELECT id AS org_id FROM org_insert;

INSERT INTO public.usage_credit_grants (
    org_id,
    credits_total,
    credits_consumed,
    granted_at,
    expires_at,
    source
)
VALUES (
    (SELECT org_id FROM test_credit_consume_context),
    5,
    0,
    now(),
    now() + interval '2 days',
    'manual'
);

SELECT
    results_eq(
        $$
        SELECT credits_applied, credits_remaining
        FROM public.apply_usage_overage(
          (SELECT org_id FROM test_credit_consume_context),
          'mau'::public.credit_metric_type,
          100,
          timestamptz '2031-01-01 00:00:00+00',
          timestamptz '2031-02-01 00:00:00+00',
          '{}'::jsonb
        )
        $$,
        $$ VALUES (5::numeric, 5::numeric) $$,
        'partial grant covers 5 of 10 required credits and leaves remainder unpaid'
    );

INSERT INTO public.usage_credit_grants (
    org_id,
    credits_total,
    credits_consumed,
    granted_at,
    expires_at,
    source
)
VALUES (
    (SELECT org_id FROM test_credit_consume_context),
    20,
    0,
    now(),
    now() + interval '30 days',
    'manual'
);

SELECT
    results_eq(
        $$
        SELECT credits_applied, credits_remaining
        FROM public.apply_usage_overage(
          (SELECT org_id FROM test_credit_consume_context),
          'mau'::public.credit_metric_type,
          100,
          timestamptz '2031-01-01 00:00:00+00',
          timestamptz '2031-02-01 00:00:00+00',
          '{}'::jsonb
        )
        $$,
        $$ VALUES (5::numeric, 0::numeric) $$,
        'new grant after a partial debit consumes leftover unpaid overage'
    );

INSERT INTO public.usage_credit_grants (
    org_id,
    credits_total,
    credits_consumed,
    granted_at,
    expires_at,
    source
)
VALUES
    (
        (SELECT org_id FROM test_credit_consume_context),
        4,
        0,
        now(),
        now() + interval '3 days',
        'manual'
    ),
    (
        (SELECT org_id FROM test_credit_consume_context),
        8,
        0,
        now(),
        now() + interval '12 days',
        'manual'
    );

SELECT
    is(
        (
            SELECT credits_applied
            FROM public.apply_usage_overage(
              (SELECT org_id FROM test_credit_consume_context),
              'mau'::public.credit_metric_type,
              60,
              timestamptz '2031-03-01 00:00:00+00',
              timestamptz '2031-04-01 00:00:00+00',
              '{}'::jsonb
            )
        ),
        6::numeric,
        'FIFO apply uses the soonest-expiring grant first then the next grant'
    );

CREATE TEMP TABLE test_credit_expired_context AS
WITH org_insert AS (
    INSERT INTO public.orgs (
        id,
        created_by,
        name,
        management_email
    )
    SELECT
        gen_random_uuid(),
        created_by,
        'Credits Expired Org',
        'credits-expired@example.com'
    FROM public.orgs
    WHERE id = (SELECT org_id FROM test_credit_consume_context)
    RETURNING id
)
SELECT id AS org_id FROM org_insert;

INSERT INTO public.usage_credit_grants (
    org_id,
    credits_total,
    credits_consumed,
    granted_at,
    expires_at,
    source
)
VALUES (
    (SELECT org_id FROM test_credit_expired_context),
    3,
    0,
    now() - interval '2 days',
    now() - interval '1 day',
    'manual'
);

SELECT
    results_eq(
        $$
        SELECT credits_applied, credits_remaining
        FROM public.apply_usage_overage(
          (SELECT org_id FROM test_credit_expired_context),
          'mau'::public.credit_metric_type,
          50,
          timestamptz '2031-05-01 00:00:00+00',
          timestamptz '2031-06-01 00:00:00+00',
          '{}'::jsonb
        )
        $$,
        $$ VALUES (0::numeric, 5::numeric) $$,
        'expired grants are ignored and unpaid remainder is returned'
    );

UPDATE public.usage_credit_grants
SET credits_consumed = credits_total
WHERE org_id = (SELECT org_id FROM test_credit_consume_context);

UPDATE public.orgs
SET
    auto_top_up_enabled = true,
    auto_top_up_threshold = 10,
    auto_top_up_last_attempt_at = NULL
WHERE id = (SELECT org_id FROM test_credit_consume_context);

SELECT
    is(
        (
            SELECT claimed
            FROM public.try_claim_credit_auto_top_up((SELECT org_id FROM test_credit_consume_context))
        ),
        true,
        'try_claim_credit_auto_top_up claims when enabled and available credits are below threshold'
    );

SELECT
    is(
        (
            SELECT claimed
            FROM public.try_claim_credit_auto_top_up((SELECT org_id FROM test_credit_consume_context))
        ),
        false,
        'try_claim_credit_auto_top_up respects the one-hour cooldown'
    );

SELECT *
FROM
    finish();

ROLLBACK;
