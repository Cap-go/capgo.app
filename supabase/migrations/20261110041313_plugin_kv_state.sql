-- KV plugin state: the data the plugin endpoints (/updates, /stats,
-- /channel_self) read, kept in Workers KV so they can answer without the
-- read replicas (plugin_runtime/utils/pluginState.ts).
--
-- Statement-level triggers record which app changed, and which device
-- override, bundle name or bundle manifest of it. The Cloudflare API worker
-- (triggers/plugin_state_sync) claims the rows, rebuilds the KV documents from
-- this database and queues the existing edge cache purge so the old copies
-- leave every data center.
--
-- The write path only records work and tolerates sync failures:
-- - triggers INSERT into an identity-keyed queue and deduplicate only within
--   their own producer xid8, so another producer never conflicts on a queue
--   row; notifications use one indexed unique lookup per logical key and one wake per
--   transaction, sent after commit (http_dispatch_post);
-- - claim_plugin_state_sync() leases every due row of up to p_limit apps in
--   its own short transaction, never an app that another claim still holds,
--   so one app's changes are always applied in order;
-- - ack_plugin_state_sync() deletes the rows of synced apps and releases
--   failed ones at their retry delay, dropping a row after 5 attempts
--   (queue retry budget); exhausted rows stay archived until explicit repair.
-- Every trigger error is logged as a warning. Missing or invalid plugin
-- snapshots fall back to a read replica; no plugin request calls the primary.
--
-- Execution model: service_role-only internal RPCs; no new policy or public
-- request-path function. Claims are serialized in short transactions, limited
-- to 200 apps and 48 pending rows per app. The worker requests 4 apps per
-- claim and shares an 800-provider-operation invocation budget. Full backfills page
-- by (app_id, name) / (app_id, device_id) and persist their cursor.
-- apps/channels/orgs are console-scale; app_versions/channel_devices can be
-- large, and manifest/delta datasets contain millions of rows. prod.sql
-- describes indexes, not live cardinality estimates. Trigger work is bounded
-- by the statement transition rows and indexed membership lookups below; large
-- maintenance writes must be batched. Before production enablement, capture
-- staging EXPLAIN (ANALYZE, BUFFERS) for representative large transition sets
-- and verify the version_files.file_ids GIN path is used.
--
-- Runtime switch: Vault secret CAPGO_PLUGIN_STATE_SYNC_ENABLED = 'true'.
-- Execution model of the trigger function: once per statement over its
-- transition tables; the lookups it makes are bounded by indexes
-- (channels.version finx_channels_version, channels.rollout_version
-- idx_channels_rollout_version, apps.owner_org finx_apps_owner_org,
-- orgs.customer_id idx_orgs_customer_id, version_files.file_ids
-- version_files_file_ids_gin_idx, app_versions primary key).
-- Transaction-local enqueue dedup uses
-- plugin_state_sync_pending_producer_job_unique (producer_xid, producer_job_key).
-- The existing pgcrypto digest(text,text), text length, concatenation and
-- integer output functions are immutable. No extension or function grant is added.

-- Claims allocate a global fencing generation under their short advisory
-- lock. Values are strings in JSON so bigint precision survives JavaScript.
ALTER TABLE public.updates_cache_purge_pending
  DROP CONSTRAINT updates_cache_purge_pending_scope_check;
ALTER TABLE public.updates_cache_purge_pending
  ADD CONSTRAINT updates_cache_purge_pending_scope_check CHECK (scope IN ('app', 'versions', 'plugin_state'));

CREATE SEQUENCE public.plugin_state_sync_generation AS bigint;
ALTER SEQUENCE public.plugin_state_sync_generation OWNER TO postgres;
REVOKE ALL ON SEQUENCE public.plugin_state_sync_generation FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.plugin_state_sync_pending (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id text NOT NULL,
  -- app: rebuild the app document; full: every key of the app (first sync,
  -- resync); device / version / manifest: one key, named by ref.
  kind text NOT NULL CHECK (kind IN ('app', 'full', 'device', 'version', 'manifest')),
  -- device_id, bundle name or bundle id; a full sync's resume cursor.
  ref text NOT NULL DEFAULT '',
  due_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  leased_until timestamptz,
  -- A transaction can touch the same app/manifest thousands of times through
  -- row-level view triggers. Other producer transactions must always retain
  -- their own invalidation, even while an earlier job is leased.
  producer_xid xid8 NOT NULL DEFAULT pg_catalog.pg_current_xact_id(),
  -- Fixed-width index keys also support long app/device/version identifiers.
  -- Character-count prefixes make the three text components unambiguous.
  -- Explicit digest(text,text) is immutable, unlike client-encoded textsend.
  producer_job_key bytea GENERATED ALWAYS AS (extensions.digest(
    pg_catalog.length(app_id)::text || ':' || app_id
    || pg_catalog.length(kind)::text || ':' || kind
    || pg_catalog.length(ref)::text || ':' || ref,
    'sha256'
  )) STORED,
  CONSTRAINT plugin_state_sync_pending_producer_job_unique UNIQUE (producer_xid, producer_job_key)
);
CREATE INDEX plugin_state_sync_pending_due_at_idx ON public.plugin_state_sync_pending (due_at);
CREATE INDEX plugin_state_sync_pending_app_id_idx ON public.plugin_state_sync_pending (app_id);
CREATE INDEX plugin_state_sync_pending_regular_idx ON public.plugin_state_sync_pending (app_id, id) WHERE kind <> 'full';
CREATE INDEX plugin_state_sync_pending_full_idx ON public.plugin_state_sync_pending (app_id, (ref = '') DESC, id DESC) WHERE kind = 'full';
CREATE TABLE public.plugin_state_sync_failed (
  app_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('app', 'full', 'device', 'version', 'manifest')),
  ref text NOT NULL DEFAULT '',
  repair_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, kind, ref)
);
CREATE INDEX plugin_state_sync_failed_repair_at_idx ON public.plugin_state_sync_failed (repair_at);
COMMENT ON TABLE public.plugin_state_sync_failed IS
  'Exhausted plugin state changes retained until explicit full repair. Never automatically reset a failed key retry budget.';

CREATE INDEX plugin_state_sync_pending_lease_idx ON public.plugin_state_sync_pending (lease_token) WHERE lease_token IS NOT NULL;
COMMENT ON TABLE public.plugin_state_sync_pending IS
  'Plugin KV state changes waiting for triggers/plugin_state_sync. Not in the read-replica publication.';

-- Last successful sync per app: daily reconcile and first-sync (backfill) bookkeeping.
CREATE TABLE public.plugin_state_sync_apps (
  app_id text PRIMARY KEY,
  synced_at timestamptz NOT NULL,
  full_synced_at timestamptz
);
CREATE INDEX plugin_state_sync_apps_synced_at_idx ON public.plugin_state_sync_apps (synced_at);
COMMENT ON TABLE public.plugin_state_sync_apps IS
  'Apps whose plugin KV state was written, with the time of the last write and of the last full sync.';

-- Lease settlement is a cooldown even when only part of an app's writes
-- succeeded. Keep it separate from successful-sync/backfill bookkeeping.
CREATE TABLE public.plugin_state_sync_cooldowns (
  app_id text PRIMARY KEY,
  next_write_at timestamptz NOT NULL
);

-- Operational state only (the switch lives in Vault): the backfill cursor.
CREATE TABLE public.plugin_state_sync_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  backfill_after text,
  backfill_done_at timestamptz,
  gc_cursor text,
  gc_due_at timestamptz NOT NULL DEFAULT '-infinity',
  gc_lease_token uuid,
  gc_leased_until timestamptz
);
INSERT INTO public.plugin_state_sync_state (id) VALUES (true) ON CONFLICT DO NOTHING;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['plugin_state_sync_pending', 'plugin_state_sync_failed', 'plugin_state_sync_apps', 'plugin_state_sync_cooldowns', 'plugin_state_sync_state'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.%I OWNER TO postgres', table_name);
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE pg_catalog.format(
      'CREATE POLICY "Deny all direct access" ON public.%I AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false)',
      table_name
    );
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE pg_catalog.format('GRANT ALL ON TABLE public.%I TO service_role', table_name);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.plugin_state_sync_enabled()
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
  WHERE name = 'CAPGO_PLUGIN_STATE_SYNC_ENABLED'
  LIMIT 1;

  RETURN pg_catalog.lower(pg_catalog.btrim(COALESCE(v_setting, ''))) IN ('true', 'on', '1');
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER FUNCTION public.plugin_state_sync_enabled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.plugin_state_sync_enabled() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.plugin_state_sync_enabled() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plugin_state_sync_enabled() TO service_role;

-- One wake of the sync endpoint (pg_net or the dispatcher outbox, after commit).
CREATE OR REPLACE FUNCTION public.wake_plugin_state_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.http_dispatch_post(
    p_target := 'plugin_state_sync',
    p_url := public.get_db_url() || '/functions/v1/triggers/plugin_state_sync',
    p_headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'apisecret', public.get_apikey()
    ),
    p_body := pg_catalog.jsonb_build_object('wake', true),
    p_timeout_ms := 5000
  );
END;
$$;

ALTER FUNCTION public.wake_plugin_state_sync() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_plugin_state_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wake_plugin_state_sync() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_plugin_state_sync() TO service_role;

-- Queue changes: p_app_ids[i] with p_refs[i] (refs default to '').
CREATE OR REPLACE FUNCTION public.notify_plugin_state_sync(p_kind text, p_app_ids text[], p_refs text[] DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.plugin_state_sync_pending (app_id, kind, ref)
  SELECT DISTINCT item.app_id, p_kind, COALESCE(item.ref, '')
  FROM ROWS FROM (pg_catalog.unnest(p_app_ids), pg_catalog.unnest(COALESCE(p_refs, ARRAY[]::text[]))) AS item (app_id, ref)
  WHERE item.app_id IS NOT NULL AND item.app_id <> ''
  ON CONFLICT ON CONSTRAINT plugin_state_sync_pending_producer_job_unique DO NOTHING;

  -- One wake per transaction (an app delete cascades to several statements).
  IF pg_catalog.current_setting('capgo.plugin_state_wake_sent', true) IS DISTINCT FROM 'on' THEN
    PERFORM pg_catalog.set_config('capgo.plugin_state_wake_sent', 'on', true);
    BEGIN
      PERFORM public.wake_plugin_state_sync();
    EXCEPTION WHEN OTHERS THEN
      -- A dispatch failure must roll back only the wake, never the pending
      -- changes inserted above. The existing tick retries the durable work.
      RAISE WARNING 'plugin state wake failed: %', SQLERRM;
    END;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- The sync is an accelerator; never fail the business write.
  RAISE WARNING 'notify_plugin_state_sync failed: %', SQLERRM;
END;
$$;

ALTER FUNCTION public.notify_plugin_state_sync(text, text[], text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_plugin_state_sync(text, text[], text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_plugin_state_sync(text, text[], text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_plugin_state_sync(text, text[], text[]) TO service_role;

-- Full sync of some apps (NULL: every app). Operations and tests.
CREATE OR REPLACE FUNCTION public.enqueue_plugin_state_full_sync(p_app_ids text[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_app_ids text[];
BEGIN
  SELECT pg_catalog.array_agg(known.app_id ORDER BY known.app_id)
  INTO v_app_ids
  FROM (
    SELECT a.app_id::text AS app_id FROM public.apps a
    UNION
    SELECT s.app_id FROM public.plugin_state_sync_apps s
    UNION
    SELECT f.app_id FROM public.plugin_state_sync_failed f
    UNION
    SELECT p.app_id FROM public.plugin_state_sync_pending p
  ) AS known
  WHERE p_app_ids IS NULL OR known.app_id = ANY (p_app_ids);
  IF v_app_ids IS NULL THEN
    RETURN 0;
  END IF;
  -- An explicit repair must fail atomically if durable enqueue fails. The
  -- business-write notification helper intentionally swallows those errors.
  INSERT INTO public.plugin_state_sync_pending (app_id, kind, ref)
  SELECT selected.app_id, 'full', '' FROM pg_catalog.unnest(v_app_ids) AS selected (app_id)
  ON CONFLICT ON CONSTRAINT plugin_state_sync_pending_producer_job_unique DO NOTHING;

  -- Manual repair grants a fresh budget to exhausted exact keys, including
  -- a fifth lease whose drain crashed. Preserve live leases: resetting a
  -- budget must not permit a second drain to overlap its current owner.
  UPDATE public.plugin_state_sync_pending
  SET attempts = 0
  WHERE app_id = ANY (v_app_ids) AND attempts >= 5;
  -- Prior completion is not evidence that this newly requested repair ran.
  UPDATE public.plugin_state_sync_apps
  SET full_synced_at = NULL
  WHERE app_id = ANY (v_app_ids);
  -- Explicit repair, unlike the daily tick, is allowed to retry archived
  -- exact keys. Keep historical/unserved manifest identities in this move.
  WITH repair AS (
    DELETE FROM public.plugin_state_sync_failed f WHERE f.app_id = ANY (v_app_ids)
    RETURNING f.app_id, f.kind, f.ref
  )
  INSERT INTO public.plugin_state_sync_pending (app_id, kind, ref)
  SELECT app_id, kind, ref FROM repair
  ON CONFLICT ON CONSTRAINT plugin_state_sync_pending_producer_job_unique DO NOTHING;

  IF pg_catalog.current_setting('capgo.plugin_state_wake_sent', true) IS DISTINCT FROM 'on' THEN
    PERFORM pg_catalog.set_config('capgo.plugin_state_wake_sent', 'on', true);
    BEGIN
      PERFORM public.wake_plugin_state_sync();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'plugin state repair wake failed: %', SQLERRM;
    END;
  END IF;
  RETURN pg_catalog.cardinality(v_app_ids);
END;
$$;

ALTER FUNCTION public.enqueue_plugin_state_full_sync(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_plugin_state_full_sync(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_plugin_state_full_sync(text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_plugin_state_full_sync(text[]) TO service_role;

-- Leases every due row of up to p_limit apps that no other claim holds.
-- Returns {status: busy|empty|ok, lease_token?, apps?: [{app_id, jobs: [{kind, ref}], attempts}], has_more?}.
CREATE OR REPLACE FUNCTION public.claim_plugin_state_sync(p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lease interval := '2 minutes';
  v_token uuid := pg_catalog.gen_random_uuid();
  v_apps jsonb;
  v_generation text;
  v_retry_at timestamptz;
BEGIN
  -- Claims are serialized: an app is never leased by two drains at once.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('plugin_state_sync_claim')) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'busy');
  END IF;

  WITH busy AS (
    SELECT DISTINCT p.app_id
    FROM public.plugin_state_sync_pending p
    WHERE p.lease_token IS NOT NULL AND p.leased_until > v_now
  ),
  picked AS (
    SELECT p.app_id
    FROM public.plugin_state_sync_pending p
    WHERE p.due_at <= v_now
      AND (p.lease_token IS NULL OR p.leased_until <= v_now)
      AND p.attempts < 5
      AND NOT EXISTS (SELECT 1 FROM busy b WHERE b.app_id = p.app_id)
      -- All keys of an app share its lease and cooldown. KV allows at most
      -- one write per key per second, including across separate invocations.
      AND NOT EXISTS (
        SELECT 1 FROM public.plugin_state_sync_cooldowns s
        WHERE s.app_id = p.app_id AND s.next_write_at > v_now
      )
    GROUP BY p.app_id
    ORDER BY MIN(p.due_at)
    LIMIT GREATEST(LEAST(p_limit, 200), 1)
  ),
  bounded AS (
    SELECT candidate.id
    FROM picked
    LEFT JOIN LATERAL (
      -- A fresh full request wins over a continuation. Otherwise resume the
      -- newest cursor regardless of the device/version backlog before it.
      SELECT p.id
      FROM public.plugin_state_sync_pending p
      WHERE p.app_id = picked.app_id AND p.kind = 'full' AND p.due_at <= v_now
        AND (p.lease_token IS NULL OR p.leased_until <= v_now) AND p.attempts < 5
      ORDER BY (p.ref = '') DESC, p.id DESC LIMIT 1
    ) AS full_job ON true
    CROSS JOIN LATERAL (
      SELECT full_job.id WHERE full_job.id IS NOT NULL
      UNION ALL
      SELECT regular.id FROM (
        SELECT p.id
        FROM public.plugin_state_sync_pending p
        WHERE p.app_id = picked.app_id AND p.kind <> 'full' AND p.due_at <= v_now
          AND (p.lease_token IS NULL OR p.leased_until <= v_now) AND p.attempts < 5
        ORDER BY p.id LIMIT CASE WHEN full_job.id IS NULL THEN 48 ELSE 47 END
      ) AS regular
    ) AS candidate
  ),
  claimed AS (
    UPDATE public.plugin_state_sync_pending p
    SET lease_token = v_token, leased_until = v_now + v_lease, attempts = p.attempts + 1
    FROM bounded
    WHERE p.id = bounded.id
    RETURNING p.id, p.app_id, p.kind, p.ref, p.attempts
  )
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('app_id', grouped.app_id, 'jobs', grouped.jobs, 'attempts', grouped.attempts))
  INTO v_apps
  FROM (
    SELECT claimed.app_id,
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', claimed.kind, 'ref', claimed.ref) ORDER BY claimed.id) AS jobs,
      MAX(claimed.attempts) AS attempts
    FROM claimed
    GROUP BY claimed.app_id
  ) AS grouped;

  IF v_apps IS NULL THEN
    -- A wake can race a lease or its cooldown. Tell this bounded drain when
    -- it can retry rather than waiting for the next ten-second cron tick.
    SELECT MIN(GREATEST(candidate.due_at, COALESCE(c.next_write_at, candidate.due_at),
      COALESCE(busy.until_at, candidate.due_at))) INTO v_retry_at
    FROM (
      SELECT p.app_id, p.due_at FROM public.plugin_state_sync_pending p
      WHERE p.attempts < 5 ORDER BY p.due_at LIMIT 200
    ) AS candidate
    LEFT JOIN public.plugin_state_sync_cooldowns c ON c.app_id = candidate.app_id
    LEFT JOIN LATERAL (
      SELECT MAX(p.leased_until) AS until_at
      FROM public.plugin_state_sync_pending p
      WHERE p.app_id = candidate.app_id AND p.lease_token IS NOT NULL AND p.leased_until > v_now
    ) AS busy ON true;
    RETURN pg_catalog.jsonb_build_object('status', 'empty', 'retry_after_ms',
      CASE WHEN v_retry_at IS NULL THEN NULL
        ELSE GREATEST(LEAST(CEIL(EXTRACT(epoch FROM (v_retry_at - v_now)) * 1000)::integer, 120000), 1) END);
  END IF;

  v_generation := pg_catalog.nextval('public.plugin_state_sync_generation'::pg_catalog.regclass)::text;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'generation', v_generation,
    'lease_token', v_token,
    'apps', v_apps,
    'has_more', EXISTS (
      SELECT 1 FROM public.plugin_state_sync_pending
      WHERE due_at <= v_now AND (lease_token IS NULL OR leased_until <= v_now)
    )
  );
END;
$$;

ALTER FUNCTION public.claim_plugin_state_sync(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_plugin_state_sync(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_plugin_state_sync(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_plugin_state_sync(integer) TO service_role;

-- Settles a lease: synced apps lose their rows and record the sync (removed
-- apps, now tombstones, lose their bookkeeping row); failed apps are due again
-- after the retry delay, or dropped after 5 attempts.
CREATE OR REPLACE FUNCTION public.ack_plugin_state_sync(
  p_lease_token uuid,
  p_done text[],
  p_failed text[] DEFAULT '{}',
  p_retry_after_seconds integer DEFAULT 10,
  p_full_done text[] DEFAULT '{}',
  p_removed text[] DEFAULT '{}',
  p_deferred text[] DEFAULT '{}',
  p_versions_changed text[] DEFAULT '{}',
  p_changed_apps text[] DEFAULT NULL,
  p_continuations jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_dropped integer;
BEGIN
  -- An expired/replaced drain must not settle work or overwrite bookkeeping
  -- for its replacement. R2 publication itself is independently CAS-fenced.
  p_done := ARRAY(SELECT DISTINCT p.app_id FROM public.plugin_state_sync_pending p
    WHERE p.lease_token = p_lease_token AND p.leased_until > v_now AND p.app_id = ANY (COALESCE(p_done, '{}')));
  p_failed := ARRAY(SELECT DISTINCT p.app_id FROM public.plugin_state_sync_pending p
    WHERE p.lease_token = p_lease_token AND p.leased_until > v_now AND p.app_id = ANY (COALESCE(p_failed, '{}')));
  p_deferred := ARRAY(SELECT DISTINCT p.app_id FROM public.plugin_state_sync_pending p
    WHERE p.lease_token = p_lease_token AND p.leased_until > v_now AND p.app_id = ANY (COALESCE(p_deferred, '{}')));

  -- Persist purges in this same transaction before removing sync work. Do
  -- not call the best-effort notify helper here: its EXCEPTION handler may
  -- swallow insertion errors, which would otherwise lose invalidation work.
  INSERT INTO public.updates_cache_purge_pending (app_id, due_at, initial, scope)
  SELECT DISTINCT published.app_id, v_now, false, 'plugin_state'
  FROM pg_catalog.unnest(COALESCE(p_changed_apps, p_done, '{}')) AS published (app_id)
  WHERE EXISTS (
    SELECT 1 FROM public.plugin_state_sync_pending p
    WHERE p.app_id = published.app_id AND p.lease_token = p_lease_token AND p.leased_until > v_now
  );

  IF FOUND THEN
    BEGIN
      PERFORM public.wake_updates_cache_purge();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'plugin state purge wake failed: %', SQLERRM;
    END;
  END IF;

  -- Collapse old cursors only under the live owning lease. An explicit full
  -- request committed after this claim survives and restarts from its own
  -- fresh source snapshot; an expired drain cannot enqueue a stale cursor.
  WITH settled AS (
    SELECT DISTINCT p.app_id
    FROM public.plugin_state_sync_pending p
    WHERE p.lease_token = p_lease_token AND p.leased_until > v_now AND p.app_id = ANY (COALESCE(p_done, '{}'))
      AND (p.kind = 'full' OR COALESCE(p_continuations, '{}') ? p.app_id)
  )
  DELETE FROM public.plugin_state_sync_pending p USING settled s
  WHERE p.app_id = s.app_id AND p.kind = 'full'
    AND (p.lease_token IS NULL OR p.lease_token = p_lease_token OR p.leased_until <= v_now)
    AND (p.ref <> '' OR p.lease_token = p_lease_token);

  DELETE FROM public.plugin_state_sync_pending
  WHERE lease_token = p_lease_token AND app_id = ANY (COALESCE(p_done, '{}'));

  INSERT INTO public.plugin_state_sync_pending (app_id, kind, ref, due_at)
  SELECT entry.key, 'full', entry.value, v_now + interval '1100 milliseconds'
  FROM pg_catalog.jsonb_each_text(COALESCE(p_continuations, '{}')) AS entry
  WHERE entry.key = ANY (COALESCE(p_done, '{}'));

  INSERT INTO public.plugin_state_sync_apps AS synced (app_id, synced_at, full_synced_at)
  SELECT DISTINCT done.app_id, v_now, CASE
    WHEN done.app_id = ANY (COALESCE(p_full_done, '{}'))
      AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_pending p WHERE p.app_id = done.app_id AND p.kind = 'full')
      AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_failed f WHERE f.app_id = done.app_id AND f.kind = 'full')
    THEN v_now END
  FROM pg_catalog.unnest(COALESCE(p_done, '{}')) AS done (app_id)
  ON CONFLICT (app_id) DO UPDATE
  SET synced_at = EXCLUDED.synced_at,
      full_synced_at = CASE
        WHEN EXISTS (SELECT 1 FROM public.plugin_state_sync_pending p WHERE p.app_id = synced.app_id AND p.kind = 'full')
          OR EXISTS (SELECT 1 FROM public.plugin_state_sync_failed f WHERE f.app_id = synced.app_id AND f.kind = 'full')
        THEN NULL
        ELSE COALESCE(EXCLUDED.full_synced_at, synced.full_synced_at)
      END;

  UPDATE public.plugin_state_sync_apps
  SET full_synced_at = NULL
  WHERE app_id = ANY (COALESCE(p_removed, '{}'));

  -- Keep exact exhausted keys for explicit repair; daily reconciliation must
  -- not grant poison work another automatic five attempts.
  INSERT INTO public.plugin_state_sync_failed (app_id, kind, ref, repair_at)
  SELECT app_id, kind, CASE WHEN kind = 'full' THEN '' ELSE ref END, v_now + interval '1 day'
  FROM public.plugin_state_sync_pending
  WHERE lease_token = p_lease_token AND app_id = ANY (COALESCE(p_failed, '{}')) AND attempts >= 5
  ON CONFLICT (app_id, kind, ref) DO NOTHING;

  -- Queue retry budget: at most 5 attempts per change.
  DELETE FROM public.plugin_state_sync_pending
  WHERE lease_token = p_lease_token AND app_id = ANY (COALESCE(p_failed, '{}')) AND attempts >= 5;
  GET DIAGNOSTICS v_dropped = ROW_COUNT;
  IF v_dropped > 0 THEN
    RAISE WARNING 'plugin_state_sync dropped % changes after 5 attempts', v_dropped;
  END IF;

  UPDATE public.plugin_state_sync_pending
  SET lease_token = NULL,
      leased_until = NULL,
      due_at = v_now + pg_catalog.make_interval(secs => GREATEST(LEAST(p_retry_after_seconds, 300), 1))
  WHERE lease_token = p_lease_token AND app_id = ANY (COALESCE(p_failed, '{}'));

  -- Every settled app may have completed some writes, even on a failure.
  -- A different pending change must not immediately write the same KV key.
  INSERT INTO public.plugin_state_sync_cooldowns (app_id, next_write_at)
  SELECT DISTINCT settled.app_id, v_now + interval '1100 milliseconds'
  FROM pg_catalog.unnest(
    COALESCE(p_done, '{}') || COALESCE(p_failed, '{}') || COALESCE(p_deferred, '{}')
  ) AS settled (app_id)
  ON CONFLICT (app_id) DO UPDATE SET next_write_at = EXCLUDED.next_write_at;

  -- Capacity exhaustion is not a provider failure.
  UPDATE public.plugin_state_sync_pending
  SET attempts = GREATEST(attempts - 1, 0), due_at = v_now + interval '1100 milliseconds'
  WHERE lease_token = p_lease_token AND app_id = ANY (COALESCE(p_deferred, '{}'));

  -- Anything else of the lease is released as is.
  UPDATE public.plugin_state_sync_pending
  SET lease_token = NULL, leased_until = NULL
  WHERE lease_token = p_lease_token;
END;
$$;

ALTER FUNCTION public.ack_plugin_state_sync(uuid, text[], text[], integer, text[], text[], text[], text[], text[], jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ack_plugin_state_sync(uuid, text[], text[], integer, text[], text[], text[], text[], text[], jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ack_plugin_state_sync(uuid, text[], text[], integer, text[], text[], text[], text[], text[], jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ack_plugin_state_sync(uuid, text[], text[], integer, text[], text[], text[], text[], text[], jsonb) TO service_role;

-- GC coordination is one indexed operational row, service-only and never
-- on a plugin request path. Partial pages resume on the next existing tick.
CREATE OR REPLACE FUNCTION public.claim_plugin_state_gc()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_state public.plugin_state_sync_state%ROWTYPE;
  v_token uuid := pg_catalog.gen_random_uuid();
BEGIN
  SELECT * INTO v_state FROM public.plugin_state_sync_state WHERE id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR v_state.gc_due_at > pg_catalog.clock_timestamp()
    OR (v_state.gc_lease_token IS NOT NULL AND v_state.gc_leased_until > pg_catalog.clock_timestamp()) THEN
    RETURN NULL;
  END IF;
  UPDATE public.plugin_state_sync_state
  SET gc_lease_token = v_token, gc_leased_until = pg_catalog.clock_timestamp() + interval '2 minutes'
  WHERE id;
  RETURN pg_catalog.jsonb_build_object('lease_token', v_token, 'cursor', v_state.gc_cursor);
END;
$$;
ALTER FUNCTION public.claim_plugin_state_gc() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_plugin_state_gc() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_plugin_state_gc() TO service_role;

CREATE OR REPLACE FUNCTION public.ack_plugin_state_gc(p_lease_token uuid, p_cursor text, p_complete boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.plugin_state_sync_state
  SET gc_cursor = CASE WHEN p_complete THEN NULL ELSE p_cursor END,
      gc_due_at = pg_catalog.clock_timestamp() + CASE WHEN p_complete THEN interval '1 day' ELSE interval '0 seconds' END,
      gc_lease_token = NULL, gc_leased_until = NULL
  WHERE id AND gc_lease_token = p_lease_token;
END;
$$;
ALTER FUNCTION public.ack_plugin_state_gc(uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ack_plugin_state_gc(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ack_plugin_state_gc(uuid, text, boolean) TO service_role;

-- Cron tick (every 10s): first sync of every app in app_id order (paced by
-- the pending queue), daily rebuild of every app document, and a wake while
-- changes are due.
CREATE OR REPLACE FUNCTION public.plugin_state_sync_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch constant integer := 25;
  v_max_pending constant integer := 200;
  v_after text;
  v_done timestamptz;
  v_ids text[];
  v_last text;
  v_pending integer;
BEGIN
  IF NOT public.plugin_state_sync_enabled() THEN
    RETURN;
  END IF;

  -- A crash on the fifth lease must not cause a sixth attempt. Archive
  -- only a bounded batch and preserve the original key for later repair.
  WITH exhausted AS (
    SELECT id FROM public.plugin_state_sync_pending
    WHERE attempts >= 5 AND (lease_token IS NULL OR leased_until <= pg_catalog.clock_timestamp())
    ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM public.plugin_state_sync_pending p USING exhausted e
    WHERE p.id = e.id RETURNING p.app_id, p.kind, p.ref
  )
  INSERT INTO public.plugin_state_sync_failed (app_id, kind, ref, repair_at)
  SELECT DISTINCT app_id, kind, CASE WHEN kind = 'full' THEN '' ELSE ref END, pg_catalog.now() + interval '1 day'
  FROM removed
  ON CONFLICT (app_id, kind, ref) DO NOTHING;

  SELECT count(*) INTO v_pending
  FROM (SELECT 1 FROM public.plugin_state_sync_pending LIMIT v_max_pending) AS limited;

  IF v_pending < v_max_pending THEN
    SELECT backfill_after, backfill_done_at INTO v_after, v_done
    FROM public.plugin_state_sync_state
    WHERE id
    FOR UPDATE SKIP LOCKED;

    IF FOUND AND v_done IS NULL THEN
      SELECT pg_catalog.array_agg(next_apps.app_id ORDER BY next_apps.app_id), MAX(next_apps.app_id)
      INTO v_ids, v_last
      FROM (
        SELECT a.app_id::text AS app_id
        FROM public.apps a
        WHERE v_after IS NULL OR a.app_id > v_after
        ORDER BY a.app_id
        LIMIT v_batch
      ) AS next_apps;

      IF v_ids IS NULL THEN
        UPDATE public.plugin_state_sync_state SET backfill_done_at = pg_catalog.now() WHERE id;
      ELSE
        SELECT pg_catalog.array_agg(candidate)
        INTO v_ids
        FROM pg_catalog.unnest(v_ids) AS candidate
        WHERE NOT EXISTS (
          SELECT 1 FROM public.plugin_state_sync_apps s
          WHERE s.app_id = candidate AND s.full_synced_at IS NOT NULL
        )
          AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_failed f WHERE f.app_id = candidate);
        IF v_ids IS NOT NULL THEN
          PERFORM public.notify_plugin_state_sync('full', v_ids);
        END IF;
        UPDATE public.plugin_state_sync_state SET backfill_after = v_last WHERE id;
      END IF;
    END IF;

    SELECT pg_catalog.array_agg(stale.app_id)
    INTO v_ids
    FROM (
      SELECT s.app_id
      FROM public.plugin_state_sync_apps s
      WHERE s.synced_at < pg_catalog.now() - interval '1 day'
        AND EXISTS (SELECT 1 FROM public.apps a WHERE a.app_id = s.app_id)
        AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_pending p WHERE p.app_id = s.app_id)
        AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_failed f WHERE f.app_id = s.app_id)
      ORDER BY s.synced_at
      LIMIT v_batch
    ) AS stale;
    IF v_ids IS NOT NULL THEN
      PERFORM public.notify_plugin_state_sync('app', v_ids);
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.plugin_state_sync_pending
    WHERE due_at <= pg_catalog.clock_timestamp()
      AND (lease_token IS NULL OR leased_until <= pg_catalog.clock_timestamp())
  ) OR EXISTS (
    SELECT 1 FROM public.plugin_state_sync_state WHERE id
      AND gc_due_at <= pg_catalog.clock_timestamp()
      AND (gc_lease_token IS NULL OR gc_leased_until <= pg_catalog.clock_timestamp())
  ) THEN
    PERFORM public.wake_plugin_state_sync();
  END IF;
END;
$$;

ALTER FUNCTION public.plugin_state_sync_tick() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.plugin_state_sync_tick() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.plugin_state_sync_tick() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plugin_state_sync_tick() TO service_role;

INSERT INTO public.cron_tasks (name, description, task_type, target, second_interval, enabled)
VALUES (
  'plugin_state_sync_tick',
  'Backfill, reconcile and wake the plugin KV state sync',
  'function',
  'public.plugin_state_sync_tick()',
  10,
  true
)
ON CONFLICT (name) DO NOTHING;

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
             o.rollout_paused_version_names, o.expose_metadata, o.allow_device_custom_id,
             o.block_provider_infra_requests, o.device_data_collection)
        IS DISTINCT FROM
            (n.app_id, n.owner_org, n.channel_device_count, n.manifest_bundle_count, n.rollout_channel_count,
             n.rollout_paused_version_names, n.expose_metadata, n.allow_device_custom_id,
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

ALTER FUNCTION public.enqueue_plugin_state_sync() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_plugin_state_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_plugin_state_sync() FROM anon, authenticated;

COMMENT ON FUNCTION public.enqueue_plugin_state_sync() IS
  'Statement-level AFTER trigger: queues the plugin KV state keys a write changed for triggers/plugin_state_sync. Runs once per statement over transition tables with index-bounded lookups.';

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('apps', 'INSERT'), ('apps', 'UPDATE'), ('apps', 'DELETE'),
      ('channels', 'INSERT'), ('channels', 'UPDATE'), ('channels', 'DELETE'),
      ('app_versions', 'INSERT'), ('app_versions', 'UPDATE'), ('app_versions', 'DELETE'),
      ('orgs', 'UPDATE'),
      ('stripe_info', 'INSERT'), ('stripe_info', 'UPDATE'), ('stripe_info', 'DELETE'),
      ('channel_devices', 'INSERT'), ('channel_devices', 'UPDATE'), ('channel_devices', 'DELETE'),
      ('version_files', 'INSERT'), ('version_files', 'UPDATE'), ('version_files', 'DELETE'),
      ('delta_files', 'INSERT'), ('delta_files', 'UPDATE'), ('delta_files', 'DELETE')
    ) AS triggers (table_name, operation)
  LOOP
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER %I AFTER %s ON public.%I REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION public.enqueue_plugin_state_sync()',
      'plugin_state_sync_' || spec.table_name || '_' || pg_catalog.lower(pg_catalog.left(spec.operation, 3)),
      spec.operation,
      spec.table_name,
      CASE spec.operation
        WHEN 'INSERT' THEN 'NEW TABLE AS new_rows'
        WHEN 'DELETE' THEN 'OLD TABLE AS old_rows'
        ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows'
      END
    );
  END LOOP;
END;
$$;
