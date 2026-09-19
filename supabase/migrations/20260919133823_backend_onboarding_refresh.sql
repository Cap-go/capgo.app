-- Operational leases keep producer retries from duplicating app work. Expired
-- leases are replaced after 30 minutes; stale message tokens cannot write.
CREATE TABLE public.app_onboarding_refresh_jobs (
    app_id varchar PRIMARY KEY REFERENCES public.apps (
        app_id
    ) ON DELETE CASCADE,
    batch_token uuid NOT NULL,
    enqueued_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_onboarding_refresh_jobs OWNER TO postgres;
ALTER TABLE public.app_onboarding_refresh_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_onboarding_refresh_jobs FROM public,
anon,
authenticated;
GRANT ALL ON TABLE public.app_onboarding_refresh_jobs TO service_role;
CREATE POLICY app_onboarding_refresh_jobs_service
ON public.app_onboarding_refresh_jobs
FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY app_onboarding_refresh_jobs_deny_clients
ON public.app_onboarding_refresh_jobs
AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- These ordered owning-app indexes bound first/last lookups in the worker.
CREATE INDEX idx_app_versions_onboarding_created ON public.app_versions (
    app_id, created_at
)
WHERE deleted IS NOT true
AND name IS DISTINCT FROM 'builtin'
AND name IS DISTINCT FROM 'unknown';
CREATE INDEX idx_build_requests_onboarding_success ON public.build_requests (
    app_id, completed_at
)
WHERE status IN ('succeeded', 'released') AND completed_at IS NOT null;
CREATE INDEX idx_build_requests_onboarding_used ON public.build_requests (
    app_id, (coalesce(completed_at, created_at))
);

SELECT pgmq.create('cron_onboarding_refresh_apps');

CREATE OR REPLACE FUNCTION public.enqueue_app_onboarding_refreshes(
    p_limit integer DEFAULT 3000
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_batch record;
  v_token uuid;
  v_total integer := 0;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 3000), 3000));
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('app_onboarding_refresh_producer')) THEN
    RETURN 0;
  END IF;
  FOR v_batch IN
    WITH candidates AS MATERIALIZED (
      SELECT a.app_id
      FROM public.apps a
      WHERE COALESCE(a.onboarding->>'refreshed_at', '') < pg_catalog.to_char((now() - interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND NOT EXISTS (SELECT 1 FROM public.app_onboarding_refresh_jobs j WHERE j.app_id = a.app_id AND j.enqueued_at > now() - interval '30 minutes')
      ORDER BY COALESCE(a.onboarding->>'refreshed_at', ''), a.app_id
      LIMIT v_limit FOR UPDATE OF a SKIP LOCKED
    ),
    -- Keep unusually long IDs in single-app messages so escaped Analytics
    -- Engine filters stay within the worker's query-size budget.
    numbered AS (
      SELECT app_id,
        pg_catalog.octet_length(app_id) > 128 AS long_id,
        pg_catalog.row_number() OVER (
          PARTITION BY pg_catalog.octet_length(app_id) > 128 ORDER BY app_id
        ) - 1 AS ordinal
      FROM candidates
    ), batches AS (
      SELECT app_id, long_id,
        CASE WHEN long_id THEN ordinal ELSE ordinal / 20 END AS batch
      FROM numbered
    )
    SELECT pg_catalog.array_agg(app_id ORDER BY app_id) AS app_ids
    FROM batches GROUP BY long_id, batch ORDER BY long_id, batch
  LOOP
    v_token := pg_catalog.gen_random_uuid();
    INSERT INTO public.app_onboarding_refresh_jobs(app_id, batch_token, enqueued_at)
      SELECT app_id, v_token, now() FROM pg_catalog.unnest(v_batch.app_ids) AS ids(app_id)
      ON CONFLICT (app_id) DO UPDATE SET batch_token = EXCLUDED.batch_token, enqueued_at = EXCLUDED.enqueued_at;
    PERFORM pgmq.send('cron_onboarding_refresh_apps', pg_catalog.jsonb_build_object(
      'function_name', 'cron_onboarding_refresh_apps', 'function_type', 'cloudflare',
      'payload', pg_catalog.jsonb_build_object('appIds', v_batch.app_ids, 'batchToken', v_token)));
    v_total := v_total + pg_catalog.cardinality(v_batch.app_ids);
  END LOOP;
  RETURN v_total;
END;
$$;
ALTER FUNCTION public.enqueue_app_onboarding_refreshes(
    integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_app_onboarding_refreshes(
    integer
) FROM public,
anon,
authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_app_onboarding_refreshes(
    integer
) TO service_role;
COMMENT ON FUNCTION public.enqueue_app_onboarding_refreshes(integer) IS
'Internal producer: at most 3000 oldest due apps, indexed refresh ordering
and per-app lease PK lookups. Enqueues batches of at most 20,
atomically with leases.';

-- Reuse the existing scheduler; do not add a pg_cron job.
UPDATE public.cron_tasks SET
    task_type = 'function',
    target = 'public.enqueue_app_onboarding_refreshes()',
    payload = null,
    minute_interval = 10, second_interval = null, hour_interval = null,
    run_at_hour = null, run_at_minute = null, batch_size = null, enabled = true,
    description = 'Enqueue onboarding app refresh batches every 10 minutes',
    updated_at = now()
WHERE name = 'refresh_app_onboarding_progress';

-- The scheduled batch RPC has been replaced by the SQL producer. Keep the
-- single-app refresh RPC used by verify_getting_started.
DROP FUNCTION public.refresh_app_onboarding_progress(integer);

COMMENT ON COLUMN public.apps.onboarding IS
'App onboarding state. The backend refresh worker updates feature success, usage, and stage; setup progress is stored separately under setup. Clients may only set feature started_at through mark_onboarding_feature_started.';
COMMENT ON FUNCTION public.refresh_one_app_onboarding_progress(varchar) IS
'Internal. Refreshes onboarding features for one app from devices, bundles, daily_version installs, and build_requests when Getting Started is verified. Never called from plugin request paths.';
INSERT INTO public.cron_tasks (
    name, task_type, target, batch_size, minute_interval, description
)
VALUES
(
    'onboarding_refresh_apps_queue',
    'function_queue',
    '["cron_onboarding_refresh_apps"]',
    15,
    1,
    'Consume 15 batches of 20 apps per minute (300 apps maximum)'
);

CREATE OR REPLACE FUNCTION public.process_function_queue(
    "queue_name" text, "batch_size" integer DEFAULT 950
) RETURNS void
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  calls_needed int;
  headers jsonb;
  queue_size bigint;
  request_timeout_ms int;
  url text;
  onboarding_queue boolean := queue_name = 'cron_onboarding_refresh_apps';
BEGIN
  EXECUTE pg_catalog.format('SELECT count(*) FROM pgmq.%I', 'q_' || queue_name)
  INTO queue_size;

  IF queue_size > 0 THEN
    IF onboarding_queue THEN
      batch_size := LEAST(batch_size, 15);
    END IF;
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'apisecret', public.get_apikey()
    );
    request_timeout_ms := CASE
      WHEN queue_name = 'on_manifest_create' OR onboarding_queue THEN 60000
      ELSE 8000
    END;
    url := public.get_db_url() || '/functions/v1/triggers/queue_consumer/sync';

    calls_needed := LEAST(
      pg_catalog.ceil(queue_size / batch_size::double precision)::int,
      10
    );

    IF onboarding_queue THEN
      calls_needed := 1;
    END IF;

    FOR i IN 1..calls_needed LOOP
      PERFORM net.http_post(
        url := url,
        headers := headers,
        body := pg_catalog.jsonb_build_object(
          'queue_name', queue_name,
          'batch_size', batch_size,
          'wait_for_completion', onboarding_queue
        ),
        timeout_milliseconds := request_timeout_ms
      );
    END LOOP;
  END IF;
END;
$$;


ALTER FUNCTION public.process_function_queue(text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_function_queue(text, integer) FROM public;
