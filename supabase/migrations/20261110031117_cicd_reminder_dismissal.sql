-- Dismissing the CI/CD reminder is separate from marking CI/CD as set up.
-- Restore removes only the reminder timestamp; detection and guide progress stay intact.
-- Execution model is unchanged: one console RPC request performs PK-indexed app
-- reads and an app.read permission check before and after its row lock. The
-- function runs once per explicit action, never per row in a policy or view.
-- Only existing authenticated/service_role callers retain EXECUTE; anon has none.
-- No grants or published-CLI contracts change.

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
  IF p_event IS NULL OR p_event NOT IN ('key_created', 'marked_done', 'dismissed', 'restored') THEN
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
  'Records CI/CD guide progress for app readers: key_created registers a caller-owned key, marked_done records setup completion, dismissed hides the reminder, and restored removes only the reminder dismissal.';
