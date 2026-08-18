-- GHSA-ph9c-vwjq-pqhj: API-key PostgREST traffic must not bypass
-- channels.noupdate(). The old auth.uid() IS NULL early return skipped the
-- guard for every capgkey request. Only skip when there is no JWT and no
-- capgkey (internal/maintenance). API keys may only change version/updated_at
-- via direct PostgREST; authenticated JWT users with app.update_settings may
-- change other fields. Official /channel routes use service_role after route
-- auth because they perform settings writes API-key PostgREST must not pass.
CREATE OR REPLACE FUNCTION public.noupdate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $_$
DECLARE
  val record;
  is_different boolean;
BEGIN
  IF pg_catalog.current_setting('capgo.allow_owner_org_transfer', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL
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
  'version/updated_at; authenticated JWT users with app.update_settings may '
  'change other fields. Skips only when auth.uid() and capgkey are both absent.';
