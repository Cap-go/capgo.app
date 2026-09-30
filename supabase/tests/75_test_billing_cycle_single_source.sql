-- 75_test_billing_cycle_single_source.sql
-- One billing cycle source of truth (billing_cycle_for_anchor /
-- get_org_billing_cycle): stored Stripe period is used as-is while current,
-- stale/yearly periods roll monthly from the ORIGINAL anchor day (31 ->
-- Feb 28/29 -> Mar 31 -> Apr 30), and no Stripe period -> UTC calendar month.
BEGIN;

SELECT plan(38);

-- ---------------------------------------------------------------------------
-- Anchor derivation
-- ---------------------------------------------------------------------------
SELECT is(
    public.billing_cycle_anchor(
        '2026-02-28 14:00:00+00', '2026-03-31 14:00:00+00'
    ),
    '2000-01-31 14:00:00+00'::timestamptz,
    'anchor: Feb 28 -> Mar 31 period keeps anchor day 31 and time'
);

SELECT is(
    public.billing_cycle_anchor(
        '2026-01-31 14:00:00+00', '2026-02-28 14:00:00+00'
    ),
    '2000-01-31 14:00:00+00'::timestamptz,
    'anchor: Jan 31 -> Feb 28 period keeps anchor day 31'
);

SELECT is(
    public.billing_cycle_anchor(
        '2026-01-15 09:30:00+00', '2026-02-15 09:30:00+00'
    ),
    '2000-01-15 09:30:00+00'::timestamptz,
    'anchor: day 15 period keeps anchor day 15'
);

SELECT is(
    public.billing_cycle_anchor(NULL, NULL),
    NULL::timestamptz,
    'anchor: no Stripe period -> NULL'
);

-- ---------------------------------------------------------------------------
-- Anchor day 31: stored period is current -> returned as-is
-- ---------------------------------------------------------------------------
SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-31 14:00:00+00',
        '2026-02-28 14:00:00+00',
        '2026-02-15 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-01-31 14:00:00+00'::timestamptz,
        '2026-02-28 14:00:00+00'::timestamptz
    )
    $$,
    'day 31: current stored Jan 31 -> Feb 28 period is returned as-is'
);

-- Regression: the old offset math rolled on Mar 28 (anchor "day 28").
SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-02-28 14:00:00+00',
        '2026-03-31 14:00:00+00',
        '2026-03-29 12:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-02-28 14:00:00+00'::timestamptz,
        '2026-03-31 14:00:00+00'::timestamptz
    )
    $$,
    'day 31: Mar 29 is still inside the Stripe Feb 28 -> Mar 31 period (no Mar 28 roll)'
);

-- ---------------------------------------------------------------------------
-- Anchor day 31: stale stored period -> fixed-anchor monthly roll
-- ---------------------------------------------------------------------------
SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-31 14:00:00+00',
        '2026-02-28 14:00:00+00',
        '2026-03-10 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-02-28 14:00:00+00'::timestamptz,
        '2026-03-31 14:00:00+00'::timestamptz
    )
    $$,
    'day 31 stale: March rolls Feb 28 -> Mar 31 (not Mar 28)'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-31 14:00:00+00',
        '2026-02-28 14:00:00+00',
        '2026-03-31 13:59:59+00'
    )
    $$,
    $$
    VALUES (
        '2026-02-28 14:00:00+00'::timestamptz,
        '2026-03-31 14:00:00+00'::timestamptz
    )
    $$,
    'day 31 stale: one second before Mar 31 anchor time is still the Feb cycle'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-31 14:00:00+00',
        '2026-02-28 14:00:00+00',
        '2026-03-31 14:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-03-31 14:00:00+00'::timestamptz,
        '2026-04-30 14:00:00+00'::timestamptz
    )
    $$,
    'day 31 stale: Mar 31 at anchor time starts Mar 31 -> Apr 30'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-02-28 14:00:00+00',
        '2026-03-31 14:00:00+00',
        '2026-04-02 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-03-31 14:00:00+00'::timestamptz,
        '2026-04-30 14:00:00+00'::timestamptz
    )
    $$,
    'day 31 stale (webhook lag after Feb 28 -> Mar 31): April is Mar 31 -> Apr 30'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-31 14:00:00+00',
        '2026-02-28 14:00:00+00',
        '2026-05-01 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-04-30 14:00:00+00'::timestamptz,
        '2026-05-31 14:00:00+00'::timestamptz
    )
    $$,
    'day 31 stale: May 1 is Apr 30 -> May 31 (anchor day recovered after short month)'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2027-12-31 14:00:00+00',
        '2028-01-31 14:00:00+00',
        '2028-03-05 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2028-02-29 14:00:00+00'::timestamptz,
        '2028-03-31 14:00:00+00'::timestamptz
    )
    $$,
    'day 31 stale (leap year): Feb 29 -> Mar 31'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-31 14:00:00+00',
        '2026-02-28 14:00:00+00',
        '2026-03-01 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-02-28 14:00:00+00'::timestamptz,
        '2026-03-31 14:00:00+00'::timestamptz
    )
    $$,
    'day 31 stale: Mar 1 lies inside Feb 28 -> Mar 31 (old offset math started the cycle on Mar 3)'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2025-12-31 14:00:00+00',
        '2026-01-31 14:00:00+00',
        '2026-02-28 20:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-02-28 14:00:00+00'::timestamptz,
        '2026-03-31 14:00:00+00'::timestamptz
    )
    $$,
    'day 31 stale: late Feb 28 is in Feb 28 -> Mar 31 (old math returned Jan 31 -> Feb 28, already over)'
);

-- ---------------------------------------------------------------------------
-- Anchor day 15
-- ---------------------------------------------------------------------------
SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-06-15 09:30:00+00',
        '2026-07-15 09:30:00+00',
        '2026-06-20 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-06-15 09:30:00+00'::timestamptz,
        '2026-07-15 09:30:00+00'::timestamptz
    )
    $$,
    'day 15: current stored period returned as-is'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-15 09:30:00+00',
        '2026-02-15 09:30:00+00',
        '2026-06-20 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-06-15 09:30:00+00'::timestamptz,
        '2026-07-15 09:30:00+00'::timestamptz
    )
    $$,
    'day 15 stale: rolls to Jun 15 -> Jul 15 keeping anchor time'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-15 09:30:00+00',
        '2026-02-15 09:30:00+00',
        '2026-06-15 09:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-05-15 09:30:00+00'::timestamptz,
        '2026-06-15 09:30:00+00'::timestamptz
    )
    $$,
    'day 15 stale: before anchor time on the 15th is still the previous cycle'
);

-- ---------------------------------------------------------------------------
-- Yearly plan: monthly usage cycles from the yearly anchor
-- ---------------------------------------------------------------------------
SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-31 10:00:00+00',
        '2027-01-31 10:00:00+00',
        '2026-02-10 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-01-31 10:00:00+00'::timestamptz,
        '2026-02-28 10:00:00+00'::timestamptz
    )
    $$,
    'yearly day 31: February usage cycle is Jan 31 -> Feb 28'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        '2026-01-31 10:00:00+00',
        '2027-01-31 10:00:00+00',
        '2026-04-01 00:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-03-31 10:00:00+00'::timestamptz,
        '2026-04-30 10:00:00+00'::timestamptz
    )
    $$,
    'yearly day 31: April usage cycle is Mar 31 -> Apr 30'
);

-- ---------------------------------------------------------------------------
-- No Stripe period: calendar month (UTC)
-- ---------------------------------------------------------------------------
SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.billing_cycle_for_anchor(
        NULL, NULL, '2026-02-10 12:00:00+00'
    )
    $$,
    $$
    VALUES (
        '2026-02-01 00:00:00+00'::timestamptz,
        '2026-03-01 00:00:00+00'::timestamptz
    )
    $$,
    'no Stripe period: UTC calendar month'
);

-- ---------------------------------------------------------------------------
-- Org-level wrappers
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE billing_cycle_ctx (
    user_id uuid,
    org_id uuid,
    free_org_id uuid,
    customer_id text,
    period_start timestamptz,
    period_end timestamptz
) ON COMMIT DROP;

DO $$
BEGIN
    PERFORM tests.create_supabase_user(
        'billing_cycle_single_source_user',
        'billing-cycle-single-source@example.com',
        '555-000-0075'
    );
END;
$$ LANGUAGE plpgsql;

INSERT INTO billing_cycle_ctx (
    user_id, org_id, free_org_id, customer_id, period_start, period_end
)
VALUES (
    tests.get_supabase_uid('billing_cycle_single_source_user'),
    gen_random_uuid(),
    gen_random_uuid(),
    'cus_billing_cycle_single_source_test',
    date_trunc('second', now()) - interval '3 days',
    date_trunc('second', now()) + interval '27 days'
);

INSERT INTO public.users (id, email, created_at, updated_at)
SELECT user_id, 'billing-cycle-single-source@example.com', now(), now()
FROM billing_cycle_ctx;

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
    'sub_billing_cycle_single_source_test',
    period_start,
    period_end
FROM billing_cycle_ctx;

INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
SELECT
    org_id,
    user_id,
    'Billing Cycle Single Source Org',
    'billing-cycle-single-source@example.com',
    customer_id
FROM billing_cycle_ctx;

INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
SELECT
    free_org_id,
    user_id,
    'Billing Cycle Free Org',
    'billing-cycle-single-source@example.com',
    NULL
FROM billing_cycle_ctx;

-- Org creation may provision a customer + stripe_info; detach it so this org
-- really has no Stripe period.
UPDATE public.orgs
SET customer_id = NULL
WHERE id = (SELECT free_org_id FROM billing_cycle_ctx);

SELECT results_eq(
    $$
    SELECT subscription_anchor_start, subscription_anchor_end
    FROM public.get_cycle_info_org((SELECT org_id FROM billing_cycle_ctx))
    $$,
    $$
    SELECT period_start, period_end FROM billing_cycle_ctx
    $$,
    'get_cycle_info_org returns the current stored Stripe period as-is'
);

SELECT results_eq(
    $$
    SELECT cycle_start, cycle_end
    FROM public.get_org_billing_cycle((SELECT org_id FROM billing_cycle_ctx))
    $$,
    $$
    SELECT period_start, period_end FROM billing_cycle_ctx
    $$,
    'get_org_billing_cycle returns the current stored Stripe period as-is'
);

SELECT results_eq(
    $$
    SELECT subscription_anchor_start, subscription_anchor_end
    FROM public.get_cycle_info_org((SELECT free_org_id FROM billing_cycle_ctx))
    $$,
    $$
    SELECT
        date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
        (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')
            AT TIME ZONE 'UTC'
    $$,
    'org without Stripe info: calendar month'
);

SELECT is(
    (
        SELECT count(*)::integer
        FROM public.get_org_billing_cycle(gen_random_uuid())
    ),
    1,
    'unknown org still yields one calendar-month row (legacy get_cycle_info_org shape)'
);

-- get_orgs_v7 exposes the same cycle
SELECT results_eq(
    $$
    SELECT subscription_start, subscription_end
    FROM public.get_orgs_v7((SELECT user_id FROM billing_cycle_ctx))
    WHERE gid = (SELECT org_id FROM billing_cycle_ctx)
    $$,
    $$
    SELECT period_start, period_end FROM billing_cycle_ctx
    $$,
    'get_orgs_v7 subscription_start/end match the Stripe period'
);

-- Metrics callers key the org metrics cache on the same UTC dates
DELETE FROM public.org_metrics_cache
WHERE org_id = (SELECT org_id FROM billing_cycle_ctx);

SELECT ok(
    (SELECT count(*) FROM public.get_total_metrics((SELECT org_id FROM billing_cycle_ctx))) = 1,
    'get_total_metrics(org) runs'
);

SELECT results_eq(
    $$
    SELECT start_date, end_date
    FROM public.org_metrics_cache
    WHERE org_id = (SELECT org_id FROM billing_cycle_ctx)
    $$,
    $$
    SELECT
        (period_start AT TIME ZONE 'UTC')::date,
        (period_end AT TIME ZONE 'UTC')::date
    FROM billing_cycle_ctx
    $$,
    'get_total_metrics(org) uses the Stripe period dates'
);

DELETE FROM public.org_metrics_cache
WHERE org_id = (SELECT org_id FROM billing_cycle_ctx);

SELECT ok(
    (SELECT count(*) FROM public.get_plan_usage_and_fit_uncached((SELECT org_id FROM billing_cycle_ctx))) = 1,
    'get_plan_usage_and_fit_uncached runs'
);

SELECT results_eq(
    $$
    SELECT start_date, end_date
    FROM public.org_metrics_cache
    WHERE org_id = (SELECT org_id FROM billing_cycle_ctx)
    $$,
    $$
    SELECT
        (period_start AT TIME ZONE 'UTC')::date,
        (period_end AT TIME ZONE 'UTC')::date
    FROM billing_cycle_ctx
    $$,
    'get_plan_usage_and_fit_uncached uses the same cycle dates as get_total_metrics'
);

DELETE FROM public.org_metrics_cache
WHERE org_id = (SELECT org_id FROM billing_cycle_ctx);

SELECT ok(
    (SELECT count(*) FROM public.get_plan_usage_and_fit((SELECT org_id FROM billing_cycle_ctx))) = 1,
    'get_plan_usage_and_fit runs'
);

SELECT results_eq(
    $$
    SELECT start_date, end_date
    FROM public.org_metrics_cache
    WHERE org_id = (SELECT org_id FROM billing_cycle_ctx)
    $$,
    $$
    SELECT
        (period_start AT TIME ZONE 'UTC')::date,
        (period_end AT TIME ZONE 'UTC')::date
    FROM billing_cycle_ctx
    $$,
    'get_plan_usage_and_fit uses the same cycle dates as get_total_metrics'
);

SELECT ok(
    public.is_good_plan_v5_org((SELECT org_id FROM billing_cycle_ctx)) IS NOT NULL,
    'is_good_plan_v5_org runs on the shared cycle'
);

-- ---------------------------------------------------------------------------
-- Billing period email anniversary uses the real anchor day
-- ---------------------------------------------------------------------------
SELECT is(
    (
        SELECT is_anniversary
        FROM public.billing_period_completed_cycle(
            public.billing_cycle_anchor(
                '2026-02-28 14:00:00+00', '2026-03-31 14:00:00+00'
            ),
            '2026-03-28'::date
        )
    ),
    false,
    'email: Feb 28 -> Mar 31 period is not an anniversary on Mar 28'
);

SELECT results_eq(
    $$
    SELECT is_anniversary, cycle_start, cycle_end
    FROM public.billing_period_completed_cycle(
        public.billing_cycle_anchor(
            '2026-02-28 14:00:00+00', '2026-03-31 14:00:00+00'
        ),
        '2026-03-31'::date
    )
    $$,
    $$
    VALUES (
        true,
        '2026-02-28 00:00:00+00'::timestamptz,
        '2026-03-31 00:00:00+00'::timestamptz
    )
    $$,
    'email: Feb 28 -> Mar 31 period completes on Mar 31'
);

-- ---------------------------------------------------------------------------
-- Grants: helpers are internal, public RPC surface unchanged
-- ---------------------------------------------------------------------------
SELECT ok(
    NOT has_function_privilege(
        'authenticated', 'public.get_org_billing_cycle(uuid)', 'EXECUTE'
    )
    AND NOT has_function_privilege(
        'anon', 'public.get_org_billing_cycle(uuid)', 'EXECUTE'
    ),
    'get_org_billing_cycle is not callable by anon/authenticated'
);

SELECT ok(
    NOT has_function_privilege(
        'authenticated',
        'public.billing_cycle_for_anchor(timestamptz, timestamptz, timestamptz)',
        'EXECUTE'
    )
    AND NOT has_function_privilege(
        'anon',
        'public.billing_cycle_for_anchor(timestamptz, timestamptz, timestamptz)',
        'EXECUTE'
    ),
    'billing_cycle_for_anchor is not callable by anon/authenticated'
);

SELECT ok(
    has_function_privilege(
        'authenticated', 'public.get_cycle_info_org(uuid)', 'EXECUTE'
    )
    AND has_function_privilege(
        'service_role', 'public.get_cycle_info_org(uuid)', 'EXECUTE'
    ),
    'get_cycle_info_org grants unchanged'
);

SELECT ok(
    has_function_privilege(
        'anon', 'public.is_good_plan_v5_org(uuid)', 'EXECUTE'
    )
    AND has_function_privilege(
        'authenticated', 'public.is_good_plan_v5_org(uuid)', 'EXECUTE'
    ),
    'is_good_plan_v5_org grants unchanged'
);

SELECT * FROM finish();

ROLLBACK;
