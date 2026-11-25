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
