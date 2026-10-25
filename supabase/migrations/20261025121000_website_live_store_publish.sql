-- Web2App store publishing: Capgo builds the store app from its template,
-- signs it with keys the customer uploads, and submits it to store review.

CREATE TABLE IF NOT EXISTS public.website_live_store_configs (
  app_id character varying(50) PRIMARY KEY REFERENCES public.apps (app_id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  app_name text,
  version_name text NOT NULL DEFAULT '1.0.0',
  icon_background_color text NOT NULL DEFAULT '#FFFFFF',
  icon_storage_prefix text,
  submit_for_review boolean NOT NULL DEFAULT true,
  updated_by uuid,
  CONSTRAINT website_live_store_configs_app_name_check CHECK (
    app_name IS NULL OR char_length(app_name) BETWEEN 1 AND 30
  ),
  CONSTRAINT website_live_store_configs_version_name_check CHECK (
    version_name ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'
  ),
  CONSTRAINT website_live_store_configs_icon_background_color_check CHECK (
    icon_background_color ~ '^#[0-9A-F]{6}$'
  )
);

COMMENT ON TABLE public.website_live_store_configs IS 'Store listing settings Capgo uses to build Web2App apps from the hosted template. One row per app.';
COMMENT ON COLUMN public.website_live_store_configs.icon_storage_prefix IS 'Path prefix in the images storage bucket holding the generated icon set (ios-1024.png, android-*.png, play-512.png, preview-256.png).';

CREATE TABLE IF NOT EXISTS public.website_live_store_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id character varying(50) NOT NULL REFERENCES public.apps (app_id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  platform text NOT NULL,
  secret_ciphertext text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  updated_by uuid,
  CONSTRAINT website_live_store_credentials_platform_check CHECK (platform IN ('ios', 'android')),
  CONSTRAINT website_live_store_credentials_app_platform_key UNIQUE (app_id, platform)
);

COMMENT ON TABLE public.website_live_store_credentials IS 'Encrypted store signing and upload keys for Web2App builds. secret_ciphertext is AES-GCM encrypted by the API; metadata only holds non-secret summaries shown in the console.';

ALTER TABLE public.website_live_store_configs OWNER TO postgres;
ALTER TABLE public.website_live_store_credentials OWNER TO postgres;

ALTER TABLE public.website_live_store_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_live_store_credentials ENABLE ROW LEVEL SECURITY;

-- Only the API reads or writes these rows, after its own RBAC check.
CREATE POLICY "Deny all website live store config access" ON public.website_live_store_configs
AS RESTRICTIVE USING (false) WITH CHECK (false);
CREATE POLICY "Deny all website live store credential access" ON public.website_live_store_credentials
AS RESTRICTIVE USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE public.website_live_store_configs FROM anon, authenticated;
REVOKE ALL ON TABLE public.website_live_store_credentials FROM anon, authenticated;
GRANT ALL ON TABLE public.website_live_store_configs TO service_role;
GRANT ALL ON TABLE public.website_live_store_credentials TO service_role;
