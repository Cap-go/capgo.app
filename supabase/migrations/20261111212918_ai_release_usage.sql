-- Aggregate operational counts only: never persist prompts, source, or AI responses.
CREATE TABLE public.ai_release_usage_daily (
  day date NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  requests bigint NOT NULL DEFAULT 0 CHECK (requests >= 0),
  successes bigint NOT NULL DEFAULT 0 CHECK (successes >= 0),
  failures bigint NOT NULL DEFAULT 0 CHECK (failures >= 0),
  changelog_requests bigint NOT NULL DEFAULT 0 CHECK (changelog_requests >= 0),
  PRIMARY KEY (day, org_id, app_id),
  CHECK (successes + failures <= requests),
  CHECK (changelog_requests <= requests)
);
ALTER TABLE public.ai_release_usage_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_release_usage_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_release_usage_daily TO service_role;
COMMENT ON TABLE public.ai_release_usage_daily IS 'AI release recommendation attempts by UTC day. Requests minus successes and failures are unfinished or interrupted attempts. No prompt or response retention.';

-- Bounded history lookup for a single app; also includes occupied deleted names.
CREATE INDEX IF NOT EXISTS app_versions_app_id_id_desc_idx ON public.app_versions (app_id, id DESC);
