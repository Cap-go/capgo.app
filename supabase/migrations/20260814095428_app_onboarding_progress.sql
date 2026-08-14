-- Persist how an app was onboarded (cli / mcp / ai / manual) and which CLI
-- steps finished, skipped, or switched to the web console.
ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS onboarding jsonb DEFAULT '{"source":"manual","outcome":"in_progress","steps":{}}'::jsonb NOT NULL;

ALTER TABLE public.apps
  DROP CONSTRAINT IF EXISTS apps_onboarding_valid;

ALTER TABLE public.apps
  ADD CONSTRAINT apps_onboarding_valid CHECK (
    (jsonb_typeof(onboarding) = 'object'::text)
    AND (
      NOT (onboarding ? 'source'::text)
      OR ((onboarding ->> 'source'::text) = ANY (ARRAY['manual'::text, 'cli'::text, 'mcp'::text, 'ai'::text]))
    )
    AND (
      NOT (onboarding ? 'outcome'::text)
      OR ((onboarding ->> 'outcome'::text) = ANY (ARRAY['in_progress'::text, 'completed'::text, 'skipped'::text, 'switched_to_manual'::text]))
    )
  );

COMMENT ON COLUMN public.apps.onboarding IS 'Guided onboarding progress JSON: {source: manual|cli|mcp|ai, outcome: in_progress|completed|skipped|switched_to_manual, steps: {step_id: {status: done|skipped, at: timestamptz}}}. Manual is the default when no CLI/MCP/AI trace exists.';

CREATE INDEX IF NOT EXISTS apps_created_at_onboarding_source_idx
  ON public.apps (created_at, ((onboarding ->> 'source'::text)));
