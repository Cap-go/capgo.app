-- Monthly credits bought on the subscription itself (Enterprise MAU slider).
-- Synced from the recurring credit subscription item by the Stripe webhook.
-- Yearly subscriptions store the monthly equivalent (quantity / 12).
ALTER TABLE public.stripe_info
ADD COLUMN IF NOT EXISTS recurring_credits numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.stripe_info.recurring_credits IS
'Credits per month bought through the recurring credit item of the subscription. 0 when none.';
