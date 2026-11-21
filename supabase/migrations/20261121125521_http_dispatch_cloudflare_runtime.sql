-- Let a routed dispatch target run on the Cloudflare API worker instead of a
-- Supabase Edge Function.
--
-- 20261027220420 moved routed wakeups from pg_net to http_dispatch_outbox,
-- drained by the QueueDispatcher Durable Object, but every row still carries
-- the Supabase function URL (get_db_url() || '/functions/v1/...'). So the
-- Durable Object called the Supabase queue_consumer, which then called the
-- Cloudflare trigger for every message (and the cache purge and plugin state
-- wakes were forwarded back to Cloudflare by Supabase).
--
-- runtime = 'cloudflare' removes the Supabase hop:
--   * queue wakeups (process_function_queue) are not returned by the claim:
--     it reads the readable pgmq messages and sends their ids to Cloudflare
--     Queues, whose consumer runs the same queue processing on the API worker
--     (supabase/functions/_backend/triggers/queue_relay.ts). pgmq stays the
--     queue and the retry counter.
--   * other wakeups (updates_cache_purge, plugin_state_sync) are sent to the
--     same route on the API worker (CLOUDFLARE_FUNCTION_URL).
--
-- Self-host, local and CI have no http_dispatch_targets rows, so they keep
-- calling the Supabase functions through pg_net exactly as before. Existing
-- rows default to 'supabase'; switching a target and back is one UPDATE:
--   UPDATE public.http_dispatch_targets SET runtime = 'cloudflare' WHERE target = 'on_app_update';
-- An exact target overrides '*'.

ALTER TABLE public.http_dispatch_targets
ADD COLUMN runtime text NOT NULL DEFAULT 'supabase'
CHECK (runtime IN ('supabase', 'cloudflare'));

COMMENT ON COLUMN public.http_dispatch_targets.runtime IS
'Where the dispatcher runs this target: supabase (the stored Edge Function URL) or cloudflare (the API worker; queue wakeups go through Cloudflare Queues).';

-- The outbox is UNLOGGED and holds only pending wakeups, so adding a
-- constant-default column is a metadata-only change.
ALTER TABLE public.http_dispatch_outbox
ADD COLUMN runtime text NOT NULL DEFAULT 'supabase'
CHECK (runtime IN ('supabase', 'cloudflare'));

COMMENT ON COLUMN public.http_dispatch_outbox.runtime IS
'Copied from http_dispatch_targets when the wakeup is written.';

-- Same as 20261027220420, plus the runtime of the matching target. Runs once
-- per wakeup (pg_cron tick or business write that wakes the cache purge);
-- http_dispatch_targets holds a handful of rows keyed by target.
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
DECLARE
  v_runtime text;
BEGIN
  IF p_calls < 1 THEN
    RETURN;
  END IF;

  SELECT t.runtime
  INTO v_runtime
  FROM public.http_dispatch_targets t
  WHERE t.target IN (p_target, '*')
  ORDER BY t.target = '*'
  LIMIT 1;

  IF FOUND THEN
    INSERT INTO public.http_dispatch_outbox (target, url, body, timeout_ms, calls, runtime)
    VALUES (p_target, p_url, p_body, p_timeout_ms, p_calls, v_runtime);
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
