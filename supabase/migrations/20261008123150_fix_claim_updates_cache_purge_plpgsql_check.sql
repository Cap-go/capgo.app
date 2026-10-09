-- plpgsql_check treats string literals as text; use explicit interval casts.
CREATE OR REPLACE FUNCTION public.claim_updates_cache_purge(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_last timestamptz;
  v_min_interval constant interval := INTERVAL '1 second';
  v_lease interval := INTERVAL '2 minutes';
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
