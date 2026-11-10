ALTER TABLE public.webhooks
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'console',
  ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS mcp_event text,
  ADD COLUMN IF NOT EXISTS mcp_arguments jsonb,
  ADD COLUMN IF NOT EXISTS mcp_verified_at timestamp with time zone;

ALTER TABLE public.webhooks
  DROP CONSTRAINT IF EXISTS webhooks_source_check;

ALTER TABLE public.webhooks
  ADD CONSTRAINT webhooks_source_check CHECK (source = ANY (ARRAY['console'::text, 'mcp'::text]));

COMMENT ON COLUMN public.webhooks.source IS 'console = dashboard webhooks; mcp = MCP Events subscriptions.';

CREATE INDEX IF NOT EXISTS webhooks_mcp_active_org_idx
  ON public.webhooks (org_id)
  WHERE source = 'mcp' AND enabled = true;

CREATE OR REPLACE FUNCTION public.cleanup_expired_mcp_webhooks() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  DELETE FROM public.webhooks AS w
  WHERE w.source = 'mcp'
    AND w.expires_at IS NOT NULL
    AND w.expires_at < pg_catalog.now();
END;
$$;

ALTER FUNCTION public.cleanup_expired_mcp_webhooks() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.cleanup_expired_mcp_webhooks() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cleanup_expired_mcp_webhooks() TO service_role;

INSERT INTO public.cron_tasks (name, description, task_type, target, minute_interval, enabled)
SELECT
  'cleanup_expired_mcp_webhooks',
  'Delete expired MCP event subscriptions',
  'function',
  'public.cleanup_expired_mcp_webhooks()',
  5,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM public.cron_tasks AS t WHERE t.name = 'cleanup_expired_mcp_webhooks'
);
