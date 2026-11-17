BEGIN;
ALTER TABLE public.stripe_info
ADD COLUMN billing_address jsonb,
ADD COLUMN billing_currency text;
ALTER TABLE public.stripe_info ADD CONSTRAINT stripe_info_billing_currency_check CHECK (billing_currency ~ '^[a-z]{3}$') NOT VALID;
COMMENT ON COLUMN public.stripe_info.billing_address IS 'Current Stripe customer billing address, synchronized on billing edits and customer webhooks.';
COMMENT ON COLUMN public.stripe_info.billing_currency IS 'Selected billing currency, or Stripe default when unset. Active subscriptions keep their existing currency until they end.';

-- Release the column-add lock before scanning existing rows.
COMMIT;
BEGIN;
ALTER TABLE public.stripe_info VALIDATE CONSTRAINT stripe_info_billing_currency_check;
COMMIT;
