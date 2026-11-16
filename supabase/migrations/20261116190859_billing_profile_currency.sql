ALTER TABLE public.stripe_info
ADD COLUMN billing_address jsonb,
ADD COLUMN billing_currency text CHECK (billing_currency ~ '^[a-z]{3}$');
COMMENT ON COLUMN public.stripe_info.billing_address IS 'Current Stripe customer billing address, synchronized on billing edits and customer webhooks.';
COMMENT ON COLUMN public.stripe_info.billing_currency IS 'Stripe customer billing currency; changing the address does not change an existing currency.';
