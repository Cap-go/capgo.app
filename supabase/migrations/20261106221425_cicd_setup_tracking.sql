-- CI/CD setup tracking for the onboarding CI/CD guide.
--
-- State lives in apps.onboarding.cicd, next to the getting started ledger
-- (getting_started_dismissed_at, features). Every write merges into that one
-- key under a row lock, so the locked onboarding read-modify-write path in
-- supabase/functions/_backend/utils/appOnboardingMutation.ts keeps it.
--
--   keys                 rbac_id of API keys the guide created for CI (max 10)
--   key_created_at       first key created from the guide
--   selection            last { product, strategy, provider } chosen in the guide
--   marked_done_at       the user said CI/CD is already set up
--   ota_detected_at      first bundle uploaded from CI (or with a guide key)
--   builder_detected_at  first native build requested from CI (or with a guide key)
--   detected_via         'ci' (CLI ran in CI) or 'key' (a guide key was used)
--   ci_provider          CI name reported by the CLI, when known
--   <product>_detected_via / <product>_ci_provider keep each product's attribution
--
-- Execution model: one PK-indexed apps row per call. record_app_cicd_deploy
-- runs once per bundle upload or build request (backend, service_role), and
-- writes only until the first detection for that product.

CREATE OR REPLACE FUNCTION "public"."app_onboarding_cicd_timestamp"()
RETURNS text
LANGUAGE "sql"
STABLE
SET "search_path" TO ''
AS $$
  SELECT to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

ALTER FUNCTION public.app_onboarding_cicd_timestamp() OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.app_onboarding_cicd_timestamp() FROM PUBLIC;
GRANT ALL ON FUNCTION public.app_onboarding_cicd_timestamp() TO "service_role";

CREATE OR REPLACE FUNCTION "public"."record_app_cicd_setup"(
  "p_app_id" character varying,
  "p_event" text,
  "p_apikey_rbac_id" uuid DEFAULT NULL,
  "p_selection" jsonb DEFAULT NULL
) RETURNS "jsonb"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_owner_org uuid;
  v_onboarding jsonb;
  v_cicd jsonb;
  v_keys jsonb;
  v_now text := public.app_onboarding_cicd_timestamp();
  v_selection jsonb := '{}'::jsonb;
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RAISE EXCEPTION 'APP_NOT_FOUND';
  END IF;
  IF p_event IS NULL OR p_event NOT IN ('key_created', 'marked_done') THEN
    RAISE EXCEPTION 'INVALID_EVENT';
  END IF;

  SELECT apps.owner_org, apps.onboarding
  INTO v_owner_org, v_onboarding
  FROM public.apps
  WHERE apps.app_id = p_app_id
  FOR UPDATE;

  IF v_owner_org IS NULL THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  -- Same boundary as dismiss_getting_started: anyone who can read the app may
  -- record its CI/CD setup state. It only changes this app's own nudge.
  IF NOT public.rbac_check_permission_request(
    public.rbac_perm_app_read(),
    v_owner_org,
    p_app_id,
    NULL::bigint
  ) THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  v_onboarding := CASE WHEN jsonb_typeof(v_onboarding) = 'object' THEN v_onboarding ELSE '{}'::jsonb END;
  v_cicd := CASE WHEN jsonb_typeof(v_onboarding -> 'cicd') = 'object' THEN v_onboarding -> 'cicd' ELSE '{}'::jsonb END;

  IF p_event = 'key_created' THEN
    -- Only the caller's own key can be tracked; its use later marks CI/CD done.
    IF p_apikey_rbac_id IS NULL OR auth.uid() IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.apikeys
      WHERE apikeys.rbac_id = p_apikey_rbac_id
        AND apikeys.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'NO_PERMISSION';
    END IF;

    v_keys := CASE WHEN jsonb_typeof(v_cicd -> 'keys') = 'array' THEN v_cicd -> 'keys' ELSE '[]'::jsonb END;
    IF NOT v_keys ? p_apikey_rbac_id::text THEN
      SELECT COALESCE(jsonb_agg(kept.value ORDER BY kept.position), '[]'::jsonb)
      INTO v_keys
      FROM (
        SELECT entries.value, entries.position
        FROM jsonb_array_elements(v_keys || to_jsonb(p_apikey_rbac_id::text)) WITH ORDINALITY AS entries(value, position)
        ORDER BY entries.position DESC
        LIMIT 10
      ) AS kept;
    END IF;

    IF jsonb_typeof(p_selection) = 'object' THEN
      v_selection := jsonb_strip_nulls(jsonb_build_object(
        'product', CASE WHEN p_selection ->> 'product' IN ('ota', 'builder') THEN p_selection ->> 'product' END,
        'strategy', CASE WHEN p_selection ->> 'strategy' IN ('main', 'main_preprod', 'pull_request') THEN p_selection ->> 'strategy' END,
        'provider', CASE WHEN p_selection ->> 'provider' IN ('github', 'gitlab', 'azure', 'bitbucket', 'circleci', 'other') THEN p_selection ->> 'provider' END
      ));
    END IF;

    v_cicd := v_cicd
      || jsonb_build_object('keys', v_keys, 'key_created_at', COALESCE(NULLIF(v_cicd ->> 'key_created_at', ''), v_now))
      || CASE WHEN v_selection = '{}'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('selection', v_selection) END;
  ELSIF NULLIF(v_cicd ->> 'marked_done_at', '') IS NULL THEN
    v_cicd := v_cicd || jsonb_build_object('marked_done_at', v_now);
  END IF;

  v_onboarding := v_onboarding || jsonb_build_object('cicd', v_cicd);
  UPDATE public.apps
  SET onboarding = v_onboarding,
      updated_at = now()
  WHERE apps.app_id = p_app_id;

  RETURN v_onboarding;
END;
$$;

ALTER FUNCTION public.record_app_cicd_setup(character varying, text, uuid, jsonb) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.record_app_cicd_setup(character varying, text, uuid, jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_app_cicd_setup(character varying, text, uuid, jsonb) TO "authenticated";
GRANT ALL ON FUNCTION public.record_app_cicd_setup(character varying, text, uuid, jsonb) TO "service_role";

COMMENT ON FUNCTION public.record_app_cicd_setup(character varying, text, uuid, jsonb) IS
  'Records CI/CD guide progress on apps.onboarding.cicd for a caller who can read the app: key_created tracks one of the caller''s own API keys (and the guide answers), marked_done records that CI/CD is already set up.';

CREATE OR REPLACE FUNCTION "public"."record_app_cicd_deploy"(
  "p_app_id" character varying,
  "p_product" text,
  "p_apikey_rbac_id" uuid,
  "p_ci_provider" text
) RETURNS boolean
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_field text;
  v_provider text := NULLIF(left(btrim(COALESCE(p_ci_provider, '')), 64), '');
BEGIN
  IF p_product NOT IN ('ota', 'builder') OR p_app_id IS NULL THEN
    RETURN false;
  END IF;
  v_field := p_product || '_detected_at';

  -- A no-op once the product was detected, and without CI or guide-key
  -- evidence: most calls update no row.
  UPDATE public.apps
  SET onboarding = COALESCE(CASE WHEN jsonb_typeof(apps.onboarding) = 'object' THEN apps.onboarding END, '{}'::jsonb)
    || jsonb_build_object('cicd',
      COALESCE(CASE WHEN jsonb_typeof(apps.onboarding -> 'cicd') = 'object' THEN apps.onboarding -> 'cicd' END, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        v_field, public.app_onboarding_cicd_timestamp(),
        p_product || '_detected_via', CASE WHEN v_provider IS NOT NULL THEN 'ci' ELSE 'key' END,
        p_product || '_ci_provider', v_provider,
        'detected_via', COALESCE(NULLIF(apps.onboarding -> 'cicd' ->> 'detected_via', ''), CASE WHEN v_provider IS NOT NULL THEN 'ci' ELSE 'key' END),
        'ci_provider', CASE WHEN NULLIF(apps.onboarding -> 'cicd' ->> 'detected_via', '') IS NOT NULL
          THEN apps.onboarding -> 'cicd' ->> 'ci_provider' ELSE v_provider END
      ))),
    updated_at = now()
  WHERE apps.app_id = p_app_id
    AND NULLIF(apps.onboarding -> 'cicd' ->> v_field, '') IS NULL
    AND (
      v_provider IS NOT NULL
      OR (
        p_apikey_rbac_id IS NOT NULL
        AND jsonb_typeof(apps.onboarding -> 'cicd' -> 'keys') = 'array'
        AND (apps.onboarding -> 'cicd' -> 'keys') ? p_apikey_rbac_id::text
      )
    );

  RETURN FOUND;
END;
$$;

ALTER FUNCTION public.record_app_cicd_deploy(character varying, text, uuid, text) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.record_app_cicd_deploy(character varying, text, uuid, text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_app_cicd_deploy(character varying, text, uuid, text) TO "service_role";

COMMENT ON FUNCTION public.record_app_cicd_deploy(character varying, text, uuid, text) IS
  'Internal. Marks apps.onboarding.cicd.<product>_detected_at the first time a bundle upload or build request comes from CI (CLI x-cli-ci header) or uses an API key created by the CI/CD guide.';
