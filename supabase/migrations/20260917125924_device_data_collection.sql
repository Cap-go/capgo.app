ALTER TABLE public.apps
ADD COLUMN IF NOT EXISTS device_data_collection jsonb NOT NULL DEFAULT jsonb_build_object(
  'country', true,
  'platform', true,
  'os_version', true,
  'plugin_version', true,
  'version_build', true,
  'is_emulator', true,
  'is_prod', true,
  'install_source', true
);

COMMENT ON COLUMN public.apps.device_data_collection IS
  'Per-app flags for optional device telemetry persisted to stats/devices. Update routing may still use request fields when a flag is false. Missing keys default to true.';

ALTER TABLE public.devices
  ALTER COLUMN platform DROP NOT NULL;

COMMENT ON COLUMN public.devices.platform IS
  'Device OS platform. Null when the app disables platform collection.';
