-- Purge the /updates edge cache when data it serves changes.
--
-- The plugin worker caches app-level /updates reads (app owner + plan, default
-- channel row, manifest rows) in the Cloudflare Cache API with one Cache-Tag
-- per app. These statement-level triggers collect the app ids whose served
-- data changed and POST them (pg_net, async, after commit) to
-- triggers/updates_cache_purge, which purges the tags in every Cloudflare data
-- center. Nothing here can fail or slow down the write: every error is
-- swallowed and the cache TTL is the backstop.
--
-- Only columns the update path reads are compared, so background writes
-- (stats refresh, audit bookkeeping, auto-pause checks, per-device override
-- counter churn) do not purge anything.

CREATE OR REPLACE FUNCTION public.notify_updates_edge_cache_purge(p_app_ids text[])
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
  SELECT pg_catalog.array_agg(DISTINCT app_id) INTO deduped
  FROM pg_catalog.unnest(p_app_ids) AS app_id
  WHERE app_id IS NOT NULL AND app_id <> '';

  IF deduped IS NULL THEN
    RETURN;
  END IF;
  -- Beyond the cap the TTL backstop takes over for the tail.
  deduped := deduped[1:max_apps];

  i := 1;
  WHILE i <= pg_catalog.array_length(deduped, 1) LOOP
    chunk := deduped[i:i + chunk_size - 1];
    PERFORM net.http_post(
      url := public.get_db_url() || '/functions/v1/triggers/updates_cache_purge',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'apisecret', public.get_apikey()
      ),
      body := pg_catalog.jsonb_build_object('app_ids', pg_catalog.to_jsonb(chunk)),
      timeout_milliseconds := 5000
    );
    i := i + chunk_size;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- Cache purge is an accelerator; never fail the business write.
  RAISE WARNING 'notify_updates_edge_cache_purge failed: %', SQLERRM;
END;
$$;

ALTER FUNCTION public.notify_updates_edge_cache_purge(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_updates_edge_cache_purge(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_updates_edge_cache_purge(text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_updates_edge_cache_purge(text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.invalidate_updates_edge_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  app_ids text[];
BEGIN
  IF TG_TABLE_NAME = 'channels' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO app_ids FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO app_ids FROM old_rows o;
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT changed.app_id) INTO app_ids
      FROM (
        SELECT o.app_id::text AS app_id FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.app_id, o.name, o.version, o.public, o.allow_device_self_set, o.allow_emulator,
               o.allow_device, o.allow_dev, o.allow_prod, o.disable_auto_update_under_native,
               o.disable_auto_update, o.ios, o.android, o.electron, o.update_package,
               o.rollout_version, o.rollout_percentage_bps, o.rollout_enabled, o.rollout_id,
               o.rollout_paused_at, o.rollout_pause_reason, o.rollout_cache_ttl_seconds)
          IS DISTINCT FROM
              (n.app_id, n.name, n.version, n.public, n.allow_device_self_set, n.allow_emulator,
               n.allow_device, n.allow_dev, n.allow_prod, n.disable_auto_update_under_native,
               n.disable_auto_update, n.ios, n.android, n.electron, n.update_package,
               n.rollout_version, n.rollout_percentage_bps, n.rollout_enabled, n.rollout_id,
               n.rollout_paused_at, n.rollout_pause_reason, n.rollout_cache_ttl_seconds)
        UNION
        SELECT n.app_id::text FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE o.app_id IS DISTINCT FROM n.app_id
      ) AS changed;
    END IF;
  ELSIF TG_TABLE_NAME = 'apps' THEN
    IF TG_OP = 'INSERT' THEN
      -- Clears the cached "unknown app" answer.
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO app_ids FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO app_ids FROM old_rows o;
    ELSE
      -- Counters only gate code paths (> 0), so only zero crossings matter.
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO app_ids
      FROM old_rows o JOIN new_rows n ON n.app_id = o.app_id
      WHERE (o.owner_org, o.expose_metadata, o.allow_device_custom_id, o.block_provider_infra_requests,
             o.rollout_paused_version_names,
             COALESCE(o.channel_device_count, 0) > 0, COALESCE(o.manifest_bundle_count, 0) > 0,
             COALESCE(o.rollout_channel_count, 0) > 0)
        IS DISTINCT FROM
            (n.owner_org, n.expose_metadata, n.allow_device_custom_id, n.block_provider_infra_requests,
             n.rollout_paused_version_names,
             COALESCE(n.channel_device_count, 0) > 0, COALESCE(n.manifest_bundle_count, 0) > 0,
             COALESCE(n.rollout_channel_count, 0) > 0);
    END IF;
  ELSIF TG_TABLE_NAME = 'app_versions' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO app_ids FROM old_rows o;
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO app_ids
      FROM old_rows o JOIN new_rows n ON n.id = o.id
      WHERE (o.name, o.checksum, o.session_key, o.key_id, o.storage_provider, o.external_url,
             o.min_update_version, o.manifest_count, o.r2_path, o.deleted, o.deleted_at,
             o.link, o.comment)
        IS DISTINCT FROM
            (n.name, n.checksum, n.session_key, n.key_id, n.storage_provider, n.external_url,
             n.min_update_version, n.manifest_count, n.r2_path, n.deleted, n.deleted_at,
             n.link, n.comment);
    END IF;
  ELSIF TG_TABLE_NAME = 'manifest' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT av.app_id::text) INTO app_ids
      FROM (SELECT DISTINCT app_version_id FROM old_rows) AS m
      JOIN public.app_versions av ON av.id = m.app_version_id;
    ELSIF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT av.app_id::text) INTO app_ids
      FROM (SELECT DISTINCT app_version_id FROM new_rows) AS m
      JOIN public.app_versions av ON av.id = m.app_version_id;
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT av.app_id::text) INTO app_ids
      FROM (
        SELECT app_version_id FROM old_rows
        UNION
        SELECT app_version_id FROM new_rows
      ) AS m
      JOIN public.app_versions av ON av.id = m.app_version_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'orgs' THEN
    SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO app_ids
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    JOIN public.apps a ON a.owner_org = n.id
    WHERE (o.customer_id, o.has_usage_credits, o.management_email, o.created_by)
      IS DISTINCT FROM
          (n.customer_id, n.has_usage_credits, n.management_email, n.created_by);
  ELSIF TG_TABLE_NAME = 'stripe_info' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO app_ids
      FROM new_rows s
      JOIN public.orgs org ON org.customer_id = s.customer_id
      JOIN public.apps a ON a.owner_org = org.id;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO app_ids
      FROM old_rows s
      JOIN public.orgs org ON org.customer_id = s.customer_id
      JOIN public.apps a ON a.owner_org = org.id;
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO app_ids
      FROM old_rows o
      JOIN new_rows n ON n.customer_id = o.customer_id
      JOIN public.orgs org ON org.customer_id = n.customer_id
      JOIN public.apps a ON a.owner_org = org.id
      WHERE (o.status, o.trial_at, o.mau_exceeded, o.bandwidth_exceeded)
        IS DISTINCT FROM
            (n.status, n.trial_at, n.mau_exceeded, n.bandwidth_exceeded);
    END IF;
  END IF;

  IF app_ids IS NOT NULL THEN
    PERFORM public.notify_updates_edge_cache_purge(app_ids);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'invalidate_updates_edge_cache failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.invalidate_updates_edge_cache() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invalidate_updates_edge_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invalidate_updates_edge_cache() FROM anon, authenticated;

COMMENT ON FUNCTION public.invalidate_updates_edge_cache() IS
  'Statement-level AFTER trigger: collects app ids whose /updates answer may '
  'have changed and asks triggers/updates_cache_purge to purge their Cloudflare '
  'Cache-Tag. Runs once per statement over transition tables; lookups use '
  'app_versions_pkey, idx_orgs_customer_id and finx_apps_owner_org.';

-- channels
CREATE TRIGGER invalidate_updates_edge_cache_channels_ins
AFTER INSERT ON public.channels REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
CREATE TRIGGER invalidate_updates_edge_cache_channels_upd
AFTER UPDATE ON public.channels REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
CREATE TRIGGER invalidate_updates_edge_cache_channels_del
AFTER DELETE ON public.channels REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();

-- apps
CREATE TRIGGER invalidate_updates_edge_cache_apps_ins
AFTER INSERT ON public.apps REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
CREATE TRIGGER invalidate_updates_edge_cache_apps_upd
AFTER UPDATE ON public.apps REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
CREATE TRIGGER invalidate_updates_edge_cache_apps_del
AFTER DELETE ON public.apps REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();

-- app_versions (a new row is not served until a channel points at it)
CREATE TRIGGER invalidate_updates_edge_cache_app_versions_upd
AFTER UPDATE ON public.app_versions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
CREATE TRIGGER invalidate_updates_edge_cache_app_versions_del
AFTER DELETE ON public.app_versions REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();

-- manifest (bundle uploads insert many rows in one statement)
CREATE TRIGGER invalidate_updates_edge_cache_manifest_ins
AFTER INSERT ON public.manifest REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
CREATE TRIGGER invalidate_updates_edge_cache_manifest_upd
AFTER UPDATE ON public.manifest REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
CREATE TRIGGER invalidate_updates_edge_cache_manifest_del
AFTER DELETE ON public.manifest REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();

-- orgs (plan validation inputs)
CREATE TRIGGER invalidate_updates_edge_cache_orgs_upd
AFTER UPDATE ON public.orgs REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();

-- stripe_info (plan validation inputs)
CREATE TRIGGER invalidate_updates_edge_cache_stripe_info_ins
AFTER INSERT ON public.stripe_info REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
CREATE TRIGGER invalidate_updates_edge_cache_stripe_info_upd
AFTER UPDATE ON public.stripe_info REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
CREATE TRIGGER invalidate_updates_edge_cache_stripe_info_del
AFTER DELETE ON public.stripe_info REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
