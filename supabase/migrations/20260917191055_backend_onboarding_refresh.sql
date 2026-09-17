-- Operational leases keep producer retries from duplicating app work. Expired
-- leases are replaced after 30 minutes; stale message tokens cannot write.
CREATE TABLE public.app_onboarding_refresh_jobs (
    app_id varchar(255) PRIMARY KEY REFERENCES public.apps (
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

SELECT pgmq.create('cron_onboarding_refresh');
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
    ), numbered AS (
      SELECT app_id, (pg_catalog.row_number() OVER (ORDER BY app_id) - 1) / 20 AS batch FROM candidates
    )
    SELECT pg_catalog.array_agg(app_id ORDER BY app_id) AS app_ids FROM numbered GROUP BY batch ORDER BY batch
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
    task_type = 'queue', target = 'cron_onboarding_refresh',
    payload
    = '{
        "function_name":"cron_onboarding_refresh",
        "function_type":"cloudflare"
    }'::jsonb,
    minute_interval = 10, second_interval = null, hour_interval = null,
    run_at_hour = null, run_at_minute = null, batch_size = null, enabled = true,
    description
    = 'Enqueue backend onboarding refresh producer every 10 minutes',
    updated_at = now()
WHERE name = 'refresh_app_onboarding_progress';
INSERT INTO public.cron_tasks (
    name, task_type, target, batch_size, minute_interval, description
)
VALUES
(
    'onboarding_refresh_producer_queue',
    'function_queue',
    '["cron_onboarding_refresh"]',
    1,
    1,
    'Consume one onboarding producer per minute'
),
(
    'onboarding_refresh_apps_queue',
    'function_queue',
    '["cron_onboarding_refresh_apps"]',
    15,
    1,
    'Consume 15 batches of 20 apps per minute (300 apps maximum)'
);

CREATE OR REPLACE FUNCTION public.process_all_cron_tasks() RETURNS void
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  current_hour int;
  current_minute int;
  current_second int;
  current_dow int;
  current_day int;
  task RECORD;
  queue_names text[];
  should_run boolean;
  lock_acquired boolean;
BEGIN
  lock_acquired := pg_catalog.pg_try_advisory_lock(1);

  IF NOT lock_acquired THEN
    RAISE NOTICE 'process_all_cron_tasks: skipped, another instance is already running';
    RETURN;
  END IF;

  BEGIN
    current_hour := EXTRACT(HOUR FROM NOW());
    current_minute := EXTRACT(MINUTE FROM NOW());
    current_second := EXTRACT(SECOND FROM NOW());
    current_dow := EXTRACT(DOW FROM NOW());
    current_day := EXTRACT(DAY FROM NOW());

    FOR task IN SELECT * FROM public.cron_tasks WHERE enabled = true ORDER BY id LOOP
      should_run := false;

      IF task.second_interval IS NOT NULL THEN
        should_run := true;
      ELSIF task.minute_interval IS NOT NULL THEN
        should_run := (current_minute % task.minute_interval = 0)
                      AND (current_second < 10);
      ELSIF task.hour_interval IS NOT NULL THEN
        should_run := (current_hour % task.hour_interval = 0)
                      AND (current_minute = COALESCE(task.run_at_minute, 0))
                      AND (current_second < 10);
      ELSIF task.run_at_hour IS NOT NULL THEN
        should_run := (current_hour = task.run_at_hour)
                      AND (current_minute = COALESCE(task.run_at_minute, 0))
                      AND (current_second < 10);

        IF should_run AND task.run_on_dow IS NOT NULL THEN
          should_run := (current_dow = task.run_on_dow);
        END IF;

        IF should_run AND task.run_on_day IS NOT NULL THEN
          should_run := (current_day = task.run_on_day);
        END IF;
      END IF;

      IF should_run THEN
        BEGIN
          CASE task.task_type
            WHEN 'function' THEN
              EXECUTE 'SELECT ' || task.target;

            WHEN 'queue' THEN
              IF task.name = 'refresh_app_onboarding_progress' AND EXISTS (SELECT 1 FROM pgmq.q_cron_onboarding_refresh) THEN
                CONTINUE;
              END IF;
              PERFORM pgmq.send(
                task.target,
                COALESCE(task.payload, jsonb_build_object('function_name', task.target))
              );

            WHEN 'function_queue' THEN
              SELECT array_agg(value::text) INTO queue_names
              FROM jsonb_array_elements_text(task.target::jsonb);

              IF task.batch_size IS NOT NULL THEN
                PERFORM public.process_function_queue(queue_names, task.batch_size);
              ELSE
                PERFORM public.process_function_queue(queue_names);
              END IF;
          END CASE;
        EXCEPTION
          WHEN query_canceled THEN
            RAISE WARNING 'cron task "%" canceled (timeout): %', task.name, SQLERRM;
          WHEN OTHERS THEN
            RAISE WARNING 'cron task "%" failed: %', task.name, SQLERRM;
        END;
      END IF;
    END LOOP;

    IF current_minute % 5 = 0 AND current_second < 10 THEN
      PERFORM pgmq.send(
        'cron_rollout_auto_pause',
        jsonb_build_object(
          'function_name', 'cron_rollout_auto_pause',
          'function_type', 'cloudflare'
        )
      );
    END IF;

    PERFORM public.process_function_queue(ARRAY['cron_rollout_auto_pause']);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.pg_advisory_unlock(1);
    RAISE;
  END;

  PERFORM pg_catalog.pg_advisory_unlock(1);
END;
$$;


ALTER FUNCTION public.process_all_cron_tasks() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_all_cron_tasks() FROM public;
GRANT EXECUTE ON FUNCTION public.process_all_cron_tasks() TO service_role;

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
  onboarding_queue boolean := queue_name IN ('cron_onboarding_refresh', 'cron_onboarding_refresh_apps');
BEGIN
  EXECUTE pg_catalog.format('SELECT count(*) FROM pgmq.%I', 'q_' || queue_name)
  INTO queue_size;

  IF queue_size > 0 THEN
    IF onboarding_queue THEN
      batch_size := LEAST(batch_size, CASE WHEN queue_name = 'cron_onboarding_refresh' THEN 1 ELSE 15 END);
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
