ALTER TABLE public.channels
  ADD COLUMN IF NOT EXISTS bundle_alert_enabled boolean;
COMMENT ON COLUMN public.channels.bundle_alert_enabled IS 'Override the app incompatible bundle email setting for this channel. NULL inherits the app setting.';
COMMENT ON COLUMN public.apps.bundle_incompatible_alert IS 'Default sends incompatible bundle alerts for default download channels. All includes every channel unless overridden.';
