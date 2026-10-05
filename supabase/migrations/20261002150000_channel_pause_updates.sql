-- Channel-level pause: while paused_at is set, /updates sends no new bundle on
-- this channel (devices keep the bundle they already run). Unlike reverting to
-- built-in, nothing is rolled back.
ALTER TABLE public.channels
  ADD COLUMN IF NOT EXISTS paused_at timestamp with time zone;

COMMENT ON COLUMN public.channels.paused_at IS
  'When set, the channel is paused: /updates answers channel_paused and devices keep their current bundle.';

ALTER TYPE public.stats_action ADD VALUE IF NOT EXISTS 'channelPaused';

-- Pausing or resuming must evict cached /updates answers for the app.
CREATE OR REPLACE FUNCTION public.invalidate_updates_edge_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  app_ids text[];
BEGIN
  IF NOT public.updates_cache_purge_enabled() THEN
    RETURN NULL;
  END IF;

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
               o.rollout_paused_at, o.rollout_pause_reason, o.rollout_cache_ttl_seconds, o.paused_at)
          IS DISTINCT FROM
              (n.app_id, n.name, n.version, n.public, n.allow_device_self_set, n.allow_emulator,
               n.allow_device, n.allow_dev, n.allow_prod, n.disable_auto_update_under_native,
               n.disable_auto_update, n.ios, n.android, n.electron, n.update_package,
               n.rollout_version, n.rollout_percentage_bps, n.rollout_enabled, n.rollout_id,
               n.rollout_paused_at, n.rollout_pause_reason, n.rollout_cache_ttl_seconds, n.paused_at)
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
    -- Only versions a channel serves (as version or rollout target) can be in
    -- the cache; channel changes that start serving a version purge on their
    -- own. This keeps uploads (manifest_count, storage_provider flips of
    -- unlinked bundles) from evicting the app's live entries.
    IF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO app_ids
      FROM old_rows o
      WHERE EXISTS (
        SELECT 1 FROM public.channels c WHERE c.version = o.id OR c.rollout_version = o.id
      );
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO app_ids
      FROM old_rows o JOIN new_rows n ON n.id = o.id
      WHERE EXISTS (
        SELECT 1 FROM public.channels c WHERE c.version = n.id OR c.rollout_version = n.id
      )
        AND (o.app_id, o.name, o.checksum, o.session_key, o.key_id, o.storage_provider, o.external_url,
             o.min_update_version, o.manifest_count, o.r2_path, o.deleted, o.deleted_at,
             o.link, o.comment)
        IS DISTINCT FROM
            (n.app_id, n.name, n.checksum, n.session_key, n.key_id, n.storage_provider, n.external_url,
             n.min_update_version, n.manifest_count, n.r2_path, n.deleted, n.deleted_at,
             n.link, n.comment);
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
