CREATE TABLE public.manifest_size_validated (
  id bigint PRIMARY KEY
    REFERENCES public.app_versions(id) ON DELETE CASCADE,
  validated boolean DEFAULT false NOT NULL
);

ALTER TABLE public.manifest_size_validated OWNER TO postgres;

COMMENT ON TABLE public.manifest_size_validated IS
  'Supabase-only state indicating whether every manifest object size has been validated.';

CREATE OR REPLACE FUNCTION public.create_manifest_size_validation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.manifest_size_validated (id, validated)
  VALUES (NEW.id, false);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.create_manifest_size_validation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_manifest_size_validation() FROM PUBLIC;

CREATE TRIGGER create_manifest_size_validation
AFTER INSERT ON public.app_versions
FOR EACH ROW
EXECUTE FUNCTION public.create_manifest_size_validation();

INSERT INTO public.manifest_size_validated (id, validated)
SELECT id, false
FROM public.app_versions
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.app_versions
  ADD CONSTRAINT app_versions_manifest_size_validated_fkey
  FOREIGN KEY (id)
  REFERENCES public.manifest_size_validated(id)
  DEFERRABLE INITIALLY DEFERRED
  NOT VALID;

ALTER TABLE public.app_versions
  VALIDATE CONSTRAINT app_versions_manifest_size_validated_fkey;

ALTER TABLE public.manifest_size_validated ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deny client access to manifest size validation"
  ON public.manifest_size_validated
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.manifest_size_validated FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.manifest_size_validated TO service_role;
