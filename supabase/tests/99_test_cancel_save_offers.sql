BEGIN;

SELECT plan(12);

CREATE TEMP TABLE test_org ON COMMIT DROP AS
SELECT id FROM public.orgs ORDER BY created_at LIMIT 1;

-- A discount offer, as before: coupon, percent and duration, no credits.
SELECT lives_ok(
    $$INSERT INTO public.cancel_save_offers
        (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, coupon_id, percent_off, duration_months)
      SELECT id, 'cus_discount', 'sub_discount', 'ee', 'too_expensive', 2900, 'usd', 'capgo_cancel_save_50_3m', 50, 3 FROM test_org$$,
    'a discount offer keeps its coupon fields and defaults to offer_type discount'
);

SELECT is(
    (SELECT offer_type FROM public.cancel_save_offers WHERE customer_id = 'cus_discount'),
    'discount',
    'offer_type defaults to discount'
);

-- A credits offer: credits only, no discount fields.
SELECT lives_ok(
    $$INSERT INTO public.cancel_save_offers
        (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, offer_type, credits)
      SELECT id, 'cus_credits', 'sub_credits', 'ee', 'unused', 2900, 'usd', 'credits', 29 FROM test_org$$,
    'a credits offer stores credits without coupon fields'
);

SELECT throws_ok(
    $$INSERT INTO public.cancel_save_offers
        (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, offer_type)
      SELECT id, 'cus_bad', 'sub_bad', 'ee', 'unused', 2900, 'usd', 'credits' FROM test_org$$,
    '23514',
    NULL,
    'a credits offer needs credits'
);

SELECT throws_ok(
    $$INSERT INTO public.cancel_save_offers
        (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, offer_type, credits, coupon_id, percent_off, duration_months)
      SELECT id, 'cus_bad', 'sub_bad', 'ee', 'unused', 2900, 'usd', 'credits', 29, 'c', 50, 3 FROM test_org$$,
    '23514',
    NULL,
    'a credits offer cannot carry discount fields'
);

SELECT throws_ok(
    $$INSERT INTO public.cancel_save_offers
        (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency)
      SELECT id, 'cus_bad', 'sub_bad', 'ee', 'too_expensive', 2900, 'usd' FROM test_org$$,
    '23514',
    NULL,
    'a discount offer needs its coupon fields'
);

-- Accepting: a discount needs its Stripe dates, credits need nothing more.
SELECT throws_ok(
    $$UPDATE public.cancel_save_offers SET outcome = 'accepted', responded_at = now() WHERE customer_id = 'cus_discount'$$,
    '23514',
    NULL,
    'an accepted discount needs its discount dates'
);

-- The cancel flow grant is a source of its own, never a purchase.
SELECT lives_ok(
    $$WITH g AS (
        INSERT INTO public.usage_credit_grants (org_id, credits_total, credits_consumed, source, source_ref, notes)
        SELECT id, 29, 0, 'cancel_save_offer', '{"cancelSaveOfferId":"test"}', 'test' FROM test_org
        RETURNING id
      )
      UPDATE public.cancel_save_offers SET credit_grant_id = (SELECT id FROM g), outcome = 'accepted', responded_at = now()
      WHERE customer_id = 'cus_credits'$$,
    'usage_credit_grants accepts the cancel_save_offer source and an accepted credits offer links its grant'
);

SELECT throws_ok(
    $$INSERT INTO public.usage_credit_grants (org_id, credits_total, source) SELECT id, 1, 'gift' FROM test_org$$,
    '23514',
    NULL,
    'other grant sources are still rejected'
);

SELECT ok(
    (SELECT has_usage_credits FROM public.orgs WHERE id = (SELECT id FROM test_org)),
    'the grant marks the org as holding credits, which skips later offers'
);

-- One save per customer, whatever the offer type.
SELECT throws_ok(
    $$INSERT INTO public.cancel_save_offers
        (org_id, customer_id, subscription_id, billing_account, reason, monthly_amount, currency, offer_type, credits, outcome, responded_at)
      SELECT id, 'cus_credits', 'sub_credits', 'ee', 'other', 2900, 'usd', 'credits', 29, 'accepting', now() FROM test_org$$,
    '23505',
    NULL,
    'a customer with an accepted save cannot reserve another'
);

-- Deleting the grant keeps the accepted offer and clears the link.
DELETE FROM public.usage_credit_grants WHERE source = 'cancel_save_offer';
SELECT is(
    (SELECT credit_grant_id FROM public.cancel_save_offers WHERE customer_id = 'cus_credits'),
    NULL,
    'deleting the grant clears credit_grant_id on the accepted offer'
);

SELECT * FROM finish();

ROLLBACK;
