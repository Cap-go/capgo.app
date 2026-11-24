-- CLIs older than 8.90.1 still call this RPC on every `bundle upload` and
-- print each non-fatal message as a warning. Use it to tell them to upgrade
-- before the legacy PostgREST path they depend on is turned off.
-- Newer CLIs never call it.
CREATE OR REPLACE FUNCTION "public"."get_organization_cli_warnings"("orgid" "uuid", "cli_version" "text") RETURNS "jsonb"[]
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  messages jsonb[] := ARRAY[]::jsonb[];
  request_apikey text;
  api_key public.apikeys%ROWTYPE;
  fallback_app_id text;
  has_org_read boolean;
BEGIN
  has_org_read := public.cli_check_permission(
    permission_key := public.rbac_perm_org_read(),
    org_id := orgid
  );

  IF NOT has_org_read THEN
    SELECT public.get_apikey_header() INTO request_apikey;

    IF request_apikey IS NOT NULL AND request_apikey <> '' THEN
      SELECT *
      INTO api_key
      FROM public.find_apikey_by_value(request_apikey)
      LIMIT 1;

      IF api_key.id IS NOT NULL
        AND NOT public.is_apikey_expired(api_key.expires_at)
      THEN
        SELECT public.apps.app_id
        INTO fallback_app_id
        FROM public.role_bindings rb
        JOIN public.apps ON public.apps.id = rb.app_id
        WHERE rb.principal_type = public.rbac_principal_apikey()
          AND rb.principal_id = api_key.rbac_id
          AND rb.scope_type = public.rbac_scope_app()
          AND rb.app_id IS NOT NULL
          AND public.apps.owner_org = orgid
          AND (rb.expires_at IS NULL OR rb.expires_at > now())
        ORDER BY public.apps.app_id
        LIMIT 1;

        IF fallback_app_id IS NOT NULL THEN
          has_org_read := public.cli_check_permission(
            permission_key := public.rbac_perm_app_read(),
            org_id := orgid,
            app_id := fallback_app_id
          );
        END IF;
      END IF;
    END IF;
  END IF;

  IF NOT has_org_read THEN
    messages := array_append(messages, jsonb_build_object(
      'message', 'API key does not have read access to this organization',
      'fatal', true
    ));
    RETURN messages;
  END IF;

  IF (
    public.is_paying_and_good_plan_org_action(orgid, ARRAY['mau']::public.action_type[]) = true
    AND public.is_paying_and_good_plan_org_action(orgid, ARRAY['bandwidth']::public.action_type[]) = true
    AND public.is_paying_and_good_plan_org_action(orgid, ARRAY['storage']::public.action_type[]) = false
  ) THEN
    messages := array_append(messages, jsonb_build_object(
      'message', 'You have exceeded your storage limit.\nUpload will fail, but you can still download your data.\nMAU and bandwidth limits are not exceeded.\nIn order to upload your plan, please upgrade your plan here: https://console.capgo.app/settings/plans.',
      'fatal', true
    ));
  END IF;

  IF substring(cli_version from '^\d{1,9}\.\d{1,9}\.\d{1,9}') IS NOT NULL
    AND string_to_array(substring(cli_version from '^\d{1,9}\.\d{1,9}\.\d{1,9}'), '.')::int[] < ARRAY[8, 90, 1]
  THEN
    messages := array_append(messages, jsonb_build_object(
      'message', 'Your @capgo/cli (' || cli_version || ') is outdated and will stop working in 2027.\nUpdate it: npm i -D @capgo/cli@latest (or pnpm/yarn/bun add -D @capgo/cli@latest), then commit your lockfile.\nPinned in CI? Bump the version there too. The latest CLI supports Capacitor 5 to 8.',
      'fatal', false
    ));
  END IF;

  RETURN messages;
END;
$$;


ALTER FUNCTION "public"."get_organization_cli_warnings"("orgid" "uuid", "cli_version" "text") OWNER TO "postgres";
