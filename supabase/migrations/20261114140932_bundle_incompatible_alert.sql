-- Existing apps and new apps email the incompatible-bundle warning only for the
-- default upload channel. `all` restores the previous every-channel behavior.
ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS bundle_incompatible_alert text NOT NULL DEFAULT 'default';

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_bundle_incompatible_alert_check;

ALTER TABLE public.apps
  ADD CONSTRAINT apps_bundle_incompatible_alert_check
  CHECK (bundle_incompatible_alert = ANY (ARRAY['default'::text, 'all'::text]));

COMMENT ON COLUMN public.apps.bundle_incompatible_alert IS
  'Which channels email org members when an incompatible bundle goes live. default = only the app default upload channel. all = every channel. Existing and new apps default to default.';
