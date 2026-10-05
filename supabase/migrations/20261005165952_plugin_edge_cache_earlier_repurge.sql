-- Plugin edge cache purge: earlier re-purges.
--
-- Edge cache refills now read the replica past Hyperdrive's query cache, which
-- used to serve pre-change rows for up to 75s after a purge. Only replica lag
-- (seconds) is left to cover, so the re-purges after a first purge move from
-- +10s / +60s / +180s to +3s / +10s / +60s / +180s. Same signature: workers
-- are unaffected.

-- Settles a lease. Success: delete the leased rows and schedule re-purges
-- (+3s / +10s / +60s / +180s from now, same scope) for the pairs whose first
-- purge this was. Failure: release the rows, due again after the Retry-After.
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
      (interval '3 seconds'), (interval '10 seconds'), (interval '60 seconds'), (interval '180 seconds')
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
