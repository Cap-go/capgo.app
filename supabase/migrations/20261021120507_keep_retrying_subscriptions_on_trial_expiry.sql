-- A trial org whose plan started at trial end but whose first charge failed has a live
-- Stripe subscription (status 'failed' = past_due) that Stripe keeps retrying. Canceling
-- the row here unlinked that subscription from Billing (no "Pay now", no cancel) while
-- Stripe could still charge it. Leave those rows alone: dunning handles them and Stripe's
-- own cancellation webhook marks them canceled if it gives up.
CREATE OR REPLACE FUNCTION public.process_free_trial_expired()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.stripe_info
  SET
    is_good_plan = false,
    status = 'canceled',
    canceled_at = COALESCE(canceled_at, trial_at)
  WHERE (status IS NULL OR status NOT IN ('succeeded', 'deleted', 'canceled'))
    AND (status IS DISTINCT FROM 'failed' OR subscription_id IS NULL)
    AND trial_at IS NOT NULL
    AND trial_at < NOW();
END;
$$;

ALTER FUNCTION public.process_free_trial_expired() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_free_trial_expired() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_free_trial_expired() FROM anon;
REVOKE ALL ON FUNCTION public.process_free_trial_expired() FROM authenticated;
GRANT ALL ON FUNCTION public.process_free_trial_expired() TO service_role;

COMMENT ON FUNCTION public.process_free_trial_expired() IS
  'Marks expired never-converted trials as canceled (is_good_plan=false, status=canceled, canceled_at=trial_at) so they share the canceled-org retention path. Skips past_due subscriptions Stripe is still retrying.';
