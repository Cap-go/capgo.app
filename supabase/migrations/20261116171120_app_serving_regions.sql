-- Settings describe plugin serving and regional metadata reads, never replication/storage.
CREATE OR REPLACE FUNCTION public.valid_serving_regions(regions text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT regions IS NOT NULL
    AND pg_catalog.array_ndims(regions) = 1
    AND pg_catalog.cardinality(regions) BETWEEN 1 AND 9
    AND regions <@ ARRAY['EU','NA','SA','OC','AS_INDIA','AS_JAPAN','HK','AF','ME']::text[]
    AND pg_catalog.array_position(regions, NULL) IS NULL
    AND pg_catalog.cardinality(regions) = (SELECT pg_catalog.count(DISTINCT r) FROM pg_catalog.unnest(regions) r);
$$;
ALTER FUNCTION public.valid_serving_regions(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.valid_serving_regions(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_serving_regions(text[]) TO anon, authenticated, service_role;

ALTER TABLE public.apps
  ADD COLUMN serving_regions text[] NOT NULL DEFAULT ARRAY['EU','NA','SA','OC','AS_INDIA','AS_JAPAN','HK','AF','ME']::text[],
  ADD COLUMN serving_region_mode text NOT NULL DEFAULT 'route',
  ADD CONSTRAINT apps_serving_regions_valid CHECK (public.valid_serving_regions(serving_regions)),
  ADD CONSTRAINT apps_serving_region_mode_valid CHECK (serving_region_mode IN ('route', 'block'));

COMMENT ON COLUMN public.apps.serving_regions IS 'Requested regional plugin metadata reads. Activated by strongly consistent serving-policy publication. Does not restrict global replication or bundle storage.';
COMMENT ON COLUMN public.apps.serving_region_mode IS 'route accepts all ingress regions; block rejects trusted ingress outside serving_regions. Requested settings remain pending until published.';

CREATE OR REPLACE FUNCTION public.enqueue_plugin_state_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_full_ids text[];
  v_app_ids text[];
  v_device_apps text[];
  v_device_refs text[];
  v_version_apps text[];
  v_version_refs text[];
  v_manifest_apps text[];
  v_manifest_refs text[];
BEGIN
  IF NOT public.plugin_state_sync_enabled() THEN
    IF TG_TABLE_NAME = 'apps' THEN
      IF TG_OP = 'INSERT' THEN
        SELECT pg_catalog.array_agg(n.app_id::text) INTO v_app_ids FROM new_rows n;
      ELSIF TG_OP = 'UPDATE' THEN
        SELECT pg_catalog.array_agg(n.app_id::text) INTO v_app_ids
        FROM old_rows o JOIN new_rows n ON n.app_id = o.app_id
        WHERE (o.serving_regions, o.serving_region_mode) IS DISTINCT FROM (n.serving_regions, n.serving_region_mode);
      END IF;
      IF v_app_ids IS NOT NULL THEN
        PERFORM public.notify_plugin_state_sync('app', v_app_ids);
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'apps' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO v_full_ids FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO v_app_ids FROM old_rows o;
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT changed.app_id) INTO v_app_ids
      FROM old_rows o JOIN new_rows n ON n.id = o.id
      CROSS JOIN LATERAL (VALUES (o.app_id::text), (n.app_id::text)) AS changed (app_id)
      WHERE (o.app_id, o.owner_org, o.channel_device_count, o.manifest_bundle_count, o.rollout_channel_count,
             o.rollout_paused_version_names, o.expose_metadata, o.allow_device_custom_id, o.serving_regions, o.serving_region_mode,
             o.block_provider_infra_requests, o.device_data_collection)
        IS DISTINCT FROM
            (n.app_id, n.owner_org, n.channel_device_count, n.manifest_bundle_count, n.rollout_channel_count,
             n.rollout_paused_version_names, n.expose_metadata, n.allow_device_custom_id, n.serving_regions, n.serving_region_mode,
             n.block_provider_infra_requests, n.device_data_collection);
    END IF;
  ELSIF TG_TABLE_NAME = 'channels' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO v_app_ids FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO v_app_ids FROM old_rows o;
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT changed.app_id) INTO v_app_ids
      FROM (
        SELECT o.app_id::text AS app_id, n.app_id::text AS new_app_id
        FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.app_id, o.name, o.version, o.public, o.allow_device_self_set, o.allow_emulator,
               o.allow_device, o.allow_dev, o.allow_prod, o.disable_auto_update_under_native,
               o.disable_auto_update, o.ios, o.android, o.electron, o.update_package,
               o.rollout_version, o.rollout_percentage_bps, o.rollout_enabled, o.rollout_id,
               o.rollout_paused_at, o.rollout_pause_reason, o.rollout_cache_ttl_seconds, o.paused_at,
               o.owner_org)
          IS DISTINCT FROM
              (n.app_id, n.name, n.version, n.public, n.allow_device_self_set, n.allow_emulator,
               n.allow_device, n.allow_dev, n.allow_prod, n.disable_auto_update_under_native,
               n.disable_auto_update, n.ios, n.android, n.electron, n.update_package,
               n.rollout_version, n.rollout_percentage_bps, n.rollout_enabled, n.rollout_id,
               n.rollout_paused_at, n.rollout_pause_reason, n.rollout_cache_ttl_seconds, n.paused_at,
               n.owner_org)
      ) AS moved
      CROSS JOIN LATERAL (VALUES (moved.app_id), (moved.new_app_id)) AS changed (app_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'app_versions' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(n.app_id::text), pg_catalog.array_agg(n.name::text)
      INTO v_version_apps, v_version_refs
      FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(o.app_id::text), pg_catalog.array_agg(o.name::text)
      INTO v_version_apps, v_version_refs
      FROM old_rows o;
      SELECT pg_catalog.array_agg(o.app_id::text), pg_catalog.array_agg(o.id::text)
      INTO v_manifest_apps, v_manifest_refs
      FROM old_rows o;
    ELSE
      -- Bundle-name lookups: identity, owner or deleted flag changed.
      SELECT pg_catalog.array_agg(named.app_id), pg_catalog.array_agg(named.name)
      INTO v_version_apps, v_version_refs
      FROM (
        SELECT o.app_id::text AS app_id, o.name::text AS name, n.app_id::text AS new_app_id, n.name::text AS new_name
        FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.app_id, o.name, o.owner_org, o.deleted) IS DISTINCT FROM (n.app_id, n.name, n.owner_org, n.deleted)
      ) AS renamed
      CROSS JOIN LATERAL (VALUES (renamed.app_id, renamed.name), (renamed.new_app_id, renamed.new_name)) AS named (app_id, name);
      -- Manifest documents carry the bundle's app and deleted flag.
      SELECT pg_catalog.array_agg(n.app_id::text), pg_catalog.array_agg(n.id::text)
      INTO v_manifest_apps, v_manifest_refs
      FROM old_rows o JOIN new_rows n ON n.id = o.id
      WHERE (o.app_id, o.deleted, o.manifest_count) IS DISTINCT FROM (n.app_id, n.deleted, n.manifest_count);
      -- App documents embed the bundles their channels serve.
      SELECT pg_catalog.array_agg(DISTINCT served.app_id) INTO v_app_ids
      FROM (
        SELECT o.app_id::text AS app_id, n.app_id::text AS new_app_id
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
               n.link, n.comment)
      ) AS changed
      CROSS JOIN LATERAL (VALUES (changed.app_id), (changed.new_app_id)) AS served (app_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'orgs' THEN
    SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO v_app_ids
    FROM old_rows o
    JOIN new_rows n ON n.id = o.id
    JOIN public.apps a ON a.owner_org = n.id
    WHERE (o.customer_id, o.has_usage_credits, o.management_email, o.created_by)
      IS DISTINCT FROM
          (n.customer_id, n.has_usage_credits, n.management_email, n.created_by);
  ELSIF TG_TABLE_NAME = 'stripe_info' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO v_app_ids
      FROM new_rows s
      JOIN public.orgs org ON org.customer_id = s.customer_id
      JOIN public.apps a ON a.owner_org = org.id;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO v_app_ids
      FROM old_rows s
      JOIN public.orgs org ON org.customer_id = s.customer_id
      JOIN public.apps a ON a.owner_org = org.id;
    ELSE
      SELECT pg_catalog.array_agg(DISTINCT a.app_id::text) INTO v_app_ids
      FROM (
        SELECT o.customer_id AS old_customer_id, n.customer_id AS new_customer_id
        FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.customer_id, o.status, o.trial_at, o.mau_exceeded, o.bandwidth_exceeded, o.storage_exceeded)
          IS DISTINCT FROM
              (n.customer_id, n.status, n.trial_at, n.mau_exceeded, n.bandwidth_exceeded, n.storage_exceeded)
      ) AS changed
      CROSS JOIN LATERAL (VALUES (changed.old_customer_id), (changed.new_customer_id)) AS customers (customer_id)
      JOIN public.orgs org ON org.customer_id = customers.customer_id
      JOIN public.apps a ON a.owner_org = org.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'channel_devices' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(n.app_id::text), pg_catalog.array_agg(n.device_id::text)
      INTO v_device_apps, v_device_refs
      FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(o.app_id::text), pg_catalog.array_agg(o.device_id::text)
      INTO v_device_apps, v_device_refs
      FROM old_rows o;
    ELSE
      SELECT pg_catalog.array_agg(devices.app_id), pg_catalog.array_agg(devices.device_id)
      INTO v_device_apps, v_device_refs
      FROM (
        SELECT o.app_id::text AS app_id, o.device_id::text AS device_id, n.app_id::text AS new_app_id, n.device_id::text AS new_device_id
        FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.app_id, o.device_id, o.channel_id) IS DISTINCT FROM (n.app_id, n.device_id, n.channel_id)
      ) AS changed
      CROSS JOIN LATERAL (VALUES (changed.app_id, changed.device_id), (changed.new_app_id, changed.new_device_id)) AS devices (app_id, device_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'version_files' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(av.app_id::text), pg_catalog.array_agg(o.app_version_id::text)
      INTO v_manifest_apps, v_manifest_refs
      FROM old_rows o JOIN public.app_versions av ON av.id = o.app_version_id;
    ELSIF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(av.app_id::text), pg_catalog.array_agg(n.app_version_id::text)
      INTO v_manifest_apps, v_manifest_refs
      FROM new_rows n JOIN public.app_versions av ON av.id = n.app_version_id;
    ELSE
      SELECT pg_catalog.array_agg(av.app_id::text), pg_catalog.array_agg(av.id::text)
      INTO v_manifest_apps, v_manifest_refs
      FROM (SELECT app_version_id FROM old_rows UNION SELECT app_version_id FROM new_rows) changed
      JOIN public.app_versions av ON av.id = changed.app_version_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'delta_files' THEN
    -- Entries can be shared by different apps. Resolve their actual owning
    -- manifests through the GIN index, never through delta_files.app_id.
    -- Maintenance writers must batch their updates, as for the write itself;
    -- large statements must not silently skip invalidating live manifests.
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(av.app_id::text), pg_catalog.array_agg(av.id::text)
      INTO v_manifest_apps, v_manifest_refs
      FROM public.version_files vf
      JOIN public.app_versions av ON av.id = vf.app_version_id
      WHERE vf.file_ids && (SELECT pg_catalog.array_agg(n.id) FROM new_rows n);
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(av.app_id::text), pg_catalog.array_agg(av.id::text)
      INTO v_manifest_apps, v_manifest_refs
      FROM public.version_files vf
      JOIN public.app_versions av ON av.id = vf.app_version_id
      WHERE vf.file_ids && (SELECT pg_catalog.array_agg(o.id) FROM old_rows o);
    ELSE
      SELECT pg_catalog.array_agg(av.app_id::text), pg_catalog.array_agg(av.id::text)
      INTO v_manifest_apps, v_manifest_refs
      FROM public.version_files vf
      JOIN public.app_versions av ON av.id = vf.app_version_id
      WHERE vf.file_ids && (
        SELECT pg_catalog.array_agg(n.id)
        FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.file_size, o.s3_path, o.file_name, o.file_hash, o.path_org, o.path_session, o.path_sha,
               o.file_hash_bin, o.path_session_id)
          IS DISTINCT FROM
              (n.file_size, n.s3_path, n.file_name, n.file_hash, n.path_org, n.path_session, n.path_sha,
               n.file_hash_bin, n.path_session_id)
      );
    END IF;
  END IF;

  IF v_full_ids IS NOT NULL THEN
    PERFORM public.notify_plugin_state_sync('full', v_full_ids);
  END IF;
  IF v_app_ids IS NOT NULL THEN
    PERFORM public.notify_plugin_state_sync('app', v_app_ids);
  END IF;
  IF v_device_apps IS NOT NULL THEN
    PERFORM public.notify_plugin_state_sync('device', v_device_apps, v_device_refs);
  END IF;
  IF v_version_apps IS NOT NULL THEN
    PERFORM public.notify_plugin_state_sync('version', v_version_apps, v_version_refs);
  END IF;
  IF v_manifest_apps IS NOT NULL THEN
    PERFORM public.notify_plugin_state_sync('manifest', v_manifest_apps, v_manifest_refs);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'enqueue_plugin_state_sync failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."invalidate_updates_edge_cache"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  app_ids text[];
  version_app_ids text[];
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
               o.rollout_paused_at, o.rollout_pause_reason, o.rollout_cache_ttl_seconds, o.paused_at,
               o.owner_org)
          IS DISTINCT FROM
              (n.app_id, n.name, n.version, n.public, n.allow_device_self_set, n.allow_emulator,
               n.allow_device, n.allow_dev, n.allow_prod, n.disable_auto_update_under_native,
               n.disable_auto_update, n.ios, n.android, n.electron, n.update_package,
               n.rollout_version, n.rollout_percentage_bps, n.rollout_enabled, n.rollout_id,
               n.rollout_paused_at, n.rollout_pause_reason, n.rollout_cache_ttl_seconds, n.paused_at,
               n.owner_org)
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
      WHERE (o.owner_org, o.expose_metadata, o.allow_device_custom_id, o.serving_regions, o.serving_region_mode, o.block_provider_infra_requests,
             o.rollout_paused_version_names,
             COALESCE(o.channel_device_count, 0) > 0, COALESCE(o.manifest_bundle_count, 0) > 0,
             COALESCE(o.rollout_channel_count, 0) > 0)
        IS DISTINCT FROM
            (n.owner_org, n.expose_metadata, n.allow_device_custom_id, n.serving_regions, n.serving_region_mode, n.block_provider_infra_requests,
             n.rollout_paused_version_names,
             COALESCE(n.channel_device_count, 0) > 0, COALESCE(n.manifest_bundle_count, 0) > 0,
             COALESCE(n.rollout_channel_count, 0) > 0);
    END IF;
  ELSIF TG_TABLE_NAME = 'app_versions' THEN
    -- Main tag: only versions a channel serves (as version or rollout target)
    -- can be in the /updates entries; channel changes that start serving a
    -- version purge on their own. This keeps uploads (manifest_count,
    -- storage_provider flips of unlinked bundles) from evicting the app's live
    -- entries.
    -- Versions tag: bundle-name lookups (id + owner_org by name, deleted rows
    -- included) change on any insert, delete, rename, move or soft delete,
    -- whether or not a channel serves the version.
    IF TG_OP = 'INSERT' THEN
      SELECT pg_catalog.array_agg(DISTINCT n.app_id::text) INTO version_app_ids FROM new_rows n;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO app_ids
      FROM old_rows o
      WHERE EXISTS (
        SELECT 1 FROM public.channels c WHERE c.version = o.id OR c.rollout_version = o.id
      );
      SELECT pg_catalog.array_agg(DISTINCT o.app_id::text) INTO version_app_ids FROM old_rows o;
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
      SELECT pg_catalog.array_agg(DISTINCT changed.app_id) INTO version_app_ids
      FROM (
        SELECT n.app_id::text AS app_id FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE (o.app_id, o.name, o.owner_org, o.deleted)
          IS DISTINCT FROM (n.app_id, n.name, n.owner_org, n.deleted)
        UNION
        SELECT o.app_id::text FROM old_rows o JOIN new_rows n ON n.id = o.id
        WHERE o.app_id IS DISTINCT FROM n.app_id
      ) AS changed;
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
      -- storage_exceeded is left out on purpose: plugin plan checks only use
      -- the mau and bandwidth actions (see buildPlanValidationExpression).
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
    PERFORM public.notify_updates_edge_cache_purge(app_ids, 'app');
  END IF;
  IF version_app_ids IS NOT NULL THEN
    PERFORM public.notify_updates_edge_cache_purge(version_app_ids, 'versions');
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'invalidate_updates_edge_cache failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$$;
