-- Ordered after 20261119180122 and 20261118170054_plugin_state_eu_source.
SET LOCAL lock_timeout = '2s';

ALTER TABLE public.webhooks
  ADD COLUMN IF NOT EXISTS mcp_spike_last_fired_at timestamp with time zone;

COMMENT ON COLUMN public.webhooks.mcp_spike_last_fired_at IS 'Last dispatch time for update.failure_spike MCP subscriptions (cooldown).';

SELECT pgmq.create('cron_mcp_failure_spike');

INSERT INTO private.settings (name, value)
VALUES ('MCP_FAILURE_SPIKE_GROUP_CURSOR', '0')
ON CONFLICT (name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.mcp_failure_spike_group_cursor_get()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT "private"."settings".value::integer
    FROM "private"."settings"
    WHERE "private"."settings".name = 'MCP_FAILURE_SPIKE_GROUP_CURSOR'
  ), 0);
$$;

CREATE OR REPLACE FUNCTION public.mcp_failure_spike_group_cursor_advance(
  p_processed integer,
  p_group_count integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cursor integer;
  v_next integer;
BEGIN
  IF p_group_count IS NULL OR p_group_count <= 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO "private"."settings" (name, value)
  VALUES ('MCP_FAILURE_SPIKE_GROUP_CURSOR', '0')
  ON CONFLICT (name) DO NOTHING;

  SELECT COALESCE((
    SELECT "private"."settings".value::integer
    FROM "private"."settings"
    WHERE "private"."settings".name = 'MCP_FAILURE_SPIKE_GROUP_CURSOR'
  ), 0)
  INTO v_cursor;

  v_next := (v_cursor + GREATEST(COALESCE(p_processed, 0), 0)) % p_group_count;

  UPDATE "private"."settings"
  SET
    value = v_next::text,
    updated_at = pg_catalog.now()
  WHERE name = 'MCP_FAILURE_SPIKE_GROUP_CURSOR';

  RETURN v_next;
END;
$$;

ALTER FUNCTION public.mcp_failure_spike_group_cursor_get() OWNER TO postgres;
ALTER FUNCTION public.mcp_failure_spike_group_cursor_advance(integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mcp_failure_spike_group_cursor_get() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mcp_failure_spike_group_cursor_advance(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mcp_failure_spike_group_cursor_get() FROM anon;
REVOKE ALL ON FUNCTION public.mcp_failure_spike_group_cursor_get() FROM authenticated;
REVOKE ALL ON FUNCTION public.mcp_failure_spike_group_cursor_advance(integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.mcp_failure_spike_group_cursor_advance(integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_failure_spike_group_cursor_get() TO service_role;
GRANT EXECUTE ON FUNCTION public.mcp_failure_spike_group_cursor_advance(integer, integer) TO service_role;

INSERT INTO public.cron_tasks (
    name,
    description,
    task_type,
    target,
    payload,
    minute_interval,
    enabled
)
VALUES (
    'mcp_failure_spike',
    'Enqueue MCP update.failure_spike evaluations',
    'queue',
    'cron_mcp_failure_spike',
    pg_catalog.jsonb_build_object(
        'function_name', 'cron_mcp_failure_spike',
        'function_type', 'cloudflare'
    ),
    5,
    true
)
ON CONFLICT (name) DO UPDATE
SET
    description = EXCLUDED.description,
    task_type = EXCLUDED.task_type,
    target = EXCLUDED.target,
    payload = EXCLUDED.payload,
    minute_interval = EXCLUDED.minute_interval,
    enabled = true,
    updated_at = pg_catalog.now();

INSERT INTO public.cron_tasks (
    name,
    task_type,
    target,
    batch_size,
    minute_interval,
    description
)
VALUES (
    'mcp_failure_spike_queue',
    'function_queue',
    '["cron_mcp_failure_spike"]',
    NULL,
    5,
    'Process MCP update.failure_spike spike evaluations'
)
ON CONFLICT (name) DO UPDATE
SET
    task_type = EXCLUDED.task_type,
    target = EXCLUDED.target,
    batch_size = EXCLUDED.batch_size,
    minute_interval = EXCLUDED.minute_interval,
    description = EXCLUDED.description,
    enabled = true,
    updated_at = pg_catalog.now();