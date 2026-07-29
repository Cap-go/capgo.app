-- Support exact lookups / filters by custom_id on the public device API.
-- Most devices keep the empty-string default, so index only non-empty values.
CREATE INDEX IF NOT EXISTS idx_devices_app_id_custom_id
ON public.devices USING btree (app_id, custom_id)
WHERE custom_id <> '';
