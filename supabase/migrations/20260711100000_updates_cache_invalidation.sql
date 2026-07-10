-- Targeted invalidation for the /updates colo cache
-- (see supabase/functions/_backend/utils/updates_colo_cache.ts).
--
-- Whenever a row that feeds the update hot path changes, notify the
-- triggers/cache_invalidate function (via pg_net, async, ~ms overhead per
-- write) which fans the per-app token bump out to every regional plugin
-- worker. The cache TTL remains the backstop if a call is lost.

-- Notify helper: dedupes, caps and chunks the app list so the payload is
-- always bounded (the fan-out endpoint enforces 100 ids per request; an
-- org bigger than the cap falls back to the cache TTL for the tail).
CREATE OR REPLACE FUNCTION public.notify_updates_cache_invalidation(p_app_ids text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deduped text[];
  chunk text[];
  chunk_size constant int := 100;
  max_apps constant int := 1000;
  i int;
BEGIN
  SELECT array_agg(DISTINCT app_id) INTO deduped
  FROM unnest(p_app_ids) AS app_id
  WHERE app_id IS NOT NULL AND app_id <> '';

  IF deduped IS NULL OR array_length(deduped, 1) = 0 THEN
    RETURN;
  END IF;
  IF array_length(deduped, 1) > max_apps THEN
    deduped := deduped[1:max_apps];
  END IF;

  i := 1;
  WHILE i <= array_length(deduped, 1) LOOP
    chunk := deduped[i:i + chunk_size - 1];
    PERFORM net.http_post(
      url := public.get_db_url() || '/functions/v1/triggers/cache_invalidate',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apisecret', public.get_apikey()
      ),
      body := jsonb_build_object('app_ids', to_jsonb(chunk)),
      timeout_milliseconds := 5000
    );
    i := i + chunk_size;
  END LOOP;
END;
$$;

-- The notify helper runs privileged fan-out (uses get_apikey()): it must
-- never be RPC-callable by API roles. Trigger functions are locked down the
-- same way for defense in depth.
REVOKE ALL ON FUNCTION public.notify_updates_cache_invalidation(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_updates_cache_invalidation(text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_updates_cache_invalidation(text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.invalidate_updates_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  app_ids text[];
BEGIN
  IF TG_TABLE_NAME IN ('channels', 'channel_devices', 'app_versions', 'apps') THEN
    IF TG_OP = 'DELETE' THEN
      app_ids := ARRAY[OLD.app_id::text];
    ELSE
      app_ids := ARRAY[NEW.app_id::text];
    END IF;
  ELSIF TG_TABLE_NAME = 'orgs' THEN
    SELECT array_agg(a.app_id::text) INTO app_ids
    FROM public.apps a
    WHERE a.owner_org = NEW.id;
  ELSIF TG_TABLE_NAME = 'stripe_info' THEN
    SELECT array_agg(a.app_id::text) INTO app_ids
    FROM public.apps a
    JOIN public.orgs o ON o.id = a.owner_org
    WHERE o.customer_id = NEW.customer_id;
  END IF;

  PERFORM public.notify_updates_cache_invalidation(app_ids);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Statement-level trigger for manifest: one notification per statement (a
-- bundle upload inserts hundreds of manifest rows in one INSERT), resolving
-- affected apps through their bundles.
CREATE OR REPLACE FUNCTION public.invalidate_updates_cache_manifest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  app_ids text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT av.app_id::text) INTO app_ids
    FROM old_rows m
    JOIN public.app_versions av ON av.id = m.app_version_id;
  ELSE
    SELECT array_agg(DISTINCT av.app_id::text) INTO app_ids
    FROM new_rows m
    JOIN public.app_versions av ON av.id = m.app_version_id;
  END IF;

  PERFORM public.notify_updates_cache_invalidation(app_ids);
  RETURN NULL;
END;
$$;

-- channels: any change moves versions/flags devices resolve against.
CREATE OR REPLACE TRIGGER invalidate_updates_cache_channels
AFTER INSERT OR UPDATE OR DELETE ON public.channels
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

-- channel_devices: flips or edits per-device overrides; must react fast so
-- an app gaining its FIRST override switches off the cached no-override
-- fast path immediately (apps.channel_device_count is inside the cached
-- payload).
CREATE OR REPLACE TRIGGER invalidate_updates_cache_channel_devices
AFTER INSERT OR UPDATE OR DELETE ON public.channel_devices
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

-- apps: counters, plan/provider flags, metadata exposure. INSERT clears the
-- negative (unknown-app) cache entry the moment an app is created.
CREATE OR REPLACE TRIGGER invalidate_updates_cache_apps
AFTER INSERT OR UPDATE OR DELETE ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

-- app_versions: UPDATE only (r2_path/checksum/deleted change after a channel
-- may already point at the version; freshly inserted rows are not yet
-- referenced by any channel).
CREATE OR REPLACE TRIGGER invalidate_updates_cache_app_versions
AFTER UPDATE ON public.app_versions
FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
EXECUTE FUNCTION public.invalidate_updates_cache();

-- manifest: cached inside channel payloads and per-version entries; bundle
-- uploads insert many rows at once, so notify once per statement.
CREATE OR REPLACE TRIGGER invalidate_updates_cache_manifest_insert
AFTER INSERT ON public.manifest
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_manifest();

CREATE OR REPLACE TRIGGER invalidate_updates_cache_manifest_delete
AFTER DELETE ON public.manifest
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_manifest();

-- orgs: has_usage_credits / customer_id feed plan validation.
CREATE OR REPLACE TRIGGER invalidate_updates_cache_orgs
AFTER UPDATE ON public.orgs
FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
EXECUTE FUNCTION public.invalidate_updates_cache();

-- stripe_info: status / trial / exceeded flags feed plan validation.
CREATE OR REPLACE TRIGGER invalidate_updates_cache_stripe_info
AFTER INSERT OR UPDATE ON public.stripe_info
FOR EACH ROW EXECUTE FUNCTION public.invalidate_updates_cache();

REVOKE ALL ON FUNCTION public.invalidate_updates_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invalidate_updates_cache() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.invalidate_updates_cache_manifest() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invalidate_updates_cache_manifest() FROM anon, authenticated;
