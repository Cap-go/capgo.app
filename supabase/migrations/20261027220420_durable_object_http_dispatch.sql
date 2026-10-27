-- Route database-originated HTTP wakeups (queue consumer calls, the updates
-- cache purge wake) through either pg_net or an outbox drained by a Cloudflare
-- Durable Object.
--
-- Self-hosted and local installs keep pg_net: http_dispatch_targets is empty by
-- default, so http_dispatch_post() calls net.http_post exactly as before.
-- Capgo Cloud inserts targets (a queue name, or '*' for every target) to move
-- them to the outbox; the QueueDispatcher Durable Object in the API worker
-- claims rows every second and sends the same requests. Deleting the rows
-- rolls back to pg_net.
--
-- pgmq itself is unchanged: triggers still enqueue in the writing transaction,
-- and the consumer still reads and deletes pgmq messages. Only the wakeup that
-- tells the consumer to run moves out of the database.

CREATE TABLE public.http_dispatch_targets (
  target text PRIMARY KEY CHECK (target <> ''),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.http_dispatch_targets IS
'Dispatch targets (queue names, or * for all) whose HTTP wakeups go to http_dispatch_outbox instead of pg_net.';

ALTER TABLE public.http_dispatch_targets OWNER TO postgres;
ALTER TABLE public.http_dispatch_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all direct access"
ON public.http_dispatch_targets
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
REVOKE ALL ON TABLE public.http_dispatch_targets FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.http_dispatch_targets TO service_role;

-- Unlogged: rows are wakeups, not work. Work stays in pgmq, so a crash that
-- empties this table only delays consumers until the next cron tick re-requests
-- the wakeup, and skipping WAL keeps the per-tick churn off replication.
CREATE UNLOGGED TABLE public.http_dispatch_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target text NOT NULL,
  url text NOT NULL,
  body jsonb NOT NULL,
  timeout_ms integer NOT NULL CHECK (timeout_ms > 0),
  calls integer NOT NULL CHECK (calls > 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  -- Identical pending wakeups coalesce, so a dispatcher outage leaves one row
  -- per target instead of a backlog that would burst on recovery.
  CONSTRAINT http_dispatch_outbox_request_key UNIQUE (target, url, body)
);

COMMENT ON TABLE public.http_dispatch_outbox IS
'Pending HTTP wakeups claimed (DELETE ... RETURNING) by the QueueDispatcher Durable Object.';

ALTER TABLE public.http_dispatch_outbox OWNER TO postgres;
ALTER TABLE public.http_dispatch_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all direct access"
ON public.http_dispatch_outbox
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
REVOKE ALL ON TABLE public.http_dispatch_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.http_dispatch_outbox TO service_role;

-- Send calls identical POSTs to url. Headers are only used by pg_net: the
-- Durable Object adds its own API secret, so the secret is never stored in the
-- outbox.
CREATE OR REPLACE FUNCTION public.http_dispatch_post(
  "p_target" text,
  "p_url" text,
  "p_headers" jsonb,
  "p_body" jsonb,
  "p_timeout_ms" integer,
  "p_calls" integer DEFAULT 1
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_calls < 1 THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.http_dispatch_targets t
    WHERE t.target IN (p_target, '*')
  ) THEN
    INSERT INTO public.http_dispatch_outbox AS o (target, url, body, timeout_ms, calls)
    VALUES (p_target, p_url, p_body, p_timeout_ms, p_calls)
    ON CONFLICT ON CONSTRAINT http_dispatch_outbox_request_key DO UPDATE
    SET
      calls = GREATEST(o.calls, excluded.calls),
      timeout_ms = GREATEST(o.timeout_ms, excluded.timeout_ms);
    RETURN;
  END IF;

  FOR i IN 1..p_calls LOOP
    PERFORM net.http_post(
      url := p_url,
      headers := p_headers,
      body := p_body,
      timeout_milliseconds := p_timeout_ms
    );
  END LOOP;
END;
$$;

ALTER FUNCTION public.http_dispatch_post(text, text, jsonb, jsonb, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.http_dispatch_post(text, text, jsonb, jsonb, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.http_dispatch_post(text, text, jsonb, jsonb, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.http_dispatch_post(text, text, jsonb, jsonb, integer, integer) TO service_role;

-- Same as 20261026143702_queue_dispatch_readable_count, with the consumer
-- calls sent through http_dispatch_post.
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

    PERFORM public.http_dispatch_post(
      p_target := queue_name,
      p_url := url,
      p_headers := headers,
      p_body := pg_catalog.jsonb_build_object(
        'queue_name', queue_name,
        'batch_size', batch_size,
        'wait_for_completion', awaited_queue
      ),
      p_timeout_ms := request_timeout_ms,
      p_calls := calls_needed
    );
  END IF;
END;
$$;

ALTER FUNCTION public.process_function_queue(text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_function_queue(text, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.wake_updates_cache_purge()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.http_dispatch_post(
    p_target := 'updates_cache_purge',
    p_url := public.get_db_url() || '/functions/v1/triggers/updates_cache_purge',
    p_headers := pg_catalog.jsonb_build_object(
      'Content-Type', 'application/json',
      'apisecret', public.get_apikey()
    ),
    p_body := pg_catalog.jsonb_build_object('wake', true),
    p_timeout_ms := 5000
  );
END;
$$;

ALTER FUNCTION public.wake_updates_cache_purge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wake_updates_cache_purge() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wake_updates_cache_purge() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wake_updates_cache_purge() TO service_role;
