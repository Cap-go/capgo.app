BEGIN;

SELECT plan(8);

-- The retention batch selectors must stay set-based: one pass over the
-- canceled orgs, not a per-org may_receive / last-activity call.
SELECT
    is(
        (
            SELECT prosrc FROM pg_proc
            WHERE
                oid
                = 'public.canceled_org_ids_past_grace(integer)'::regprocedure
        ) ILIKE '%public.canceled_org_may_receive_retention_deletion(%',
        false,
        'canceled_org_ids_past_grace() does not check orgs one by one'
    );

SELECT
    is(
        (
            SELECT prosrc FROM pg_proc
            WHERE oid = 'public.canceled_org_retention_states()'::regprocedure
        ) ILIKE '%public.canceled_org_last_activity_at(%',
        false,
        'canceled_org_retention_states() does not call the per-org activity scan'
    );

-- Canceled orgs covering each anchor and exemption source:
--   idle      access ended 100 days ago, no later activity
--   app       an app created 10 days ago moves the anchor
--   version   a live bundle updated 20 days ago moves the anchor
--   mau       MAU 30 days ago moves the anchor
--   credits   has_usage_credits exempts the org
--   grant     a credit grant after access end exempts the org and moves the anchor
--   expiry    an expiry transaction is not activity
CREATE TEMP TABLE retention_states_ctx AS
SELECT
    v.label,
    v.org_id,
    v.has_usage_credits,
    v.access_end,
    'cus_retention_states_' || v.label AS customer_id,
    'com.test.retention.states.' || v.label AS app_id
FROM (
    VALUES
    (
        'idle',
        'b1c2d3e4-0000-4000-8000-000000000001'::uuid,
        false,
        now() - interval '100 days'
    ),
    (
        'app',
        'b1c2d3e4-0000-4000-8000-000000000002'::uuid,
        false,
        now() - interval '100 days'
    ),
    (
        'version',
        'b1c2d3e4-0000-4000-8000-000000000003'::uuid,
        false,
        now() - interval '100 days'
    ),
    (
        'mau',
        'b1c2d3e4-0000-4000-8000-000000000004'::uuid,
        false,
        now() - interval '100 days'
    ),
    (
        'credits',
        'b1c2d3e4-0000-4000-8000-000000000005'::uuid,
        true,
        now() - interval '100 days'
    ),
    (
        'grant',
        'b1c2d3e4-0000-4000-8000-000000000006'::uuid,
        false,
        now() - interval '100 days'
    ),
    (
        'expiry',
        'b1c2d3e4-0000-4000-8000-000000000007'::uuid,
        false,
        now() - interval '100 days'
    )
) AS v (label, org_id, has_usage_credits, access_end);

INSERT INTO public.stripe_info (
    customer_id, status, product_id, trial_at, is_good_plan,
    subscription_anchor_start, subscription_anchor_end, canceled_at
)
SELECT
    customer_id,
    'canceled'::public.stripe_status,
    'prod_LQIregjtNduh4q',
    access_end,
    false,
    access_end,
    access_end,
    access_end
FROM retention_states_ctx;

INSERT INTO public.orgs (
    id, created_by, name, management_email, customer_id, has_usage_credits
)
SELECT
    org_id,
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    'Retention States ' || label,
    'retention-states-' || label || '@test.local',
    customer_id,
    has_usage_credits
FROM retention_states_ctx;

INSERT INTO public.apps (app_id, owner_org, name, icon_url, created_at)
SELECT
    app_id,
    org_id,
    'Retention States ' || label,
    '',
    CASE
        WHEN label = 'app' THEN now() - interval '10 days' ELSE
            now() - interval '200 days'
    END
FROM retention_states_ctx;

INSERT INTO public.app_versions (
    app_id, name, owner_org, created_at, updated_at
)
SELECT
    app_id,
    '1.0.0',
    org_id,
    now() - interval '200 days',
    now() - interval '20 days'
FROM retention_states_ctx
WHERE label = 'version';

INSERT INTO public.daily_mau (app_id, date, mau)
SELECT
    app_id,
    (now() - interval '30 days')::date,
    3
FROM retention_states_ctx
WHERE label = 'mau';

INSERT INTO public.usage_credit_grants (
    org_id, credits_total, credits_consumed, granted_at, source
)
SELECT
    org_id,
    5,
    0,
    now() - interval '15 days',
    'stripe_top_up'
FROM retention_states_ctx
WHERE label = 'grant';

INSERT INTO public.usage_credit_transactions (
    org_id, transaction_type, amount, balance_after, occurred_at
)
SELECT
    org_id,
    'expiry'::public.credit_transaction_type,
    -1,
    0,
    now() - interval '5 days'
FROM retention_states_ctx
WHERE label = 'expiry';

SELECT
    is(
        (
            SELECT count(*)::integer
            FROM retention_states_ctx AS ctx
            INNER JOIN
                public.canceled_org_retention_states() AS state
                ON ctx.org_id = state.org_id
        ),
        7,
        'every canceled fixture org has a retention state'
    );

SELECT
    is(
        (
            SELECT count(*)::integer
            FROM retention_states_ctx AS ctx
            INNER JOIN
                public.canceled_org_retention_states() AS state
                ON ctx.org_id = state.org_id
            WHERE
                state.anchor_at IS DISTINCT FROM public.canceled_org_retention_anchor(
                    ctx.org_id
                )
        ),
        0,
        'set-based anchor matches canceled_org_retention_anchor() for every fixture org'
    );

SELECT
    is(
        (
            SELECT count(*)::integer
            FROM retention_states_ctx AS ctx
            INNER JOIN
                public.canceled_org_retention_states() AS state
                ON ctx.org_id = state.org_id
            WHERE
                state.credit_exempt IS DISTINCT FROM public.canceled_org_retention_credit_purchase_exempt(
                    ctx.org_id
                )
        ),
        0,
        'set-based exemption matches canceled_org_retention_credit_purchase_exempt() for every fixture org'
    );

SELECT
    is(
        (
            SELECT array_agg(ctx.label ORDER BY ctx.label)
            FROM retention_states_ctx AS ctx
            WHERE ctx.org_id IN (SELECT public.canceled_org_ids_past_grace(90))
        ),
        (
            SELECT array_agg(ctx.label ORDER BY ctx.label)
            FROM retention_states_ctx AS ctx
            WHERE
                public.canceled_org_may_receive_retention_deletion(
                    ctx.org_id, 90
                )
        ),
        'canceled_org_ids_past_grace(90) matches the per-org deletion check'
    );

SELECT
    is(
        (
            SELECT array_agg(ctx.label ORDER BY ctx.label)
            FROM retention_states_ctx AS ctx
            WHERE ctx.org_id IN (SELECT public.canceled_org_ids_past_grace(90))
        ),
        ARRAY['expiry', 'idle'],
        'only the idle org and the org with an expiry-only transaction are past the 90-day grace'
    );

SELECT
    is(
        (
            SELECT array_agg(ctx.label ORDER BY ctx.label)
            FROM retention_states_ctx AS ctx
            WHERE ctx.org_id IN (SELECT public.canceled_org_ids_past_grace(25))
        ),
        ARRAY['expiry', 'idle', 'mau'],
        'at a 25-day grace, 30-day-old MAU is past it while newer app, bundle and credit activity is not'
    );

SELECT * FROM finish();

ROLLBACK;
