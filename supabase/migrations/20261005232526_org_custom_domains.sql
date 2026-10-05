CREATE TABLE public.org_custom_domains (
  org_id uuid PRIMARY KEY REFERENCES public.orgs(id) ON DELETE RESTRICT,
  hostname text NOT NULL UNIQUE,
  provider_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_custom_domains_hostname CHECK (hostname = lower(hostname) AND length(hostname) <= 253)
);
ALTER TABLE public.org_custom_domains OWNER TO postgres;
ALTER TABLE public.org_custom_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.org_custom_domains FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.org_custom_domains TO service_role;
CREATE POLICY "Deny client select" ON public.org_custom_domains FOR SELECT TO anon, authenticated USING (false);
CREATE POLICY "Deny client insert" ON public.org_custom_domains FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY "Deny client update" ON public.org_custom_domains FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "Deny client delete" ON public.org_custom_domains FOR DELETE TO anon, authenticated USING (false);
COMMENT ON TABLE public.org_custom_domains IS 'Provider-managed Live Updates hostnames. Private API checks org.update_settings before indexed service-role access.';
