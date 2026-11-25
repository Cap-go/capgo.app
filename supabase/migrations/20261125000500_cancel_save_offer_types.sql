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

-- Historical repair. Before this change, an accept that failed before Stripe applied
-- the discount could leave its offer 'accepting' forever. That blocked any later
-- offer for the customer and kept the row out of every series of the admin chart.
-- Such a row has no discount (discount_start) and, before this migration, no grant.
-- Only rows answered over an hour ago: an accept running during the deploy is left alone.
-- If the customer canceled after answering (stripe_info.canceled_at, synced from Stripe),
-- they canceled anyway: declined, keeping the time they answered. Otherwise the
-- customer never got the offer applied and kept paying: back to no answer.
UPDATE public.cancel_save_offers AS o
SET outcome = 'declined'
FROM public.stripe_info AS si
WHERE si.customer_id = o.customer_id
  AND si.canceled_at >= o.responded_at
  AND o.outcome = 'accepting'
  AND o.discount_start IS NULL
  AND o.credit_grant_id IS NULL
  AND o.responded_at < now() - interval '1 hour';

UPDATE public.cancel_save_offers
SET outcome = 'offered', responded_at = NULL
WHERE outcome = 'accepting'
  AND discount_start IS NULL
  AND credit_grant_id IS NULL
  AND responded_at < now() - interval '1 hour';

-- One row per cancel attempt that reaches the offer step, whatever was shown: the
-- discount or credits offer (offer_id), the call with the founder, or nothing (the
-- org already has credits, or the plan cannot be saved). cancel_save_offers only
-- has rows for offers, so without this table attempts with no offer and founder
-- call clicks were invisible. The admin dashboard reads both to measure each option.
CREATE TABLE public.cancel_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  reason text NOT NULL,
  offer_id uuid REFERENCES public.cancel_save_offers (id) ON DELETE SET NULL,
  founder_call_shown boolean NOT NULL DEFAULT false,
  -- First click on the booking link (the booking itself happens on book.capgo.app).
  founder_call_clicked_at timestamptz,
  -- Set when the customer confirmed the cancellation from this attempt.
  canceled_at timestamptz,
  CHECK (founder_call_clicked_at IS NULL OR founder_call_shown)
);

ALTER TABLE public.cancel_attempts OWNER TO postgres;

COMMENT ON TABLE public.cancel_attempts IS
  'Cancel attempts that reached the offer step: offer shown (if any), founder call shown and clicked, and whether the plan was canceled. Written by private/stripe_billing with the service role only.';

CREATE INDEX cancel_attempts_created_at_idx ON public.cancel_attempts (created_at);
CREATE INDEX cancel_attempts_offer_id_idx ON public.cancel_attempts (offer_id);

ALTER TABLE public.cancel_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all direct access" ON public.cancel_attempts AS RESTRICTIVE USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.cancel_attempts FROM PUBLIC;
REVOKE ALL ON TABLE public.cancel_attempts FROM anon;
REVOKE ALL ON TABLE public.cancel_attempts FROM authenticated;
GRANT ALL ON TABLE public.cancel_attempts TO service_role;
