CREATE OR REPLACE FUNCTION public.guard_app_version_r2_path()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner_org uuid;
  v_expected text;
BEGIN
  IF NEW.r2_path IS NULL OR btrim(NEW.r2_path) = '' THEN
    NEW.r2_path := NULL;
    RETURN NEW;
  END IF;

  v_owner_org := NEW.owner_org;
  IF v_owner_org IS NULL AND NEW.app_id IS NOT NULL THEN
    SELECT apps.owner_org
    INTO v_owner_org
    FROM public.apps
    WHERE apps.app_id = NEW.app_id;
  END IF;

  IF v_owner_org IS NULL OR NEW.app_id IS NULL OR NEW.name IS NULL THEN
    RETURN NEW;
  END IF;

  v_expected := 'orgs/' || v_owner_org::text || '/apps/' || NEW.app_id || '/' || NEW.name || '.zip';

  IF NEW.r2_path <> v_expected THEN
    PERFORM public.pg_log(
      'deny: APP_VERSION_R2_PATH_GUARD',
      jsonb_build_object(
        'owner_org', v_owner_org,
        'app_id', NEW.app_id,
        'version_name', NEW.name,
        'r2_path', NEW.r2_path,
        'expected', v_expected
      )
    );
    RAISE EXCEPTION '%',
      'invalid_r2_path: Bundle storage path must match the canonical location for this version.';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_app_version_r2_path() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_app_version_r2_path() FROM PUBLIC;
GRANT ALL ON FUNCTION public.guard_app_version_r2_path() TO service_role;

DROP TRIGGER IF EXISTS guard_app_version_r2_path_trigger ON public.app_versions;
CREATE TRIGGER guard_app_version_r2_path_trigger
BEFORE INSERT OR UPDATE OF r2_path, name, app_id, owner_org ON public.app_versions
FOR EACH ROW
EXECUTE FUNCTION public.guard_app_version_r2_path();
