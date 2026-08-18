-- GHSA-ph9c-vwjq-pqhj: API-key PostgREST traffic must not bypass
-- channels.noupdate(). The old auth.uid() IS NULL early return skipped RBAC
-- for every capgkey request. Only skip when there is no JWT and no capgkey
-- (internal/maintenance). Otherwise honor app.update_settings and
-- channel.update_settings via rbac_check_permission_request; callers without
-- those permissions may only change version/updated_at.
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

  IF public.rbac_check_permission_request(
    public.rbac_perm_app_update_settings(),
    OLD.owner_org,
    OLD.app_id,
    NULL::bigint
  ) THEN
    RETURN NEW;
  END IF;

  IF public.rbac_check_permission_request(
    public.rbac_perm_channel_update_settings(),
    OLD.owner_org,
    OLD.app_id,
    OLD.id
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
  'Restricts channel updates without RBAC: callers with app.update_settings '
  'or channel.update_settings may change fields; others may only change '
  'version/updated_at. Skips only when auth.uid() and capgkey are both absent.';
