-- Route GoTrue Send Email hooks through pgmq so auth mail is durable.
-- The queue consumer then emits Bento transactional events. SMTP is not used.
--
-- Execution model:
-- - Where: GoTrue Send Email hook (once per auth email). Postgres function
--   hook_send_email does O(1) pgmq.send and returns.
--   No Bento/HTTP in the hook.
-- - Frequency: once per signup / recovery / magic link / invite /
--   email change / reauthentication / security notification.
--   Auth retries the hook only if this function returns an error object.
-- - Roles: supabase_auth_admin executes the hook. The function is SECURITY
--   DEFINER (postgres) so pgmq.send does not need grants on pgmq to auth admin.
--   anon / authenticated / PUBLIC cannot execute it.
-- - Cardinality: O(1) insert into pgmq.q_send_email. No table scans.
-- - Drain: high_frequency_queues (every 10s) calls process_function_queue for
--   send_email. Failures retry up to MAX_QUEUE_READS = 5.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pgmq.list_queues()
    WHERE queue_name = 'send_email'
  ) THEN
    PERFORM pgmq.create('send_email');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.hook_send_email(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_action_type text;
  v_email text;
BEGIN
  v_email := btrim(COALESCE(event -> 'user' ->> 'email', ''));
  v_action_type := btrim(
    COALESCE(event -> 'email_data' ->> 'email_action_type', '')
  );

  IF v_email = '' THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 400,
        'message', 'Send email hook missing user email'
      )
    );
  END IF;

  IF v_action_type = '' THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 400,
        'message', 'Send email hook missing email_action_type'
      )
    );
  END IF;

  PERFORM pgmq.send(
    'send_email',
    jsonb_build_object(
      'function_name', 'send_email',
      'function_type', 'cloudflare',
      'payload', jsonb_build_object(
        'email', v_email,
        'email_action_type', v_action_type,
        'factor_type', COALESCE(event -> 'email_data' ->> 'factor_type', ''),
        'new_email', COALESCE(
          event -> 'user' ->> 'new_email',
          event -> 'email_data' ->> 'new_email',
          ''
        ),
        'old_email', COALESCE(event -> 'email_data' ->> 'old_email', ''),
        'redirect_to', COALESCE(event -> 'email_data' ->> 'redirect_to', ''),
        'site_url', COALESCE(event -> 'email_data' ->> 'site_url', ''),
        'token', COALESCE(event -> 'email_data' ->> 'token', ''),
        'token_hash', COALESCE(event -> 'email_data' ->> 'token_hash', '')
      )
    )
  );

  RETURN '{}'::jsonb;
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 500,
        'message', 'Failed to enqueue auth email'
      )
    );
END;
$$;

COMMENT ON FUNCTION public.hook_send_email(jsonb) IS
'GoTrue Send Email hook. Enqueues auth mail onto pgmq send_email.';

ALTER FUNCTION public.hook_send_email(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hook_send_email(jsonb) FROM public;
REVOKE ALL ON FUNCTION public.hook_send_email(jsonb) FROM anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.hook_send_email(jsonb) TO supabase_auth_admin;
  END IF;
END
$$;

DO $$
DECLARE
  high_frequency_task_type public.cron_task_type;
  high_frequency_target jsonb;
BEGIN
  SELECT cron.task_type, cron.target::jsonb
  INTO high_frequency_task_type, high_frequency_target
  FROM public.cron_tasks AS cron
  WHERE cron.name = 'high_frequency_queues'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Required cron task high_frequency_queues is missing';
  END IF;

  IF high_frequency_task_type
    IS DISTINCT FROM 'function_queue'::public.cron_task_type THEN
    RAISE EXCEPTION 'Cron task high_frequency_queues must use task type function_queue';
  END IF;

  IF pg_catalog.jsonb_typeof(high_frequency_target)
    IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Cron task high_frequency_queues target must be a JSON array';
  END IF;

  IF NOT (high_frequency_target ? 'send_email') THEN
    UPDATE public.cron_tasks
    SET
      target = (high_frequency_target || '["send_email"]'::jsonb)::text,
      updated_at = pg_catalog.now()
    WHERE name = 'high_frequency_queues';
  END IF;
END;
$$;
