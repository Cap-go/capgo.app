ALTER TABLE public.apps
ADD COLUMN stats_mode text NOT NULL DEFAULT 'all';

ALTER TABLE public.apps
ADD CONSTRAINT apps_stats_mode_check
CHECK (stats_mode IN ('all', 'updatesOnly', 'billingOnly'));

COMMENT ON COLUMN public.apps.stats_mode IS 'Controls which device telemetry Capgo stores from /stats. all = full collection (default). updatesOnly = OTA pipeline events only. billingOnly = minimal billing fields only.';
