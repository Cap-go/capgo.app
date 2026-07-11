-- Targeted invalidation for the /updates colo cache
-- (see supabase/functions/_backend/utils/updates_colo_cache.ts).
--
-- Whenever rows that feed the update hot path change, notify the
-- triggers/cache_invalidate function (via pg_net, async) which fans the
-- per-app token bump out to every regional plugin worker. The cache TTL
-- remains the backstop if a call is lost.
--
-- All triggers are STATEMENT-level with transition tables: bulk writes
-- (daily channel_devices cleanup, bundle uploads inserting hundreds of
-- manifest rows, org-wide backfills) produce ONE aggregated, deduplicated
-- notification per statement instead of one per row.

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
-- never be RPC-callable by API roles.
REVOKE ALL ON FUNCTION public.notify_updates_cache_invalidation(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_updates_cache_invalidation(text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_updates_cache_invalidation(text[]) TO service_role;

-- Drop the previous row-level implementation (and its triggers) if present.
DROP FUNCTION IF EXISTS public.invalidate_updates_cache() CASCADE;
DROP FUNCTION IF EXISTS public.invalidate_updates_cache_manifest() CASCADE;

-- One statement-level trigger function for every replicated-read table.
-- Transition tables are exposed as new_rows / old_rows depending on TG_OP.
CREATE OR REPLACE FUNCTION public.invalidate_updates_cache_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  app_ids text[];
BEGIN
  IF TG_TABLE_NAME IN ('channels', 'channel_devices', 'apps', 'app_versions') THEN
    IF TG_OP = 'DELETE' THEN
      SELECT array_agg(DISTINCT r.app_id::text) INTO app_ids FROM old_rows r;
    ELSE
      SELECT array_agg(DISTINCT r.app_id::text) INTO app_ids FROM new_rows r;
    END IF;
  ELSIF TG_TABLE_NAME = 'orgs' THEN
    SELECT array_agg(DISTINCT a.app_id::text) INTO app_ids
    FROM new_rows o
    JOIN public.apps a ON a.owner_org = o.id;
  ELSIF TG_TABLE_NAME = 'stripe_info' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT array_agg(DISTINCT a.app_id::text) INTO app_ids
      FROM old_rows s
      JOIN public.orgs o ON o.customer_id = s.customer_id
      JOIN public.apps a ON a.owner_org = o.id;
    ELSE
      SELECT array_agg(DISTINCT a.app_id::text) INTO app_ids
      FROM new_rows s
      JOIN public.orgs o ON o.customer_id = s.customer_id
      JOIN public.apps a ON a.owner_org = o.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'manifest' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT array_agg(DISTINCT av.app_id::text) INTO app_ids
      FROM old_rows m
      JOIN public.app_versions av ON av.id = m.app_version_id;
    ELSE
      SELECT array_agg(DISTINCT av.app_id::text) INTO app_ids
      FROM new_rows m
      JOIN public.app_versions av ON av.id = m.app_version_id;
    END IF;
  END IF;

  PERFORM public.notify_updates_cache_invalidation(app_ids);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_updates_cache_stmt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invalidate_updates_cache_stmt() FROM anon, authenticated;

-- channels: any change moves versions/flags devices resolve against.
DROP TRIGGER IF EXISTS invalidate_updates_cache_channels_ins ON public.channels;
CREATE TRIGGER invalidate_updates_cache_channels_ins
AFTER INSERT ON public.channels
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

DROP TRIGGER IF EXISTS invalidate_updates_cache_channels_upd ON public.channels;
CREATE TRIGGER invalidate_updates_cache_channels_upd
AFTER UPDATE ON public.channels
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

DROP TRIGGER IF EXISTS invalidate_updates_cache_channels_del ON public.channels;
CREATE TRIGGER invalidate_updates_cache_channels_del
AFTER DELETE ON public.channels
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

-- channel_devices: per-device overrides; bulk daily cleanups delete
-- thousands of rows in one statement and must cost one notification.
DROP TRIGGER IF EXISTS invalidate_updates_cache_channel_devices_ins ON public.channel_devices;
CREATE TRIGGER invalidate_updates_cache_channel_devices_ins
AFTER INSERT ON public.channel_devices
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

DROP TRIGGER IF EXISTS invalidate_updates_cache_channel_devices_upd ON public.channel_devices;
CREATE TRIGGER invalidate_updates_cache_channel_devices_upd
AFTER UPDATE ON public.channel_devices
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

DROP TRIGGER IF EXISTS invalidate_updates_cache_channel_devices_del ON public.channel_devices;
CREATE TRIGGER invalidate_updates_cache_channel_devices_del
AFTER DELETE ON public.channel_devices
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

-- apps: counters, plan/provider flags, metadata exposure. INSERT clears the
-- negative (unknown-app) cache entry the moment an app is created.
DROP TRIGGER IF EXISTS invalidate_updates_cache_apps_ins ON public.apps;
CREATE TRIGGER invalidate_updates_cache_apps_ins
AFTER INSERT ON public.apps
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

DROP TRIGGER IF EXISTS invalidate_updates_cache_apps_upd ON public.apps;
CREATE TRIGGER invalidate_updates_cache_apps_upd
AFTER UPDATE ON public.apps
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

DROP TRIGGER IF EXISTS invalidate_updates_cache_apps_del ON public.apps;
CREATE TRIGGER invalidate_updates_cache_apps_del
AFTER DELETE ON public.apps
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

-- app_versions: UPDATE only (r2_path/checksum/deleted change after a channel
-- may already point at the version; freshly inserted rows are not yet
-- referenced by any channel).
DROP TRIGGER IF EXISTS invalidate_updates_cache_app_versions_upd ON public.app_versions;
CREATE TRIGGER invalidate_updates_cache_app_versions_upd
AFTER UPDATE ON public.app_versions
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

-- manifest: cached inside channel payloads and per-version entries; bundle
-- uploads insert many rows at once.
DROP TRIGGER IF EXISTS invalidate_updates_cache_manifest_insert ON public.manifest;
CREATE TRIGGER invalidate_updates_cache_manifest_insert
AFTER INSERT ON public.manifest
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

DROP TRIGGER IF EXISTS invalidate_updates_cache_manifest_delete ON public.manifest;
CREATE TRIGGER invalidate_updates_cache_manifest_delete
AFTER DELETE ON public.manifest
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

-- orgs: has_usage_credits / customer_id feed plan validation.
DROP TRIGGER IF EXISTS invalidate_updates_cache_orgs_upd ON public.orgs;
CREATE TRIGGER invalidate_updates_cache_orgs_upd
AFTER UPDATE ON public.orgs
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

-- stripe_info: status / trial / exceeded flags feed plan validation; DELETE
-- included (orphaned-row cleanup must not leave plan_valid cached wrong).
DROP TRIGGER IF EXISTS invalidate_updates_cache_stripe_info_ins ON public.stripe_info;
CREATE TRIGGER invalidate_updates_cache_stripe_info_ins
AFTER INSERT ON public.stripe_info
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

DROP TRIGGER IF EXISTS invalidate_updates_cache_stripe_info_upd ON public.stripe_info;
CREATE TRIGGER invalidate_updates_cache_stripe_info_upd
AFTER UPDATE ON public.stripe_info
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();

DROP TRIGGER IF EXISTS invalidate_updates_cache_stripe_info_del ON public.stripe_info;
CREATE TRIGGER invalidate_updates_cache_stripe_info_del
AFTER DELETE ON public.stripe_info
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_cache_stmt();
