ALTER TABLE public.app_versions DROP CONSTRAINT IF EXISTS app_versions_manifest_size_validated_fkey;
DROP TRIGGER IF EXISTS create_manifest_size_validation ON public.app_versions;
DROP FUNCTION IF EXISTS public.create_manifest_size_validation();
DROP TABLE IF EXISTS public.manifest_size_validated;
DROP TRIGGER IF EXISTS on_manifest_create ON public.manifest; -- Bridge old Worker instances during deployment; new code queues itself.
CREATE OR REPLACE FUNCTION public.queue_legacy_manifest_size_lookup_compat() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN
  PERFORM pgmq.send('on_manifest_create', pg_catalog.jsonb_build_object('function_name', 'on_manifest_create', 'function_type', 'cloudflare', 'payload', pg_catalog.jsonb_build_object('old_record', NULL, 'record', pg_catalog.to_jsonb(NEW), 'type', 'INSERT', 'table', 'manifest', 'schema', 'public')));
  RETURN NEW;
END; $$;
ALTER FUNCTION public.queue_legacy_manifest_size_lookup_compat() OWNER TO postgres; REVOKE ALL ON FUNCTION public.queue_legacy_manifest_size_lookup_compat() FROM PUBLIC;
CREATE TRIGGER on_manifest_create_compat AFTER INSERT ON public.manifest FOR EACH ROW WHEN (pg_catalog.current_setting('capgo.manifest_queue_managed', true) IS DISTINCT FROM 'on'
  AND (NEW.file_size IS NULL OR NEW.file_size = 0)) EXECUTE FUNCTION public.queue_legacy_manifest_size_lookup_compat();
