-- Count only messages a consumer can read now. Messages still inside their
-- visibility timeout are being processed by an earlier call, so counting them
-- made the dispatcher fire up to 10 consumer calls that read nothing.
-- pgmq queue tables index vt, so the bound cutoff keeps this an index range scan.
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
  awaited_queue boolean := queue_name = 'cron_onboarding_refresh_apps';
BEGIN
  -- Bind the cutoff as a parameter: clock_timestamp() is volatile, so inline
  -- it would be re-evaluated per row and could not bound the vt index scan.
  EXECUTE pg_catalog.format(
    'SELECT count(*) FROM pgmq.%I WHERE vt <= $1',
    'q_' || queue_name
  )
  INTO queue_size
  USING pg_catalog.clock_timestamp();

  IF queue_size > 0 THEN
    IF onboarding_queue THEN
      batch_size := LEAST(batch_size, 4);
    END IF;
    headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'apisecret', public.get_apikey()
    );
    request_timeout_ms := CASE
      WHEN awaited_queue THEN 100000
      WHEN queue_name = 'on_manifest_create' THEN 60000
      ELSE 8000
    END;
    url := public.get_db_url() || '/functions/v1/triggers/queue_consumer/sync';

    calls_needed := LEAST(
      pg_catalog.ceil(queue_size / batch_size::double precision)::int,
      10
    );

    IF awaited_queue THEN
      calls_needed := 1;
    END IF;

    FOR i IN 1..calls_needed LOOP
      PERFORM net.http_post(
        url := url,
        headers := headers,
        body := pg_catalog.jsonb_build_object(
          'queue_name', queue_name,
          'batch_size', batch_size,
          'wait_for_completion', awaited_queue
        ),
        timeout_milliseconds := request_timeout_ms
      );
    END LOOP;
  END IF;
END;
$$;

ALTER FUNCTION public.process_function_queue(text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_function_queue(text, integer) FROM PUBLIC;
