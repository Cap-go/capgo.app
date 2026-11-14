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

