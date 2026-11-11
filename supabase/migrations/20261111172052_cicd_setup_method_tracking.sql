-- CI/CD method choices are guide progress, separate from self-reported setup
-- completion and actual deployment detection. Legacy keys imply no method.
-- setup_methods contains at most ota/builder records, each with method,
-- selected_at and an optional first ai_prompt_copied_at. Repeating the same
-- method/copy preserves timestamps; changing method refreshes selected_at.
-- Each product's first actual detection snapshots <product>_setup_method only
-- when that product has a choice. Later choices never relabel past detections.
--
-- Execution model is unchanged: one explicit console RPC, two apps_pkey reads
-- and request-scoped app.read checks before/after the row lock. The existing
-- key path uses apikeys_rbac_id_key to check one key. The internal service_role
-- detection RPC performs its existing single apps_pkey UPDATE per upload/build,
-- with no additional query. No RLS/view/per-candidate calls or plugin hot paths.
-- prod.sql defines apps_pkey and apikeys_rbac_id_key; app/key lookup cardinality
-- is at most one regardless of table size. Existing RBAC scope checks are
-- unchanged. Both functions keep their signatures and grants, including all
-- published CLI contracts. No data backfill or new table is needed.

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
  v_product text;
  v_method text;
  v_methods jsonb;
  v_product_method jsonb;
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RAISE EXCEPTION 'APP_NOT_FOUND';
  END IF;
  IF p_event IS NULL OR p_event NOT IN ('key_created', 'marked_done', 'dismissed', 'restored', 'method_selected', 'ai_prompt_copied') THEN
    RAISE EXCEPTION 'INVALID_EVENT';
  END IF;

  -- Reject callers without app access before they can contend on its row lock.
  SELECT apps.owner_org
  INTO v_owner_org
  FROM public.apps
  WHERE apps.app_id = p_app_id;

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

  SELECT apps.owner_org, apps.onboarding
  INTO v_owner_org, v_onboarding
  FROM public.apps
  WHERE apps.app_id = p_app_id
  FOR UPDATE;

  -- A transfer can change the owner while this call waits for the app lock.
  IF v_owner_org IS NULL OR NOT public.rbac_check_permission_request(
    public.rbac_perm_app_read(),
    v_owner_org,
    p_app_id,
    NULL::bigint
  ) THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  v_onboarding := CASE WHEN jsonb_typeof(v_onboarding) = 'object' THEN v_onboarding ELSE '{}'::jsonb END;
  v_cicd := CASE WHEN jsonb_typeof(v_onboarding -> 'cicd') = 'object' THEN v_onboarding -> 'cicd' ELSE '{}'::jsonb END;

  IF jsonb_typeof(p_selection) = 'object' THEN
    v_selection := jsonb_strip_nulls(jsonb_build_object(
      'product', CASE WHEN p_selection ->> 'product' IN ('ota', 'builder') THEN p_selection ->> 'product' END,
      'strategy', CASE WHEN p_selection ->> 'strategy' IN ('main', 'main_preprod', 'pull_request') THEN p_selection ->> 'strategy' END,
      'provider', CASE WHEN p_selection ->> 'provider' IN ('github', 'gitlab', 'azure', 'bitbucket', 'circleci', 'other') THEN p_selection ->> 'provider' END,
      'setup_method', CASE WHEN p_selection ->> 'setup_method' IN ('ai', 'manual') THEN p_selection ->> 'setup_method' END
    ));
  END IF;

  IF p_event IN ('method_selected', 'ai_prompt_copied') THEN
    v_product := v_selection ->> 'product';
    v_method := v_selection ->> 'setup_method';
    IF v_product IS NULL OR v_method IS NULL
      OR (p_event = 'ai_prompt_copied' AND v_method <> 'ai') THEN
      RAISE EXCEPTION 'INVALID_SELECTION';
    END IF;

    -- Keep one bounded record per product; never store a prompt or credentials.
    v_methods := jsonb_strip_nulls(jsonb_build_object(
      'ota', v_cicd -> 'setup_methods' -> 'ota',
      'builder', v_cicd -> 'setup_methods' -> 'builder'
    ));
    v_product_method := v_methods -> v_product;
    v_product_method := jsonb_strip_nulls(jsonb_build_object(
      'method', v_method,
      'selected_at', CASE WHEN v_product_method ->> 'method' = v_method
        THEN COALESCE(NULLIF(v_product_method ->> 'selected_at', ''), v_now) ELSE v_now END,
      'ai_prompt_copied_at', CASE WHEN p_event = 'ai_prompt_copied'
        THEN COALESCE(NULLIF(v_product_method ->> 'ai_prompt_copied_at', ''), v_now)
        ELSE NULLIF(v_product_method ->> 'ai_prompt_copied_at', '') END
    ));
    v_cicd := v_cicd || jsonb_build_object(
      'setup_methods', v_methods || jsonb_build_object(v_product, v_product_method),
      'selection', v_selection
    );
  ELSIF p_event = 'key_created' THEN
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

    -- Legacy key events remain valid and do not imply a method choice. Preserve
    -- a known method when older clients resend guide answers without that field.
    IF v_selection <> '{}'::jsonb AND NOT v_selection ? 'setup_method' THEN
      v_method := COALESCE(
        CASE WHEN v_cicd -> 'setup_methods' -> (v_selection ->> 'product') ->> 'method' IN ('ai', 'manual')
          THEN v_cicd -> 'setup_methods' -> (v_selection ->> 'product') ->> 'method' END,
        CASE WHEN v_cicd -> 'selection' ->> 'product' = v_selection ->> 'product'
          AND v_cicd -> 'selection' ->> 'setup_method' IN ('ai', 'manual')
          THEN v_cicd -> 'selection' ->> 'setup_method' END
      );
      IF v_method IS NOT NULL THEN
        v_selection := v_selection || jsonb_build_object('setup_method', v_method);
      END IF;
    END IF;

    v_cicd := v_cicd
      || jsonb_build_object('keys', v_keys, 'key_created_at', COALESCE(NULLIF(v_cicd ->> 'key_created_at', ''), v_now))
      || CASE WHEN v_selection = '{}'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('selection', v_selection) END;
  ELSIF p_event = 'dismissed' THEN
    v_cicd := v_cicd || jsonb_build_object('dismissed_at', COALESCE(NULLIF(v_cicd ->> 'dismissed_at', ''), v_now));
  ELSIF p_event = 'restored' THEN
    v_cicd := v_cicd - 'dismissed_at';
  ELSIF p_event = 'marked_done' AND NULLIF(v_cicd ->> 'marked_done_at', '') IS NULL THEN
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

COMMENT ON FUNCTION public.record_app_cicd_setup(character varying, text, uuid, jsonb) IS
  'Records CI/CD guide progress for app readers. method_selected and ai_prompt_copied keep per-product method choices and first copy timestamps without completing setup; existing key, completion and reminder events retain their behavior.';

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
        -- Attribute only the first real detection to that product's choice.
        -- Missing choices and historic detections remain unknown.
        p_product || '_setup_method', CASE
          WHEN apps.onboarding -> 'cicd' -> 'setup_methods' -> p_product ->> 'method' IN ('ai', 'manual')
          THEN apps.onboarding -> 'cicd' -> 'setup_methods' -> p_product ->> 'method' END,
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

COMMENT ON FUNCTION public.record_app_cicd_deploy(character varying, text, uuid, text) IS
  'Internal. Records the first CI or guide-key deployment per product and snapshots that product''s chosen setup method when present. Legacy and historical detections retain unknown method attribution.';
