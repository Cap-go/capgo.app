CREATE OR REPLACE FUNCTION public.is_version_scoped_app_version_r2_path(
  p_r2_path text,
  p_app_id character varying,
  p_version_name character varying
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT
    p_r2_path IS NOT NULL
    AND p_r2_path ~ (
      '^orgs/[^/]+/apps/'
      || regexp_replace(p_app_id::text, '([.^$*+?(){|\[\]\\])', '\\\1', 'g')
      || '/'
      || regexp_replace(p_version_name::text, '([.^$*+?(){|\[\]\\])', '\\\1', 'g')
      || '\.zip$'
    );
$$;

ALTER FUNCTION public.is_version_scoped_app_version_r2_path(
  text,
  character varying,
  character varying
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_version_scoped_app_version_r2_path(
  text,
  character varying,
  character varying
) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_version_scoped_app_version_r2_path(
  text,
  character varying,
  character varying
) TO service_role;

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

  IF NEW.r2_path = v_expected THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.r2_path IS NOT DISTINCT FROM OLD.r2_path
    AND public.is_version_scoped_app_version_r2_path(
      NEW.r2_path,
      NEW.app_id,
      NEW.name
    ) THEN
    RETURN NEW;
  END IF;

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

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_app_version_r2_path() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_app_version_r2_path() FROM PUBLIC;
GRANT ALL ON FUNCTION public.guard_app_version_r2_path() TO service_role;

DROP TRIGGER IF EXISTS guard_app_version_r2_path_trigger ON public.app_versions;
CREATE TRIGGER guard_app_version_r2_path_trigger
BEFORE INSERT OR UPDATE OF
  r2_path,
  owner_org,
  app_id,
  name
ON public.app_versions
FOR EACH ROW
EXECUTE FUNCTION public.guard_app_version_r2_path();
