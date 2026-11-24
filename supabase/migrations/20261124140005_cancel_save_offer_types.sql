-- Cancel flow offers now depend on the reason the customer gives:
--   'discount': the existing percent off the next months (too expensive, quality, ...).
--   'credits':  for customers who barely use Capgo (unused, other): stop the monthly
--               plan at period end and receive usage credits worth one month of it,
--               so their apps keep receiving updates on pay-as-you-go.
-- A discount row keeps coupon/percent/duration; a credits row keeps the credits granted.

-- Credits given by the cancel flow are a grant of their own, never a purchase.
ALTER TABLE public.usage_credit_grants DROP CONSTRAINT usage_credit_grants_source_check;
ALTER TABLE public.usage_credit_grants
  ADD CONSTRAINT usage_credit_grants_source_check CHECK (source IN ('manual', 'stripe_top_up', 'cancel_save_offer')) NOT VALID;
-- NOT VALID: the new list is a superset of the old one, so existing rows already pass
-- and the table is not scanned under the ACCESS EXCLUSIVE lock. New writes are checked.

ALTER TABLE public.cancel_save_offers
  ADD COLUMN offer_type text NOT NULL DEFAULT 'discount' CHECK (offer_type IN ('discount', 'credits')),
  ADD COLUMN credits numeric CHECK (credits IS NULL OR credits > 0),
  ADD COLUMN credit_grant_id uuid REFERENCES public.usage_credit_grants (id) ON DELETE SET NULL;

ALTER TABLE public.cancel_save_offers
  ALTER COLUMN coupon_id DROP NOT NULL,
  ALTER COLUMN percent_off DROP NOT NULL,
  ALTER COLUMN duration_months DROP NOT NULL;

ALTER TABLE public.cancel_save_offers
  ADD CONSTRAINT cancel_save_offers_type_fields_check CHECK (
    (offer_type = 'discount' AND coupon_id IS NOT NULL AND percent_off IS NOT NULL AND duration_months IS NOT NULL AND credits IS NULL)
    OR (offer_type = 'credits' AND credits IS NOT NULL AND coupon_id IS NULL AND percent_off IS NULL AND duration_months IS NULL)
  );

-- An accepted discount has its Stripe discount dates. Accepted credits are linked to
-- their grant through credit_grant_id (cleared if an admin deletes that grant).
ALTER TABLE public.cancel_save_offers DROP CONSTRAINT cancel_save_offers_check1;
ALTER TABLE public.cancel_save_offers
  ADD CONSTRAINT cancel_save_offers_accepted_check CHECK (
    outcome <> 'accepted'
    OR (offer_type = 'discount' AND discount_start IS NOT NULL AND discount_end IS NOT NULL)
    OR offer_type = 'credits'
  );

COMMENT ON TABLE public.cancel_save_offers IS
  'Offers shown in the cancel flow (a discount, or credits instead of the monthly plan) and their outcome (offered, accepting, accepted, declined). Written by private/stripe_billing with the service role only.';

-- Historical repair. Between 2026-11-16 and 2026-11-24 three accepts failed before
-- Stripe applied any discount (the save coupon was never created in Stripe), and the
-- rows stayed 'accepting' forever. That blocked any later offer for those customers
-- and kept them out of every series of the admin chart. Stripe shows no discount on
-- any of the three subscriptions (checked 2026-11-24):
--   2309f0e5…: the customer canceled 5 s after the failed accept (Stripe
--              canceled_at 2026-11-17 18:11:19 UTC), so it is a decline.
--   67a77f36…, d5939775…: still active and never canceled, so no answer.
UPDATE public.cancel_save_offers
SET outcome = 'declined', responded_at = '2026-11-17 18:11:19+00'
WHERE id = '2309f0e5-bd7c-48f2-8a07-1de9ec4c62aa'
  AND outcome = 'accepting'
  AND discount_start IS NULL;

UPDATE public.cancel_save_offers
SET outcome = 'offered', responded_at = NULL
WHERE id IN ('67a77f36-5660-4e4a-a669-2ed02582fd6a', 'd5939775-9c67-4666-becb-c7a1868eae32')
  AND outcome = 'accepting'
  AND discount_start IS NULL;
