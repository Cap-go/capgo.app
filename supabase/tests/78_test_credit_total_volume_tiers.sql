BEGIN;

SELECT plan(15);

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
            'public.apply_usage_overage(uuid, public.credit_metric_type, '
            'numeric, timestamptz, timestamptz, jsonb)'
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
        $$VALUES (300.0::numeric)$$,
        '2M MAU on a 1M plan costs $300 of overage'
    );

-- 1M included, 4M extra: 2M at $0.0003 + 2M at $0.00025.
SELECT
    results_eq(
        $$SELECT credits_required FROM public.calculate_credit_cost('mau', 4000000, 1000000)$$,
        $$VALUES (1100.0::numeric)$$,
        '5M MAU on a 1M plan spans two tiers'
    );

-- Nothing included (credit-only orgs) prices from the bottom of the ladder.
SELECT
    results_eq(
        $$SELECT credits_required FROM public.calculate_credit_cost('mau', 2000000)$$,
        $$VALUES (3300.0::numeric)$$,
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
        $$VALUES (300.0::numeric)$$,
        'apply_usage_overage prices overage above the included amount'
    );

-- An org-scoped tier must not change the global price billing uses.
INSERT INTO public.capgo_credits_steps (
    type, step_min, step_max, price_per_unit, unit_factor, org_id
)
VALUES (
    'mau', 0, 9223372036854775807, 1, 1,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid
);

SELECT
    results_eq(
        $$SELECT credits_required
          FROM public.calculate_credit_cost('mau', 1000000, 1000000)$$,
        $$VALUES (300.0::numeric)$$,
        'billing ignores org-scoped tiers'
    );

DELETE FROM public.capgo_credits_steps
WHERE org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid;

-- Partial credits: covered usage follows the tier slices, not a blended
-- rate. 4M MAU above a 1M plan costs 2M x $0.0003 + 2M x $0.00025 = $1100.
-- $450 of credits covers 1.5M MAU of the first slice; a blended rate
-- would claim about 1.64M.
DO $$
BEGIN
  PERFORM tests.create_supabase_user('tier_credits_user', 'tier-credits@example.com', '555-555-0178');
END;
$$ LANGUAGE plpgsql;

CREATE TEMP TABLE tier_ctx (org_id uuid) ON COMMIT DROP;

WITH user_insert AS (
    INSERT INTO public.users (id, email, created_at, updated_at)
    SELECT
        tests.get_supabase_uid('tier_credits_user'),
        'tier-credits@example.com',
        now(),
        now()
    RETURNING id
),

org_insert AS (
    INSERT INTO public.orgs (id, created_by, name, management_email)
    SELECT
        gen_random_uuid(),
        user_insert.id,
        'Tier Credits Org',
        'tier-credits@example.com'
    FROM user_insert
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
        450,
        0,
        now(),
        now() + interval '1 year',
        'manual'
    FROM org_insert
    RETURNING org_id
)

INSERT INTO tier_ctx (org_id)
SELECT grant_insert.org_id FROM grant_insert;

CREATE TEMP TABLE tier_result ON COMMIT DROP AS
SELECT r.*
FROM tier_ctx,
    LATERAL public.apply_usage_overage(
        tier_ctx.org_id,
        'mau',
        4000000,
        date_trunc('month', now()),
        date_trunc('month', now()) + interval '1 month',
        '{"usage": 5000000, "limit": 1000000}'::jsonb,
        1000000
    ) AS r;

SELECT
    results_eq(
        $$SELECT credits_required, credits_applied FROM tier_result$$,
        $$VALUES (1100.0::numeric, 450.0::numeric)$$,
        'partial credits are fully applied against the tiered cost'
    );

SELECT
    results_eq(
        $$SELECT overage_covered, overage_unpaid FROM tier_result$$,
        $$VALUES (1500000.0::numeric, 2500000.0::numeric)$$,
        'covered usage walks the tier slices'
    );

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
