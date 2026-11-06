-- The admin dashboard (Cap-go/capgo_admin_dashboard) owns active reporting.
-- It produces history from read-only Capgo reads, the Stripe API and builder:
-- - revenue and trial extension history, from stripe_info changes;
-- - stripe_refunds, from the Stripe refunds API;
-- - builder_capacity_events, from the builder's own endpoints.
-- cli_usage was only the non-Workers fallback of the CLI_USAGE Analytics Engine
-- dataset and is empty in production.
-- daily_revenue_metrics stays as a frozen reconciliation source until its
-- dashboard copy is verified. Capgo no longer writes it. Drop it only in a
-- later migration after the remaining revenue differences are resolved.
-- No view, function, foreign key or publication depends on the dropped tables
-- apart from the trial trigger dropped here. processed_stripe_events stays:
-- it deduplicates Stripe webhook side effects.
SET LOCAL lock_timeout = '2s';

DROP TRIGGER IF EXISTS record_trial_extension_event_on_stripe_info
ON public.stripe_info;
DROP FUNCTION IF EXISTS public.record_trial_extension_event();

DROP TABLE IF EXISTS public.trial_extension_events;
DROP TABLE IF EXISTS public.stripe_refunds;
DROP TABLE IF EXISTS public.builder_capacity_events;
DROP TABLE IF EXISTS public.cli_usage;
