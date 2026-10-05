-- Purge the /updates edge cache when data it serves changes.
--
-- The plugin worker caches app-level /updates reads (app owner + plan, default
-- channel row, manifest rows) in the Cloudflare Cache API with one Cache-Tag
-- per app. Statement-level triggers collect the app ids whose served data
-- changed; triggers/updates_cache_purge purges their tags in every Cloudflare
-- data center (zone purge-by-tag).
--
-- The write path never waits and never drains shared work:
-- - triggers only INSERT rows (identity key, no unique constraint, so no
--   writer can block on another writer's uncommitted row) and queue a pg_net
--   wake, which is sent after commit;
-- - the endpoint claims due apps in its own short transaction through
--   claim_updates_cache_purge(): at most 100 apps per claim and one claim per
--   second (advisory lock + last_claim_at), i.e. about one Cloudflare call per
--   zone per second whatever the backlog. A claim leases rows (2 minutes)
--   instead of deleting them, so a crash before the ack loses nothing;
-- - after a purge, ack_updates_cache_purge() deletes the leased rows and
--   schedules the re-purges at
--   +10s / +60s / +180s from that moment (after commit, so a long transaction
--   cannot collapse them; they cover a request that refilled the cache from a
--   lagging read replica, 180s being the replica-lag alert threshold), or on
--   failure releases them at their Retry-After;
-- - the 10s cron tick wakes the endpoint while due rows remain.
--
-- Only columns the update path reads are compared, so background writes
-- (stats refresh, audit bookkeeping, auto-pause checks, per-device override
-- counter churn, manifest uploads of versions no channel serves) do not purge
-- anything. Nothing here can fail the business write: every error is swallowed
-- and the cache TTL is the backstop.
--
-- Runtime switch: Vault secret CAPGO_UPDATES_CACHE_PURGE_ENABLED = 'true'.

-- Logged so scheduled purges survive a crash restart; not in the read-replica
-- publication (explicit FOR TABLE list).
CREATE TABLE public.updates_cache_purge_pending (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id text NOT NULL,
  due_at timestamptz NOT NULL,
  -- true for the first purge of a change: its success schedules re-purges.
  initial boolean NOT NULL DEFAULT true,
  -- Set by a claim; an expired lease makes the row claimable again.
  lease_token uuid,
  leased_until timestamptz
);
CREATE INDEX updates_cache_purge_pending_due_at_idx ON public.updates_cache_purge_pending (due_at);
CREATE INDEX updates_cache_purge_pending_lease_idx ON public.updates_cache_purge_pending (lease_token) WHERE lease_token IS NOT NULL;
ALTER TABLE public.updates_cache_purge_pending OWNER TO postgres;
ALTER TABLE public.updates_cache_purge_pending ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.updates_cache_purge_pending FROM PUBLIC, anon, authenticated;

-- Operational state only (the switch lives in Vault).
CREATE TABLE public.updates_cache_purge_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_claim_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO public.updates_cache_purge_state (id) VALUES (true) ON CONFLICT DO NOTHING;
ALTER TABLE public.updates_cache_purge_state OWNER TO postgres;
ALTER TABLE public.updates_cache_purge_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.updates_cache_purge_state FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.updates_cache_purge_enabled()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_setting text;
BEGIN
  SELECT decrypted_secret
  INTO v_setting
  FROM vault.decrypted_secrets
  WHERE name = 'CAPGO_UPDATES_CACHE_PURGE_ENABLED'
  LIMIT 1;

  RETURN pg_catalog.lower(pg_catalog.btrim(COALESCE(v_setting, ''))) IN ('true', 'on', '1');
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER FUNCTION public.updates_cache_purge_enabled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.updates_cache_purge_enabled() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.updates_cache_purge_enabled() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.updates_cache_purge_enabled() TO service_role;

-- Queues one wake of the purge endpoint (pg_net sends it after commit).
CREATE OR REPLACE FUNCTION public.wake_updates_cache_purge()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM net.http_post(
    url := public.get_db_url() || '/functions/v1/triggers/updates_cache_purge',
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'apisecret', public.get_apikey()
    ),
    body := pg_catalog.jsonb_build_object('wake', true),
    timeout_milliseconds := 5000
  );
END;
$$;

ALTER FUNCTION public.wake_updates_cache_purge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_updates_cache_purge() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wake_updates_cache_purge() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_updates_cache_purge() TO service_role;

-- Cron tick: wake the endpoint only while purges are due (no HTTP otherwise).
CREATE OR REPLACE FUNCTION public.wake_updates_cache_purge_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.updates_cache_purge_pending
    WHERE due_at <= pg_catalog.clock_timestamp()
      AND (lease_token IS NULL OR leased_until <= pg_catalog.clock_timestamp())
  ) THEN
    PERFORM public.wake_updates_cache_purge();
  END IF;
END;
$$;

ALTER FUNCTION public.wake_updates_cache_purge_if_due() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_updates_cache_purge_if_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wake_updates_cache_purge_if_due() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_updates_cache_purge_if_due() TO service_role;

-- Claims (leases) up to p_limit due apps in the endpoint's own transaction.
-- Returns {status: busy|throttled|empty|ok, wait_ms?, lease_token?, apps?, has_more?}.
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

  WITH picked AS (
    SELECT p.app_id
    FROM public.updates_cache_purge_pending p
    WHERE p.due_at <= v_now AND (p.lease_token IS NULL OR p.leased_until <= v_now)
    GROUP BY p.app_id
    ORDER BY MIN(p.due_at)
    LIMIT GREATEST(LEAST(p_limit, 1000), 1)
  ),
  claimed AS (
    UPDATE public.updates_cache_purge_pending p
    SET lease_token = v_token, leased_until = v_now + v_lease
    FROM picked
    WHERE p.app_id = picked.app_id
      AND p.due_at <= v_now
      AND (p.lease_token IS NULL OR p.leased_until <= v_now)
    RETURNING p.app_id, p.initial
  )
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('app_id', c.app_id, 'initial', c.initial))
  INTO v_apps
  FROM (SELECT app_id, bool_or(initial) AS initial FROM claimed GROUP BY app_id) AS c;

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
-- (+10s / +60s / +180s from now) for the apps whose first purge this was.
-- Failure: release the rows, due again after the Retry-After.
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
      RETURNING app_id, initial
    )
    INSERT INTO public.updates_cache_purge_pending (app_id, due_at, initial)
    SELECT apps.app_id, v_now + delays.delay, false
    FROM (SELECT DISTINCT app_id FROM done WHERE initial) AS apps
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
CREATE OR REPLACE FUNCTION public.notify_updates_edge_cache_purge(p_app_ids text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.updates_cache_purge_pending (app_id, due_at, initial)
  SELECT app_id, pg_catalog.clock_timestamp(), true
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

ALTER FUNCTION public.notify_updates_edge_cache_purge(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_updates_edge_cache_purge(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_updates_edge_cache_purge(text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_updates_edge_cache_purge(text[]) TO service_role;

-- Wakes the endpoint every 10 seconds while purges are due (leftovers,
-- re-purges, retries).
INSERT INTO public.cron_tasks (name, description, task_type, target, second_interval, enabled)
VALUES (
  'updates_cache_purge_wake',
  'Wake the /updates edge cache purge endpoint while purges are due',
  'function',
  'public.wake_updates_cache_purge_if_due()',
  10,
  true
)
ON CONFLICT (name) DO NOTHING;

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

COMMENT ON FUNCTION public.invalidate_updates_edge_cache() IS
  'Statement-level AFTER trigger: collects app ids whose /updates answer may '
  'have changed and asks triggers/updates_cache_purge to purge their Cloudflare '
  'Cache-Tag. Runs once per statement over transition tables; lookups use '
  'finx_channels_version, idx_channels_rollout_version, idx_orgs_customer_id '
  'and finx_apps_owner_org.';

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
