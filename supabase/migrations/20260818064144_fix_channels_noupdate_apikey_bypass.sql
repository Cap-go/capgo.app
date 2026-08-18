-- GHSA-ph9c-vwjq-pqhj: API-key PostgREST traffic must not bypass
-- channels.noupdate(). Direct PostgREST updates may only change
-- version/updated_at unless the caller is an internal/service-role path
-- or an authenticated JWT with app.update_settings. Official channel
-- routes perform settings writes with service_role after checking
-- permissions in application code.
CREATE OR REPLACE FUNCTION public.noupdate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $_$
DECLARE
  val record;
  is_different boolean;
  v_request_role text := public.current_request_role();
BEGIN
  IF pg_catalog.current_setting('capgo.allow_owner_org_transfer', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF v_request_role = ANY (public.internal_request_role_names()) THEN
    RETURN NEW;
  END IF;

  -- Direct postgres maintenance without PostgREST/API-key request context.
  IF public.is_internal_request_role(v_request_role)
    AND NULLIF(pg_catalog.btrim(public.get_apikey_header()), '') IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL
    AND public.rbac_check_permission_request(
      public.rbac_perm_app_update_settings(),
      OLD.owner_org,
      OLD.app_id,
      NULL::bigint
    ) THEN
    RETURN NEW;
  END IF;

  FOR val IN SELECT * FROM pg_catalog.json_each_text(pg_catalog.row_to_json(NEW))
  LOOP
    EXECUTE pg_catalog.format(
      'SELECT ($1."%s" is distinct from $2."%s")',
      val.key,
      val.key
    ) USING NEW, OLD
    INTO is_different;

    IF is_different AND val.key <> 'version' AND val.key <> 'updated_at' THEN
      RAISE EXCEPTION 'not allowed %', val.key;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$_$;

ALTER FUNCTION public.noupdate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.noupdate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.noupdate() TO service_role;

COMMENT ON FUNCTION public.noupdate() IS
  'Restricts direct PostgREST channel updates: API keys may only change '
  'version/updated_at; authenticated users with app.update_settings and '
  'internal/service-role callers may change other fields.';
