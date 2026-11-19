-- Service-only background operations. Business source rows are read only on EU.
-- Primary keeps leases, cursors, retries, runtime switches and purge bookkeeping.
-- A monotonic marker value is reserved AFTER the claim sees committed producer
-- rows. Only its visibility in EU proves those source commits have applied.
-- Preserve PostgreSQL precision and barriers on deferral and continuation.
ALTER TABLE public.plugin_state_sync_pending ADD COLUMN source_commit_at timestamptz;
ALTER TABLE public.serving_policy_sync_pending ADD COLUMN source_commit_at timestamptz;
ALTER TABLE public.plugin_state_sync_state ADD COLUMN source_commit_at timestamptz,
  ADD COLUMN repair_requested boolean NOT NULL DEFAULT false;
ALTER TABLE public.serving_policy_sync_progress ADD COLUMN source_commit_at timestamptz;

-- A short control-plane write reserves a strictly increasing value in the
-- existing replicated singleton. Its transaction commits after the observed
-- producer commit. This is a logical watermark even if the wall clock steps
-- backwards. No new replicated table/column, timer, or per-device primary read.
CREATE FUNCTION public.reserve_plugin_state_source_barrier() RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_barrier timestamptz;
BEGIN
  UPDATE public.read_replica_commit_marker
  SET committed_at = GREATEST(committed_at + interval '1 microsecond', pg_catalog.clock_timestamp())
  WHERE id = 1 RETURNING committed_at INTO v_barrier;
  IF NOT FOUND THEN RAISE EXCEPTION 'Plugin source commit marker is missing'; END IF;
  RETURN v_barrier;
END;
$$;
ALTER FUNCTION public.reserve_plugin_state_source_barrier() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reserve_plugin_state_source_barrier() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_plugin_state_source_barrier() TO service_role;

-- The existing heartbeat must preserve the same monotonic ordering. Its lag
-- warning and schedule are unchanged.
CREATE OR REPLACE FUNCTION public.touch_read_replica_commit_marker() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE prior_at timestamptz;
BEGIN
  SELECT committed_at INTO prior_at FROM public.read_replica_commit_marker WHERE id = 1;
  IF prior_at IS NOT NULL AND prior_at < pg_catalog.now() - interval '60 seconds' THEN
    RAISE WARNING 'read_replica_commit_marker stale before touch: age %', pg_catalog.now() - prior_at;
  END IF;
  PERFORM public.reserve_plugin_state_source_barrier();
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_plugin_state_sync(p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lease interval := interval '2 minutes';
  v_token uuid := pg_catalog.gen_random_uuid();
  v_apps jsonb;
  v_generation text;
  v_retry_at timestamptz;
  v_barrier timestamptz;
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
    RETURNING p.id, p.app_id, p.kind, p.ref, p.attempts, p.source_commit_at
  )
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('app_id', grouped.app_id, 'jobs', grouped.jobs, 'attempts', grouped.attempts, 'required_commit_at', grouped.source_commit_at::text))
  INTO v_apps
  FROM (
    SELECT claimed.app_id,
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', claimed.kind, 'ref', claimed.ref) ORDER BY claimed.id) AS jobs,
      MAX(claimed.attempts) AS attempts, MAX(claimed.source_commit_at) AS source_commit_at
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

  IF EXISTS (SELECT 1 FROM public.plugin_state_sync_pending WHERE lease_token = v_token AND source_commit_at IS NULL) THEN
    -- Exactly one singleton write per batch, after committed producer rows
    -- were observed. Already deferred keys keep their original watermark.
    v_barrier := public.reserve_plugin_state_source_barrier();
    UPDATE public.plugin_state_sync_pending SET source_commit_at = v_barrier
    WHERE lease_token = v_token AND source_commit_at IS NULL;
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('app_id', grouped.app_id, 'jobs', grouped.jobs,
      'attempts', grouped.attempts, 'required_commit_at', grouped.source_commit_at::text)) INTO v_apps
    FROM (
      SELECT p.app_id,
        pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', p.kind, 'ref', p.ref) ORDER BY p.id) AS jobs,
        MAX(p.attempts) AS attempts, MAX(p.source_commit_at) AS source_commit_at
      FROM public.plugin_state_sync_pending p WHERE p.lease_token = v_token GROUP BY p.app_id
    ) grouped;
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

CREATE FUNCTION public.claim_serving_policy_sync_source()
RETURNS TABLE(token uuid, generation text, app_id text, active_epoch text, required_commit_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_required timestamptz; v_id bigint; v_app text; v_token uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('serving_policy_sync_claim')) THEN RETURN; END IF;
  SELECT p.id, p.app_id INTO v_id, v_app FROM public.serving_policy_sync_pending p
  WHERE p.attempts < 5 AND p.due_at <= pg_catalog.clock_timestamp()
    AND (p.token IS NULL OR p.leased_until <= pg_catalog.clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM public.serving_policy_sync_pending busy
      WHERE busy.app_id = p.app_id AND busy.token IS NOT NULL AND busy.leased_until > pg_catalog.clock_timestamp())
  ORDER BY p.due_at, p.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF v_id IS NULL THEN RETURN; END IF;
  UPDATE public.serving_policy_sync_pending p SET token = v_token,
    leased_until = pg_catalog.clock_timestamp() + interval '1 minute', attempts = attempts + 1,
    source_commit_at = COALESCE(p.source_commit_at, public.reserve_plugin_state_source_barrier()) WHERE p.id = v_id
    RETURNING p.source_commit_at INTO v_required;
  RETURN QUERY SELECT v_token, pg_catalog.nextval('public.plugin_state_sync_generation'::pg_catalog.regclass)::text,
    v_app, public.serving_policy_active_epoch(), v_required::text;
END;
$$;

-- New workers settle independent version/manifest keys after a partial drain.
-- Keep the original ACK unchanged for old workers during deployment.
-- Service-only, once per claimed batch, never on a plugin request. Queue reads
-- use pending_lease_idx (at most 200 apps * 48 jobs); deletes use the primary key.
-- Per-app/full checks use the existing app/full indexes. No history is scanned.
CREATE OR REPLACE FUNCTION public.ack_plugin_state_sync_progress(
  p_lease_token uuid,
  p_done text[],
  p_failed text[] DEFAULT '{}',
  p_retry_after_seconds integer DEFAULT 10,
  p_full_done text[] DEFAULT '{}',
  p_removed text[] DEFAULT '{}',
  p_deferred text[] DEFAULT '{}',
  p_versions_changed text[] DEFAULT '{}',
  p_changed_apps text[] DEFAULT NULL,
  p_continuations jsonb DEFAULT '{}',
  p_app_published text[] DEFAULT '{}',
  p_completed jsonb DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_dropped integer;
  v_ids bigint[];
  v_apps text[];
  v_barriers jsonb;
BEGIN
  -- Serialize settlement against a replacement claim or another ACK. Refresh
  -- the validation time after waiting for locks so an expired lease cannot win.
  PERFORM p.id FROM public.plugin_state_sync_pending p
  WHERE p.lease_token = p_lease_token
  ORDER BY p.id FOR UPDATE;
  v_now := pg_catalog.clock_timestamp();

  -- An expired/replaced drain must not settle work or overwrite bookkeeping
  -- for its replacement. R2 publication itself is independently CAS-fenced.
  p_done := ARRAY(SELECT DISTINCT p.app_id FROM public.plugin_state_sync_pending p
    WHERE p.lease_token = p_lease_token AND p.leased_until > v_now AND p.app_id = ANY (COALESCE(p_done, '{}')));
  p_failed := ARRAY(SELECT DISTINCT p.app_id FROM public.plugin_state_sync_pending p
    WHERE p.lease_token = p_lease_token AND p.leased_until > v_now AND p.app_id = ANY (COALESCE(p_failed, '{}')));
  p_deferred := ARRAY(SELECT DISTINCT p.app_id FROM public.plugin_state_sync_pending p
    WHERE p.lease_token = p_lease_token AND p.leased_until > v_now AND p.app_id = ANY (COALESCE(p_deferred, '{}')));

  SELECT pg_catalog.array_agg(p.id), pg_catalog.array_agg(DISTINCT p.app_id)
  INTO v_ids, v_apps
  FROM public.plugin_state_sync_pending p
  WHERE p.lease_token = p_lease_token AND p.leased_until > v_now
    AND p.app_id = ANY (p_done || p_failed || p_deferred)
    -- Device jobs also require the app's inline override snapshot. They stay
    -- pending until the whole-app ACK settles that dependency.
    AND p.kind IN ('version', 'manifest')
    AND EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_to_recordset(COALESCE(p_completed -> p.app_id, '[]')) AS completed(kind text, ref text)
      WHERE completed.kind = p.kind AND completed.ref = p.ref
    );

  -- Persist purges in this same transaction before removing sync work. Do
  -- not call the best-effort notify helper here: its EXCEPTION handler may
  -- swallow insertion errors, which would otherwise lose invalidation work.
  INSERT INTO public.updates_cache_purge_pending (app_id, due_at, initial, scope)
  SELECT DISTINCT published.app_id, v_now, false, 'plugin_state'
  FROM pg_catalog.unnest(COALESCE(p_changed_apps, p_done, '{}') || COALESCE(v_apps, '{}')) AS published (app_id)
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
  SELECT pg_catalog.jsonb_object_agg(b.app_id, b.required_at::text) INTO v_barriers
  FROM (SELECT app_id, MAX(source_commit_at) AS required_at
    FROM public.plugin_state_sync_pending WHERE lease_token = p_lease_token AND leased_until > v_now
    GROUP BY app_id) b;

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

  INSERT INTO public.plugin_state_sync_pending (app_id, kind, ref, due_at, source_commit_at)
  SELECT entry.key, 'full', entry.value, v_now + interval '1100 milliseconds', (v_barriers ->> entry.key)::timestamptz
  FROM pg_catalog.jsonb_each_text(COALESCE(p_continuations, '{}')) AS entry
  WHERE entry.key = ANY (COALESCE(p_done, '{}'));

  INSERT INTO public.plugin_state_sync_apps AS synced (app_id, synced_at, app_synced_at, full_synced_at)
  SELECT DISTINCT done.app_id, v_now, CASE WHEN done.app_id = ANY (COALESCE(p_app_published, '{}')) THEN v_now END, CASE
    WHEN done.app_id = ANY (COALESCE(p_full_done, '{}'))
      AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_pending p WHERE p.app_id = done.app_id AND p.kind = 'full')
      AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_failed f WHERE f.app_id = done.app_id AND f.kind = 'full')
    THEN v_now END
  FROM pg_catalog.unnest(COALESCE(p_done, '{}')) AS done (app_id)
  ON CONFLICT (app_id) DO UPDATE
  SET synced_at = EXCLUDED.synced_at,
      app_synced_at = COALESCE(EXCLUDED.app_synced_at, synced.app_synced_at),
      full_synced_at = CASE
        WHEN EXISTS (SELECT 1 FROM public.plugin_state_sync_pending p WHERE p.app_id = synced.app_id AND p.kind = 'full')
          OR EXISTS (SELECT 1 FROM public.plugin_state_sync_failed f WHERE f.app_id = synced.app_id AND f.kind = 'full')
        THEN NULL
        ELSE COALESCE(EXCLUDED.full_synced_at, synced.full_synced_at)
      END;

  UPDATE public.plugin_state_sync_apps
  SET full_synced_at = NULL
  WHERE app_id = ANY (COALESCE(p_removed, '{}')) AND app_id = ANY (p_done);

  -- Purges and all whole-app/cursor decisions above still saw the live
  -- owning rows. Delete only those exact completed rows, never a newer producer
  -- job for the same key. A later failure rolls the purge and settlement back.
  DELETE FROM public.plugin_state_sync_pending WHERE id = ANY (v_ids);

  INSERT INTO public.plugin_state_sync_apps AS synced (app_id, synced_at)
  SELECT app_id, v_now FROM pg_catalog.unnest(v_apps) AS completed(app_id)
  ON CONFLICT (app_id) DO UPDATE SET synced_at = EXCLUDED.synced_at;

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

ALTER FUNCTION public.ack_plugin_state_sync_progress(uuid, text[], text[], integer, text[], text[], text[], text[], text[], jsonb, text[], jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ack_plugin_state_sync_progress(uuid, text[], text[], integer, text[], text[], text[], text[], text[], jsonb, text[], jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ack_plugin_state_sync_progress(uuid, text[], text[], integer, text[], text[], text[], text[], text[], jsonb, text[], jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ack_plugin_state_sync_progress(uuid, text[], text[], integer, text[], text[], text[], text[], text[], jsonb, text[], jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.enqueue_plugin_state_full_sync(p_app_ids text[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_app_ids text[];
BEGIN
  IF p_app_ids IS NULL THEN
    UPDATE public.plugin_state_sync_state SET backfill_after = NULL, backfill_done_at = NULL, source_commit_at = NULL, repair_requested = true WHERE id;
    PERFORM public.wake_plugin_state_sync();
    RETURN 0; -- Inventory is asynchronous and read from EU by the worker.
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT candidate) INTO v_app_ids
  FROM pg_catalog.unnest(p_app_ids) candidate WHERE candidate IS NOT NULL AND candidate <> '';
  IF v_app_ids IS NULL THEN
    RETURN 0;
  END IF;
  -- Coalesce only never-claimed repairs. Serialize the decision with claims
  -- and other repairs so a claim cannot reserve its source barrier between
  -- the freshness check and a concurrent request being coalesced.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('plugin_state_sync_claim'));
  -- An explicit repair must fail atomically if durable enqueue fails. The
  -- business-write notification helper intentionally swallows those errors.
  INSERT INTO public.plugin_state_sync_pending (app_id, kind, ref)
  SELECT selected.app_id, 'full', '' FROM pg_catalog.unnest(v_app_ids) AS selected (app_id)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.plugin_state_sync_pending pending
    WHERE pending.app_id = selected.app_id AND pending.kind = 'full' AND pending.ref = ''
      AND pending.lease_token IS NULL AND pending.attempts = 0 AND pending.source_commit_at IS NULL
  )
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

CREATE OR REPLACE FUNCTION public.plugin_state_sync_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batch constant integer := 25;
  v_max_pending constant integer := 200;
  v_ids text[];
  v_pending integer;
BEGIN
  BEGIN
    PERFORM public.serving_policy_sync_tick();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'serving policy sync tick failed: %', SQLERRM;
  END;
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
    SELECT pg_catalog.array_agg(stale.app_id)
    INTO v_ids
    FROM (
      SELECT s.app_id
      FROM public.plugin_state_sync_apps s
      WHERE (s.app_synced_at IS NULL OR s.app_synced_at < pg_catalog.now() - interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_pending p WHERE p.app_id = s.app_id)
        AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_failed f WHERE f.app_id = s.app_id)
      ORDER BY s.app_synced_at NULLS FIRST
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
  ) OR EXISTS (SELECT 1 FROM public.plugin_state_sync_state WHERE id AND backfill_done_at IS NULL)
  OR EXISTS (
    SELECT 1 FROM public.plugin_state_sync_state WHERE id
      AND gc_due_at <= pg_catalog.clock_timestamp()
      AND (gc_lease_token IS NULL OR gc_leased_until <= pg_catalog.clock_timestamp())
  ) THEN
    PERFORM public.wake_plugin_state_sync();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.serving_policy_sync_tick() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_epoch text := COALESCE(public.serving_policy_active_epoch(), '');
BEGIN
  -- Expired fifth leases (including crashes) are archived before another claim.
  WITH picked AS (SELECT id FROM public.serving_policy_sync_pending
    WHERE attempts >= 5 AND (token IS NULL OR leased_until <= pg_catalog.clock_timestamp())
    ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED),
  removed AS (DELETE FROM public.serving_policy_sync_pending p USING picked e WHERE p.id = e.id RETURNING p.id, p.app_id)
  INSERT INTO public.serving_policy_sync_failed(id, app_id) SELECT id, app_id FROM removed;

  IF EXISTS (SELECT 1 FROM public.serving_policy_sync_pending
    WHERE attempts < 5 AND due_at <= pg_catalog.clock_timestamp()
      AND (token IS NULL OR leased_until <= pg_catalog.clock_timestamp())) THEN
    PERFORM public.wake_plugin_state_sync();
  ELSIF EXISTS (SELECT 1 FROM public.serving_policy_sync_progress WHERE id AND (done_at IS NULL OR epoch <> v_epoch)) THEN
    PERFORM public.wake_plugin_state_sync();
  END IF;
END;
$$;


CREATE FUNCTION public.defer_serving_policy_sync(p_token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Source lag/outage is not a publication attempt. Fence against replacements.
  UPDATE public.serving_policy_sync_pending SET token = NULL, leased_until = NULL,
    attempts = GREATEST(attempts - 1, 0), due_at = pg_catalog.clock_timestamp() + interval '10 seconds'
  WHERE token = p_token AND leased_until > pg_catalog.clock_timestamp();
END;
$$;

-- Each call is one bounded control-plane operation by service_role. The state
-- row PK serializes cursor commits; stale workers cannot advance a replaced pass.
-- All source enumeration uses apps(app_id) on EU. Primary only merges bounded
-- bookkeeping identities, including deleted apps still needing cleanup/repair.
CREATE FUNCTION public.prepare_plugin_state_inventory(p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_after text; v_required timestamptz; v_epoch text; v_ids text[];
BEGIN
  IF p_kind = 'policy' THEN
    v_epoch := COALESCE(public.serving_policy_active_epoch(), '');
    UPDATE public.serving_policy_sync_progress SET epoch = v_epoch, after_app = NULL, done_at = NULL, source_commit_at = NULL
    WHERE id AND epoch <> v_epoch;
    IF (SELECT count(*) FROM (SELECT 1 FROM public.serving_policy_sync_pending LIMIT 200) p) >= 200 THEN RETURN NULL; END IF;
    UPDATE public.serving_policy_sync_progress SET source_commit_at = COALESCE(source_commit_at, public.reserve_plugin_state_source_barrier())
    WHERE id AND done_at IS NULL RETURNING after_app, source_commit_at INTO v_after, v_required;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSIF p_kind = 'payload' THEN
    IF NOT public.plugin_state_sync_enabled() OR (SELECT count(*) FROM (SELECT 1 FROM public.plugin_state_sync_pending LIMIT 200) p) >= 200 THEN RETURN NULL; END IF;
    UPDATE public.plugin_state_sync_state SET source_commit_at = COALESCE(source_commit_at, public.reserve_plugin_state_source_barrier())
    WHERE id AND backfill_done_at IS NULL RETURNING backfill_after, source_commit_at INTO v_after, v_required;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- Loose index walks skip all duplicate job keys for an app. DISTINCT/LIMIT
    -- would still scan millions of pending or archived keys for one app.
    -- At most 25 steps * 3 indexed LIMIT 1 probes; never read business tables.
    WITH RECURSIVE known(app_id, step) AS (
      SELECT min(c.app_id), 1 FROM (
        (SELECT app_id FROM public.plugin_state_sync_apps WHERE app_id > COALESCE(v_after, '') ORDER BY app_id LIMIT 1)
        UNION ALL (SELECT app_id FROM public.plugin_state_sync_failed WHERE app_id > COALESCE(v_after, '') ORDER BY app_id LIMIT 1)
        UNION ALL (SELECT app_id FROM public.plugin_state_sync_pending WHERE app_id > COALESCE(v_after, '') ORDER BY app_id LIMIT 1)
      ) c HAVING min(c.app_id) IS NOT NULL
      UNION ALL
      SELECT next_app.app_id, k.step + 1 FROM known k
      CROSS JOIN LATERAL (
        SELECT min(c.app_id) AS app_id FROM (
          (SELECT app_id FROM public.plugin_state_sync_apps WHERE app_id > k.app_id ORDER BY app_id LIMIT 1)
          UNION ALL (SELECT app_id FROM public.plugin_state_sync_failed WHERE app_id > k.app_id ORDER BY app_id LIMIT 1)
          UNION ALL (SELECT app_id FROM public.plugin_state_sync_pending WHERE app_id > k.app_id ORDER BY app_id LIMIT 1)
        ) c
      ) next_app WHERE k.step < 25 AND next_app.app_id IS NOT NULL
    ) SELECT array_agg(app_id ORDER BY app_id) INTO v_ids FROM known;
  ELSE RAISE EXCEPTION 'Invalid plugin state inventory kind'; END IF;
  RETURN jsonb_build_object('after', v_after, 'required_commit_at', v_required::text, 'epoch', v_epoch, 'known_ids', COALESCE(v_ids, '{}'));
END;
$$;

CREATE FUNCTION public.commit_plugin_state_inventory(p_kind text, p_after text, p_required timestamptz, p_epoch text, p_ids text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_last text; v_repair boolean;
BEGIN
  IF cardinality(p_ids) > (CASE WHEN p_kind = 'policy' THEN 100 ELSE 25 END)
    OR EXISTS (SELECT 1 FROM unnest(p_ids) candidate WHERE candidate IS NULL OR candidate <= COALESCE(p_after, '')) THEN
    RAISE EXCEPTION 'Invalid plugin state inventory page';
  END IF;
  SELECT max(candidate) INTO v_last FROM unnest(p_ids) candidate;
  IF p_kind = 'policy' THEN
    PERFORM 1 FROM public.serving_policy_sync_progress WHERE id AND after_app IS NOT DISTINCT FROM p_after
      AND source_commit_at = p_required AND done_at IS NULL AND epoch = p_epoch
      AND epoch = COALESCE(public.serving_policy_active_epoch(), '') FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO public.serving_policy_sync_pending(app_id, source_commit_at)
    SELECT DISTINCT candidate, p_required FROM unnest(p_ids) candidate
    WHERE NOT EXISTS (SELECT 1 FROM public.serving_policy_sync_pending p WHERE p.app_id = candidate)
      AND NOT EXISTS (SELECT 1 FROM public.serving_policy_sync_failed f WHERE f.app_id = candidate);
    UPDATE public.serving_policy_sync_progress SET after_app = COALESCE(v_last, after_app),
      done_at = CASE WHEN v_last IS NULL THEN pg_catalog.now() END WHERE id;
  ELSIF p_kind = 'payload' THEN
    SELECT repair_requested INTO v_repair FROM public.plugin_state_sync_state WHERE id AND backfill_after IS NOT DISTINCT FROM p_after
      AND source_commit_at = p_required AND backfill_done_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF v_repair THEN
      -- Only an explicit full repair may refresh exhausted budgets and restore
      -- historical exact keys. Automatic inventory must preserve the archive.
      PERFORM public.enqueue_plugin_state_full_sync(p_ids);
    ELSE
      INSERT INTO public.plugin_state_sync_pending(app_id, kind, ref, source_commit_at)
      SELECT DISTINCT candidate, 'full', '', p_required FROM unnest(p_ids) candidate
      WHERE NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_pending p WHERE p.app_id = candidate AND p.kind = 'full')
        AND NOT EXISTS (SELECT 1 FROM public.plugin_state_sync_failed f WHERE f.app_id = candidate)
      ON CONFLICT ON CONSTRAINT plugin_state_sync_pending_producer_job_unique DO NOTHING;
    END IF;
    UPDATE public.plugin_state_sync_state SET backfill_after = COALESCE(v_last, backfill_after),
      backfill_done_at = CASE WHEN v_last IS NULL THEN pg_catalog.now() END,
      repair_requested = CASE WHEN v_last IS NULL THEN false ELSE repair_requested END WHERE id;
  ELSE RAISE EXCEPTION 'Invalid plugin state inventory kind'; END IF;
  RETURN true;
END;
$$;

ALTER FUNCTION public.claim_serving_policy_sync_source() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_serving_policy_sync_source() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_serving_policy_sync_source() TO service_role;

ALTER FUNCTION public.defer_serving_policy_sync(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.defer_serving_policy_sync(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.defer_serving_policy_sync(uuid) TO service_role;

ALTER FUNCTION public.prepare_plugin_state_inventory(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_plugin_state_inventory(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_plugin_state_inventory(text) TO service_role;

ALTER FUNCTION public.commit_plugin_state_inventory(text, text, timestamptz, text, text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.commit_plugin_state_inventory(text, text, timestamptz, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_plugin_state_inventory(text, text, timestamptz, text, text[]) TO service_role;
