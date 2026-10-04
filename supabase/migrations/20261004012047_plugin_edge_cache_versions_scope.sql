-- Plugin edge cache: second purge scope for bundle-name lookups.
--
-- /stats (and later other plugin endpoints) cache "version by name" lookups
-- per app (app_versions id + owner_org by (app_id, name), negative results
-- included). Those entries must be purged on every app_versions INSERT /
-- DELETE / rename, whether or not a channel serves the version. Purging the
-- app's main tag for that would bring back the upload churn the
-- channel-served gate avoids (every upload would evict the app's /updates
-- entries), so version lookups carry a second tag per app
-- (capgo-updates-<app>:versions) and the purge queue says which tag to purge:
--   scope = 'app'      -> capgo-updates-<app>           (unchanged rules)
--   scope = 'versions' -> capgo-updates-<app>:versions  (any version identity change)
--
-- Also adds channels.owner_org to the compared channel columns: channel
-- lookups cached for /channel_self return it (legacy override writes use it).
--
-- Rolling deploy: a worker that predates this migration ignores `scope` and
-- purges the main tag for a versions row (an over-purge); a worker deployed
-- before this migration sees no `scope` and treats every row as 'app'.

ALTER TABLE public.updates_cache_purge_pending
  ADD COLUMN scope text NOT NULL DEFAULT 'app'
  CONSTRAINT updates_cache_purge_pending_scope_check CHECK (scope IN ('app', 'versions'));

-- Claims (leases) up to p_limit due (app, scope) pairs in the endpoint's own
-- transaction. Returns {status: busy|throttled|empty|ok, wait_ms?,
-- lease_token?, apps?: [{app_id, scope, initial}], has_more?}.
CREATE OR REPLACE FUNCTION public.claim_updates_cache_purge(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_last timestamptz;
  v_min_interval constant interval := '1 second';
  v_lease interval := '2 minutes';
  v_token uuid := gen_random_uuid();
  v_apps jsonb;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('updates_cache_purge_claim')) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'busy');
  END IF;

  SELECT last_claim_at INTO v_last FROM public.updates_cache_purge_state WHERE id;
  IF v_last > v_now - v_min_interval THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'throttled',
      'wait_ms', CEIL(EXTRACT(EPOCH FROM (v_last + v_min_interval - v_now)) * 1000)::int
    );
  END IF;

  -- One (app, scope) pair = one Cloudflare tag.
  WITH picked AS (
    SELECT p.app_id, p.scope
    FROM public.updates_cache_purge_pending p
    WHERE p.due_at <= v_now AND (p.lease_token IS NULL OR p.leased_until <= v_now)
    GROUP BY p.app_id, p.scope
    ORDER BY MIN(p.due_at)
    LIMIT GREATEST(LEAST(p_limit, 1000), 1)
  ),
  claimed AS (
    UPDATE public.updates_cache_purge_pending p
    SET lease_token = v_token, leased_until = v_now + v_lease
    FROM picked
    WHERE p.app_id = picked.app_id
      AND p.scope = picked.scope
      AND p.due_at <= v_now
      AND (p.lease_token IS NULL OR p.leased_until <= v_now)
    RETURNING p.app_id, p.scope, p.initial
  )
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('app_id', c.app_id, 'scope', c.scope, 'initial', c.initial))
  INTO v_apps
  FROM (SELECT app_id, scope, bool_or(initial) AS initial FROM claimed GROUP BY app_id, scope) AS c;

  IF v_apps IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'empty');
  END IF;

  UPDATE public.updates_cache_purge_state SET last_claim_at = v_now WHERE id;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'lease_token', v_token,
    'apps', v_apps,
    'has_more', EXISTS (
      SELECT 1 FROM public.updates_cache_purge_pending
      WHERE due_at <= v_now AND (lease_token IS NULL OR leased_until <= v_now)
    )
  );
END;
$$;

ALTER FUNCTION public.claim_updates_cache_purge(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_updates_cache_purge(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_updates_cache_purge(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_updates_cache_purge(integer) TO service_role;

-- Settles a lease. Success: delete the leased rows and schedule re-purges
-- (+10s / +60s / +180s from now, same scope) for the pairs whose first purge
-- this was. Failure: release the rows, due again after the Retry-After.
CREATE OR REPLACE FUNCTION public.ack_updates_cache_purge(
  p_lease_token uuid,
  p_success boolean,
  p_retry_after_seconds integer DEFAULT 5
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_success THEN
    WITH done AS (
      DELETE FROM public.updates_cache_purge_pending
      WHERE lease_token = p_lease_token
      RETURNING app_id, scope, initial
    )
    INSERT INTO public.updates_cache_purge_pending (app_id, scope, due_at, initial)
    SELECT pairs.app_id, pairs.scope, v_now + delays.delay, false
    FROM (SELECT DISTINCT app_id, scope FROM done WHERE initial) AS pairs
    CROSS JOIN (VALUES
      (interval '10 seconds'), (interval '60 seconds'), (interval '180 seconds')
    ) AS delays (delay);
  ELSE
    UPDATE public.updates_cache_purge_pending
    SET lease_token = NULL,
        leased_until = NULL,
        due_at = v_now + pg_catalog.make_interval(secs => GREATEST(LEAST(p_retry_after_seconds, 300), 1))
    WHERE lease_token = p_lease_token;
  END IF;
END;
$$;

ALTER FUNCTION public.ack_updates_cache_purge(uuid, boolean, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ack_updates_cache_purge(uuid, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ack_updates_cache_purge(uuid, boolean, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ack_updates_cache_purge(uuid, boolean, integer) TO service_role;

-- Trigger side: record the change (non-blocking insert) and queue a wake.
CREATE OR REPLACE FUNCTION public.notify_updates_edge_cache_purge(p_app_ids text[], p_scope text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.updates_cache_purge_pending (app_id, scope, due_at, initial)
  SELECT app_id, COALESCE(p_scope, 'app'), pg_catalog.clock_timestamp(), true
  FROM (
    SELECT DISTINCT app_id FROM pg_catalog.unnest(p_app_ids) AS app_id
    WHERE app_id IS NOT NULL AND app_id <> ''
  ) AS apps;

  -- One wake per transaction (an app delete cascades to several statements).
  IF pg_catalog.current_setting('capgo.updates_cache_wake_sent', true) IS DISTINCT FROM 'on' THEN
    PERFORM pg_catalog.set_config('capgo.updates_cache_wake_sent', 'on', true);
    PERFORM public.wake_updates_cache_purge();
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Cache purge is an accelerator; never fail the business write.
  RAISE WARNING 'notify_updates_edge_cache_purge failed: %', SQLERRM;
END;
$$;

ALTER FUNCTION public.notify_updates_edge_cache_purge(text[], text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_updates_edge_cache_purge(text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_updates_edge_cache_purge(text[], text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_updates_edge_cache_purge(text[], text) TO service_role;

CREATE OR REPLACE FUNCTION public.invalidate_updates_edge_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
               o.rollout_paused_at, o.rollout_pause_reason, o.rollout_cache_ttl_seconds,
               o.owner_org)
          IS DISTINCT FROM
              (n.app_id, n.name, n.version, n.public, n.allow_device_self_set, n.allow_emulator,
               n.allow_device, n.allow_dev, n.allow_prod, n.disable_auto_update_under_native,
               n.disable_auto_update, n.ios, n.android, n.electron, n.update_package,
               n.rollout_version, n.rollout_percentage_bps, n.rollout_enabled, n.rollout_id,
               n.rollout_paused_at, n.rollout_pause_reason, n.rollout_cache_ttl_seconds,
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

ALTER FUNCTION public.invalidate_updates_edge_cache() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invalidate_updates_edge_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invalidate_updates_edge_cache() FROM anon, authenticated;

COMMENT ON FUNCTION public.invalidate_updates_edge_cache() IS
  'Statement-level AFTER trigger: collects app ids whose plugin edge cache '
  'entries may have changed and asks triggers/updates_cache_purge to purge '
  'their Cloudflare Cache-Tag (scope app: /updates, owner and channel lookups; '
  'scope versions: bundle-name lookups). Runs once per statement over '
  'transition tables; lookups use finx_channels_version, '
  'idx_channels_rollout_version, idx_orgs_customer_id and finx_apps_owner_org.';

-- The trigger function now calls the two-argument form only.
DROP FUNCTION IF EXISTS public.notify_updates_edge_cache_purge(text[]);

-- app_versions INSERT: a new bundle clears cached "unknown version" answers
-- (versions tag only; it is not served until a channel points at it).
CREATE TRIGGER invalidate_updates_edge_cache_app_versions_ins
AFTER INSERT ON public.app_versions REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_updates_edge_cache();
