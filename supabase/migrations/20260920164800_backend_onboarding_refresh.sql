-- Scheduling state lives alongside the existing feature ledger. Never-queued
-- apps sort first; a stuck message can be re-enqueued after 30 minutes.
CREATE INDEX idx_apps_onboarding_queued_refresh_at
ON public.apps (
  (coalesce(onboarding->>'queued_refresh_at', '')),
  (coalesce(onboarding->>'refreshed_at', '')),
  app_id
);

SELECT pgmq.create('cron_onboarding_refresh_apps');

CREATE OR REPLACE FUNCTION public.enqueue_app_onboarding_refreshes(
    p_limit integer DEFAULT 500
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_batch record;
  v_queued_at text := pg_catalog.to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_total integer := 0;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 500), 500));
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('app_onboarding_refresh_producer')) THEN
    RETURN 0;
  END IF;
  FOR v_batch IN
    WITH candidates AS MATERIALIZED (
      SELECT a.app_id, a.onboarding->>'queued_refresh_at' AS queued_at
      FROM public.apps a
      WHERE COALESCE(a.onboarding->>'refreshed_at', '') < pg_catalog.to_char((now() - interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND (
          COALESCE(a.onboarding->>'queued_refresh_at', '') <= COALESCE(a.onboarding->>'refreshed_at', '')
          OR a.onboarding->>'queued_refresh_at' < pg_catalog.to_char((now() - interval '30 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        AND COALESCE((
          SELECT si.status = 'succeeded' OR si.trial_at > now()
            OR EXISTS (
              SELECT 1 FROM public.usage_credit_grants g
              WHERE g.org_id = a.owner_org AND g.expires_at >= now()
                AND g.credits_total > g.credits_consumed
            )
          FROM public.orgs o
          LEFT JOIN public.stripe_info si ON si.customer_id = o.customer_id
          WHERE o.id = a.owner_org
        ), false)
      ORDER BY COALESCE(a.onboarding->>'queued_refresh_at', ''), COALESCE(a.onboarding->>'refreshed_at', ''), a.app_id
      LIMIT v_limit FOR UPDATE OF a SKIP LOCKED
    ),
    queued AS (
      UPDATE public.apps a
      SET onboarding = pg_catalog.jsonb_set(a.onboarding, '{queued_refresh_at}', pg_catalog.to_jsonb(v_queued_at), true)
      FROM candidates c WHERE a.app_id = c.app_id
      RETURNING a.app_id, c.queued_at
    ),
    numbered AS (
      SELECT app_id, pg_catalog.row_number() OVER (
        ORDER BY COALESCE(queued_at, ''), app_id
      ) - 1 AS ordinal FROM queued
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
REVOKE ALL ON FUNCTION public.enqueue_app_onboarding_refreshes(
    integer
) FROM public,
anon,
authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_app_onboarding_refreshes(
    integer
) TO service_role;
COMMENT ON FUNCTION public.enqueue_app_onboarding_refreshes(integer) IS
'Internal producer: at most 500 due apps from paying, trial, or credited orgs.
Updates queued_refresh_at and enqueues batches of at most 25 atomically.';

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
    4,
    1,
    'Consume 4 batches of 25 apps per minute (100 apps maximum)'
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
      batch_size := LEAST(batch_size, 4);
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
