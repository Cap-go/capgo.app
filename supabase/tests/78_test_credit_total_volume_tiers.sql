BEGIN;

SELECT plan(12);

-- Credit tiers follow total usage: overage is priced on the slice
-- [included, included + overage) of the tier ladder.

SELECT
    ok(
        pg_get_functiondef(
            'calculate_credit_cost(public.credit_metric_type, numeric, numeric)'::regprocedure
        ) IS NOT NULL,
        'calculate_credit_cost has an included-amount overload'
    );

SELECT
    ok(
        pg_get_functiondef(
            'apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamptz, timestamptz, jsonb, numeric)'::regprocedure
        ) IS NOT NULL,
        'apply_usage_overage takes the plan included amount'
    );

SELECT
    is(
        to_regprocedure(
            'public.apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamptz, timestamptz, jsonb)'
        ),
        NULL,
        'six-argument apply_usage_overage is replaced, no ambiguous overload'
    );

SELECT
    ok(
        NOT has_function_privilege(
            'authenticated',
            'public.apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamptz, timestamptz, jsonb, numeric)',
            'EXECUTE'
        )
        AND NOT has_function_privilege(
            'anon',
            'public.apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamptz, timestamptz, jsonb, numeric)',
            'EXECUTE'
        )
        AND has_function_privilege(
            'service_role',
            'public.apply_usage_overage(uuid, public.credit_metric_type, numeric, timestamptz, timestamptz, jsonb, numeric)',
            'EXECUTE'
        ),
        'apply_usage_overage stays service_role only'
    );

SELECT
    ok(
        NOT has_function_privilege(
            'authenticated',
            'public.calculate_credit_cost(public.credit_metric_type, numeric, numeric)',
            'EXECUTE'
        )
        AND NOT has_function_privilege(
            'anon',
            'public.calculate_credit_cost(public.credit_metric_type, numeric, numeric)',
            'EXECUTE'
        ),
        'calculate_credit_cost overload is not callable by clients'
    );

-- Small plan: overage stays in the first tier, same price as before.
SELECT
    results_eq(
        $$SELECT credits_required FROM public.calculate_credit_cost('mau', 1000, 2000)$$,
        $$VALUES (3.0::numeric)$$,
        'Solo MAU overage keeps the first-tier price'
    );

-- 1M MAU included, 1M extra: priced at the 1M-3M tier, not from 0.
SELECT
    results_eq(
        $$SELECT credits_required FROM public.calculate_credit_cost('mau', 1000000, 1000000)$$,
        $$VALUES (600.0::numeric)$$,
        '2M MAU on a 1M plan costs $600 of overage'
    );

-- 1M included, 4M extra: 2M at $0.0006 + 2M at $0.00045.
SELECT
    results_eq(
        $$SELECT credits_required FROM public.calculate_credit_cost('mau', 4000000, 1000000)$$,
        $$VALUES (2100.0::numeric)$$,
        '5M MAU on a 1M plan spans two tiers'
    );

-- Nothing included (credit-only orgs) prices from the bottom of the ladder.
SELECT
    results_eq(
        $$SELECT credits_required FROM public.calculate_credit_cost('mau', 2000000)$$,
        $$VALUES (3600.0::numeric)$$,
        'two-argument form prices from 0'
    );

-- 100 TB included, 100 TB extra: 102400 GiB at $0.008.
SELECT
    results_eq(
        $$SELECT credits_required
          FROM public.calculate_credit_cost(
              'bandwidth',
              109951162777600::numeric,
              109951162777600::numeric
          )$$,
        $$VALUES (819.2::numeric)$$,
        '200 TB bandwidth on a 100 TB plan costs $819.20 of overage'
    );

-- 10 TB included, 1 TB extra: priced at the 6-12 TB tier.
SELECT
    results_eq(
        $$SELECT credits_required
          FROM public.calculate_credit_cost(
              'bandwidth',
              1099511627776::numeric,
              10995116277760::numeric
          )$$,
        $$VALUES (35.84::numeric)$$,
        'bandwidth overage continues the ladder above the plan limit'
    );

SELECT
    results_eq(
        $$SELECT credits_required
          FROM public.apply_usage_overage(
              '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid,
              'mau',
              1000000,
              date_trunc('month', now()),
              date_trunc('month', now()) + interval '1 month',
              '{"usage": 2000000, "limit": 1000000}'::jsonb,
              1000000
          )$$,
        $$VALUES (600.0::numeric)$$,
        'apply_usage_overage prices overage above the included amount'
    );

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
