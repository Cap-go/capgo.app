BEGIN;

SELECT plan(13);

INSERT INTO public.stripe_info (
    customer_id,
    product_id,
    status,
    subscription_anchor_start,
    subscription_anchor_end
)
SELECT
    'cus_test_cycle_top_up',
    plans.stripe_id,
    'succeeded',
    now() - interval '3 days',
    now() + interval '27 days'
FROM public.plans
LIMIT 1;

CREATE TEMP TABLE test_cycle_context AS
WITH org_insert AS (
    INSERT INTO public.orgs (
        id,
        created_by,
        name,
        management_email,
        customer_id
    )
    SELECT
        gen_random_uuid(),
        users.id,
        'Cycle Top Up Org',
        'cycle-top-up@example.com',
        'cus_test_cycle_top_up'
    FROM public.users AS users
    WHERE users.email = 'test@capgo.app'
    RETURNING id
)
SELECT id AS org_id FROM org_insert;

SELECT
    throws_ok(
        $$
      UPDATE public.orgs
      SET auto_top_up_cycle_amount = 9
      WHERE id = (SELECT org_id FROM test_cycle_context)
    $$,
        '23514',
        'new row for relation "orgs" violates check constraint "orgs_auto_top_up_cycle_amount_min"',
        'auto_top_up_cycle_amount enforces the $10 minimum'
    );

SELECT
    is(
        (SELECT claimed FROM public.try_claim_credit_cycle_top_up((SELECT org_id FROM test_cycle_context))),
        false,
        'cycle top-up is not claimed while disabled'
    );

UPDATE public.orgs
SET
    auto_top_up_cycle_enabled = true,
    auto_top_up_cycle_amount = 600
WHERE id = (SELECT org_id FROM test_cycle_context);

CREATE TEMP TABLE test_cycle_claim AS
SELECT *
FROM public.try_claim_credit_cycle_top_up((SELECT org_id FROM test_cycle_context));

SELECT
    is(
        (SELECT claimed FROM test_cycle_claim),
        true,
        'cycle top-up is claimed once enabled for the current cycle'
    );

SELECT
    is(
        (SELECT amount FROM test_cycle_claim),
        600::numeric,
        'cycle top-up claim returns the configured amount'
    );

SELECT
    is(
        (SELECT cycle_start FROM test_cycle_claim),
        (SELECT cycle.cycle_start FROM public.get_org_billing_cycle((SELECT org_id FROM test_cycle_context)) AS cycle),
        'cycle top-up claim is keyed on the current billing cycle start'
    );

SELECT
    is(
        (SELECT claimed FROM public.try_claim_credit_cycle_top_up((SELECT org_id FROM test_cycle_context))),
        false,
        'cycle top-up is claimed at most once per billing cycle'
    );

-- A failed charge releases the cycle; the retry waits for the cooldown.
SELECT public.release_credit_cycle_top_up(
    (SELECT org_id FROM test_cycle_context),
    (SELECT cycle_start FROM test_cycle_claim),
    true
);

SELECT
    is(
        (SELECT auto_top_up_cycle_attempt FROM public.orgs WHERE id = (SELECT org_id FROM test_cycle_context)),
        1,
        'release after a confirmed failure moves to a new idempotency attempt'
    );

SELECT
    is(
        (SELECT claimed FROM public.try_claim_credit_cycle_top_up((SELECT org_id FROM test_cycle_context))),
        false,
        'released cycle top-up waits for the retry cooldown'
    );

UPDATE public.orgs
SET auto_top_up_cycle_last_attempt_at = now() - interval '7 hours'
WHERE id = (SELECT org_id FROM test_cycle_context);

SELECT
    is(
        (SELECT claimed FROM public.try_claim_credit_cycle_top_up((SELECT org_id FROM test_cycle_context))),
        true,
        'released cycle top-up is retried after the cooldown'
    );

-- A charge with an unknown outcome blocks new claims until reconciled.
UPDATE public.orgs
SET
    auto_top_up_cycle_paid_for = NULL,
    auto_top_up_cycle_last_attempt_at = NULL,
    auto_top_up_cycle_pending_intent_id = 'pi_test_pending'
WHERE id = (SELECT org_id FROM test_cycle_context);

SELECT
    is(
        (SELECT claimed FROM public.try_claim_credit_cycle_top_up((SELECT org_id FROM test_cycle_context))),
        false,
        'a pending scheduled PaymentIntent blocks a new cycle claim'
    );

UPDATE public.orgs
SET
    auto_top_up_cycle_pending_intent_id = NULL,
    auto_top_up_cycle_unknown_since = now()
WHERE id = (SELECT org_id FROM test_cycle_context);

SELECT
    is(
        (SELECT claimed FROM public.try_claim_credit_cycle_top_up((SELECT org_id FROM test_cycle_context))),
        false,
        'an unknown scheduled charge outcome blocks a new cycle claim'
    );

UPDATE public.orgs
SET auto_top_up_cycle_unknown_since = NULL
WHERE id = (SELECT org_id FROM test_cycle_context);

SELECT
    is(
        (SELECT attempt FROM public.try_claim_credit_cycle_top_up((SELECT org_id FROM test_cycle_context))),
        1,
        'claim returns the current idempotency attempt'
    );

-- The next billing cycle is claimable again.
UPDATE public.orgs
SET
    auto_top_up_cycle_paid_for = now() - interval '40 days',
    auto_top_up_cycle_last_attempt_at = now() - interval '7 hours'
WHERE id = (SELECT org_id FROM test_cycle_context);

SELECT
    is(
        (SELECT claimed FROM public.try_claim_credit_cycle_top_up((SELECT org_id FROM test_cycle_context))),
        true,
        'a new billing cycle can be claimed again'
    );

SELECT *
FROM
    finish();

ROLLBACK;
