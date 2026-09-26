CREATE TABLE public.app_onboarding (
    app_id varchar PRIMARY KEY REFERENCES public.apps (
        app_id
    ) ON DELETE CASCADE,
    queued_refresh_at timestamptz,
    refreshed_at timestamptz
);

ALTER TABLE public.app_onboarding OWNER TO postgres;
ALTER TABLE public.app_onboarding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_onboarding FROM public, anon, authenticated;
GRANT ALL ON TABLE public.app_onboarding TO service_role;

COMMENT ON TABLE public.app_onboarding IS $comment$
Primary-only scheduling state for the app onboarding refresh queue.
This table must not be added to the Google Cloud SQL replication publication.
$comment$;
COMMENT ON COLUMN public.app_onboarding.queued_refresh_at IS
'When the latest onboarding refresh batch was enqueued.';
COMMENT ON COLUMN public.app_onboarding.refreshed_at IS
'When onboarding feature signals were last refreshed by the queue consumer.';

CREATE INDEX app_onboarding_refresh_schedule_idx
ON public.app_onboarding (
    queued_refresh_at NULLS FIRST,
    refreshed_at NULLS FIRST,
    app_id
);

-- Copy only the two queue checkpoints. Apps without either checkpoint must not
-- get a row until a producer or an already-scheduled consumer touches them.
INSERT INTO public.app_onboarding (app_id, queued_refresh_at, refreshed_at)
SELECT
    app_id,
    CASE
        WHEN onboarding ? 'queued_refresh_at'
            THEN (onboarding ->> 'queued_refresh_at')::timestamptz
    END AS queued_refresh_at,
    CASE
        WHEN onboarding ? 'refreshed_at'
            THEN (onboarding ->> 'refreshed_at')::timestamptz
    END AS refreshed_at
FROM public.apps
WHERE onboarding ?| ARRAY['queued_refresh_at', 'refreshed_at'];

DROP INDEX IF EXISTS public.idx_apps_onboarding_queued_refresh_at;
DROP INDEX IF EXISTS public.idx_apps_onboarding_refreshed_at;

CREATE OR REPLACE FUNCTION public.enqueue_app_onboarding_refreshes(
    p_limit integer DEFAULT 500
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_batch record;
  v_queued_at text := pg_catalog.to_char((pg_catalog.now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_total integer := 0;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 500), 500));
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('app_onboarding_refresh_producer')) THEN
    RETURN 0;
  END IF;
  FOR v_batch IN
    WITH eligible_orgs AS MATERIALIZED (
      SELECT o.id
      FROM public.orgs o
      LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
      WHERE si.status = 'succeeded'
        OR si.trial_at > pg_catalog.now()
        OR EXISTS (
          SELECT 1 FROM public.usage_credit_grants g
          WHERE g.org_id = o.id AND g.expires_at >= pg_catalog.now()
            AND g.credits_total > g.credits_consumed
        )
    ), candidates AS MATERIALIZED (
      SELECT a.app_id
      FROM eligible_orgs eligible
      JOIN public.apps a ON a.owner_org = eligible.id
      LEFT JOIN public.app_onboarding state ON state.app_id = a.app_id
      WHERE (state.refreshed_at IS NULL OR state.refreshed_at < pg_catalog.now() - interval '10 minutes')
        AND (
          state.queued_refresh_at IS NULL
          OR state.queued_refresh_at <= state.refreshed_at
          OR state.queued_refresh_at < pg_catalog.now() - interval '30 minutes'
        )
      ORDER BY state.queued_refresh_at NULLS FIRST,
        state.refreshed_at NULLS FIRST, a.app_id
      LIMIT v_limit FOR UPDATE OF a SKIP LOCKED
    ),
    queued AS (
      INSERT INTO public.app_onboarding (app_id, queued_refresh_at)
      SELECT app_id, v_queued_at::timestamptz FROM candidates
      ON CONFLICT (app_id) DO UPDATE
      SET queued_refresh_at = EXCLUDED.queued_refresh_at
      RETURNING app_id
    ),
    numbered AS (
      SELECT app_id, pg_catalog.row_number() OVER (ORDER BY app_id) - 1 AS ordinal
      FROM queued
    ), batches AS (
      SELECT app_id, ordinal / 25 AS batch FROM numbered
    )
    SELECT pg_catalog.array_agg(app_id ORDER BY app_id) AS app_ids
    FROM batches GROUP BY batch ORDER BY batch
  LOOP
    PERFORM pgmq.send('cron_onboarding_refresh_apps', pg_catalog.jsonb_build_object(
      'function_name', 'cron_onboarding_refresh_apps', 'function_type', 'cloudflare',
      'payload', pg_catalog.jsonb_build_object('appIds', v_batch.app_ids, 'queuedAt', v_queued_at)));
    v_total := v_total + pg_catalog.cardinality(v_batch.app_ids);
  END LOOP;
  RETURN v_total;
END;
$$;

ALTER FUNCTION public.enqueue_app_onboarding_refreshes(
    integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_app_onboarding_refreshes(integer)
FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_app_onboarding_refreshes(integer)
TO service_role;
COMMENT ON FUNCTION public.enqueue_app_onboarding_refreshes(integer) IS
$comment$
Internal producer: at most 500 due apps from paying, trial, or credited orgs.
Upserts app_onboarding.queued_refresh_at and enqueues batches of at most 25
atomically.
$comment$;
