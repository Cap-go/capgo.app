-- Cancellation save offer: a discount offered when a customer cancels a
-- monthly plan. One row per offer shown; the outcome records whether the
-- customer took the discount (and stayed) or canceled anyway. The admin
-- dashboard reads this table with stripe_info to chart saves over time and
-- whether customers kept paying once the discount ended.
CREATE TABLE public.cancel_save_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  org_id uuid NOT NULL REFERENCES public.orgs (id) ON DELETE CASCADE,
  customer_id text NOT NULL,
  subscription_id text NOT NULL,
  billing_account text NOT NULL,
  reason text NOT NULL,
  -- Monthly price of the plan when the offer was shown, in the currency's minor unit.
  monthly_amount bigint NOT NULL,
  currency text NOT NULL,
  coupon_id text NOT NULL,
  percent_off integer NOT NULL CHECK (percent_off > 0 AND percent_off <= 100),
  duration_months integer NOT NULL CHECK (duration_months > 0),
  outcome text NOT NULL DEFAULT 'offered' CHECK (outcome IN ('offered', 'accepted', 'declined')),
  responded_at timestamptz,
  -- Set from the Stripe discount when the offer is accepted.
  discount_start timestamptz,
  discount_end timestamptz,
  CHECK ((outcome = 'offered') = (responded_at IS NULL)),
  CHECK (outcome <> 'accepted' OR (discount_start IS NOT NULL AND discount_end IS NOT NULL))
);

ALTER TABLE public.cancel_save_offers OWNER TO postgres;

COMMENT ON TABLE public.cancel_save_offers IS
  'Discounts offered in the cancel flow and their outcome (offered, accepted, declined). Written by private/stripe_billing with the service role only.';

CREATE INDEX cancel_save_offers_created_at_idx ON public.cancel_save_offers (created_at);
CREATE INDEX cancel_save_offers_customer_id_idx ON public.cancel_save_offers (customer_id);
-- A customer can take the save discount only once.
CREATE UNIQUE INDEX cancel_save_offers_one_accept_per_customer_idx
  ON public.cancel_save_offers (customer_id) WHERE outcome = 'accepted';

ALTER TABLE public.cancel_save_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all direct access" ON public.cancel_save_offers AS RESTRICTIVE USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.cancel_save_offers FROM PUBLIC;
REVOKE ALL ON TABLE public.cancel_save_offers FROM anon;
REVOKE ALL ON TABLE public.cancel_save_offers FROM authenticated;
GRANT ALL ON TABLE public.cancel_save_offers TO service_role;
