-- The onboarding handler now reads bounded batches from Analytics Engine after
-- refreshing PostgreSQL features. Its pg_net caller must outlive the queue
-- consumer's HTTP timeout (90s), while the pgmq visibility timeout stays 120s.
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
      WHEN onboarding_queue THEN 100000
      WHEN queue_name = 'on_manifest_create' THEN 60000
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
REVOKE ALL ON FUNCTION public.process_function_queue(text, integer) FROM PUBLIC;
