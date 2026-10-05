-- Plugin edge cache purge: per-zone retries, slow-zone pacing, earlier re-purge.
--
-- Until now one purge batch called every plugin zone and any failing zone
-- failed the whole batch. A Free-plan zone (5 purge calls per minute) answered
-- most calls with 429, so about half the batches were released and retried on
-- every zone, and the re-purge chain of their apps only started once a whole
-- batch went through.
--
-- Pending rows can now target one zone (zone_id). A row without zone_id is for
-- every zone. The drain:
-- - purges fast zones on every claim (rows without zone_id or for that zone);
-- - never calls a slow (Free-plan) zone inline: rows without zone_id are
--   requeued for it on the next shared slot (slot_seconds), so all changes of
--   a slot share one call;
-- - requeues only the failed zone's tags after a failed call, at Retry-After.
-- ack_updates_cache_purge(p_requeue) inserts those zone rows. The re-purges
-- after a first purge move to +3s / +10s / +60s / +180s: refills now read the
-- replica past Hyperdrive's query cache, so the first re-purges only cover
-- replica lag.
--
-- Deploy order (migrations before workers):
-- - this SQL + old API worker: the old drain ignores zone_id (purges every
--   zone for a zone row: an over-purge) and acks with three arguments, which
--   resolves to the new function with p_requeue NULL;
-- - the new worker needs this SQL (four-argument ack).

ALTER TABLE public.updates_cache_purge_pending
  ADD COLUMN zone_id text;

-- Claims (leases) up to p_limit due (app, scope, zone) groups. Returns
-- {status: busy|throttled|empty|ok, wait_ms?, lease_token?,
--  apps?: [{app_id, scope, zone_id, initial}], has_more?}.
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

  -- One (app, scope) pair = one Cloudflare tag; zone_id NULL = every zone.
  WITH picked AS (
    SELECT p.app_id, p.scope, p.zone_id
    FROM public.updates_cache_purge_pending p
    WHERE p.due_at <= v_now AND (p.lease_token IS NULL OR p.leased_until <= v_now)
    GROUP BY p.app_id, p.scope, p.zone_id
    ORDER BY MIN(p.due_at)
    LIMIT GREATEST(LEAST(p_limit, 1000), 1)
  ),
  claimed AS (
    UPDATE public.updates_cache_purge_pending p
    SET lease_token = v_token, leased_until = v_now + v_lease
    FROM picked
    WHERE p.app_id = picked.app_id
      AND p.scope = picked.scope
      AND p.zone_id IS NOT DISTINCT FROM picked.zone_id
      AND p.due_at <= v_now
      AND (p.lease_token IS NULL OR p.leased_until <= v_now)
    RETURNING p.app_id, p.scope, p.zone_id, p.initial
  )
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('app_id', c.app_id, 'scope', c.scope, 'zone_id', c.zone_id, 'initial', c.initial))
  INTO v_apps
  FROM (SELECT app_id, scope, zone_id, bool_or(initial) AS initial FROM claimed GROUP BY app_id, scope, zone_id) AS c;

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

-- A new trailing parameter makes a new overload: drop the old one so calls
-- with three named arguments resolve to the function below.
DROP FUNCTION IF EXISTS public.ack_updates_cache_purge(uuid, boolean, integer);

-- Settles a lease.
-- Success: delete the leased rows, schedule re-purges (+3s / +10s / +60s /
-- +180s, every zone, same scope) for the pairs whose first purge this was, and
-- insert the per-zone rows of p_requeue: [{app_id, scope, zone_id,
-- delay_seconds, slot_seconds}]. A row is due after delay_seconds, rounded up
-- to the next multiple of slot_seconds (epoch based) when slot_seconds > 0, so
-- all rows of a slow zone in one window share one call.
-- Failure: release the rows, due again after the Retry-After.
CREATE OR REPLACE FUNCTION public.ack_updates_cache_purge(
  p_lease_token uuid,
  p_success boolean,
  p_retry_after_seconds integer DEFAULT 5,
  p_requeue jsonb DEFAULT NULL
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
      RETURNING app_id, scope, zone_id, initial
    )
    INSERT INTO public.updates_cache_purge_pending (app_id, scope, due_at, initial)
    SELECT pairs.app_id, pairs.scope, v_now + delays.delay, false
    FROM (SELECT DISTINCT app_id, scope FROM done WHERE initial AND zone_id IS NULL) AS pairs
    CROSS JOIN (VALUES
      (interval '3 seconds'), (interval '10 seconds'), (interval '60 seconds'), (interval '180 seconds')
    ) AS delays (delay);

    IF pg_catalog.jsonb_typeof(p_requeue) = 'array' THEN
      INSERT INTO public.updates_cache_purge_pending (app_id, scope, zone_id, due_at, initial)
      SELECT DISTINCT r.app_id, r.scope, r.zone_id,
        CASE WHEN r.slot > 0
          THEN pg_catalog.to_timestamp(CEIL(EXTRACT(EPOCH FROM r.due) / r.slot) * r.slot)
          ELSE r.due
        END,
        false
      FROM (
        SELECT q.app_id,
          COALESCE(q.scope, 'app') AS scope,
          q.zone_id,
          v_now + pg_catalog.make_interval(secs => GREATEST(LEAST(COALESCE(q.delay_seconds, 0), 300), 0)) AS due,
          GREATEST(LEAST(COALESCE(q.slot_seconds, 0), 300), 0) AS slot
        FROM pg_catalog.jsonb_to_recordset(p_requeue) AS q (app_id text, scope text, zone_id text, delay_seconds integer, slot_seconds integer)
        LIMIT 10000
      ) AS r
      WHERE r.app_id IS NOT NULL AND r.app_id <> ''
        AND r.scope IN ('app', 'versions')
        AND r.zone_id ~ '^[0-9a-f]{32}$';
    END IF;
  ELSE
    UPDATE public.updates_cache_purge_pending
    SET lease_token = NULL,
        leased_until = NULL,
        due_at = v_now + pg_catalog.make_interval(secs => GREATEST(LEAST(p_retry_after_seconds, 300), 1))
    WHERE lease_token = p_lease_token;
  END IF;
END;
$$;

ALTER FUNCTION public.ack_updates_cache_purge(uuid, boolean, integer, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ack_updates_cache_purge(uuid, boolean, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ack_updates_cache_purge(uuid, boolean, integer, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ack_updates_cache_purge(uuid, boolean, integer, jsonb) TO service_role;
