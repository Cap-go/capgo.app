-- Queue wakeups go only through the outbox now: drop pg_net.
--
-- Since 20261027220420_durable_object_http_dispatch, http_dispatch_post()
-- either called net.http_post or, for targets listed in http_dispatch_targets,
-- wrote to http_dispatch_outbox for the QueueDispatcher Durable Object in the API
-- worker. Capgo Cloud has routed every target ('*') to the outbox since
-- 2026-10-27, and local dev and CI run the same dispatcher
-- (scripts/local-queue-dispatcher.ts). pg_net is a Supabase-only extension, so
-- it goes: every install now needs the API worker's QueueDispatcher to drain
-- the outbox.
--
-- pgmq is unchanged: only the HTTP wakeup that tells a consumer to run moved.

-- Same signature, so callers (process_function_queue, wake_updates_cache_purge,
-- wake_plugin_state_sync) stay as they are. p_headers is no longer used: the
-- dispatcher attaches its own API secret, so the secret is never stored.
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

  INSERT INTO public.http_dispatch_outbox (target, url, body, timeout_ms, calls)
  VALUES (p_target, p_url, p_body, p_timeout_ms, p_calls);
END;
$$;

ALTER FUNCTION public.http_dispatch_post(text, text, jsonb, jsonb, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.http_dispatch_post(text, text, jsonb, jsonb, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.http_dispatch_post(text, text, jsonb, jsonb, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.http_dispatch_post(text, text, jsonb, jsonb, integer, integer) TO service_role;

-- The routing switch has nothing left to switch.
DROP TABLE public.http_dispatch_targets;

-- Hourly truncate of pg_net's response table (20260722082019_fix_supabase_swap_memory).
DELETE FROM public.cron_tasks WHERE name = 'cleanup_net_http_response';
DROP FUNCTION public.cleanup_net_http_response();

-- No CASCADE: if anything still depends on pg_net, this migration fails
-- instead of silently dropping it.
DROP EXTENSION IF EXISTS pg_net;
