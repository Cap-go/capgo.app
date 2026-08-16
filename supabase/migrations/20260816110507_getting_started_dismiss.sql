-- Persist Getting Started nav dismiss on apps.onboarding so it follows the app
-- across devices. Direct client writes to apps.onboarding stay blocked by
-- protect_apps_onboarding; this SECURITY DEFINER RPC is the only user-facing path.
--
-- Execution model:
-- - dismiss_getting_started: user-facing RPC, once per app. Indexed apps.app_id
--   lookup (FOR UPDATE) plus one rbac_check_permission_request. Sets
--   getting_started_dismissed_at if missing and returns the onboarding JSON.
-- - refresh_app_onboarding_progress overlays features via jsonb || and keeps
--   sibling keys, including getting_started_dismissed_at.
-- - Callers: authenticated console users who can already read the app (same
--   bar as mark_onboarding_feature_started). Not granted to anon.

CREATE OR REPLACE FUNCTION "public"."dismiss_getting_started"(
  "p_app_id" character varying
) RETURNS "jsonb"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET "search_path" TO ''
AS $$
DECLARE
  v_owner_org uuid;
  v_onboarding jsonb;
  v_now text;
BEGIN
  IF p_app_id IS NULL OR btrim(p_app_id) = '' THEN
    RAISE EXCEPTION 'APP_NOT_FOUND';
  END IF;

  SELECT apps.owner_org, apps.onboarding
  INTO v_owner_org, v_onboarding
  FROM public.apps
  WHERE apps.app_id = p_app_id
  FOR UPDATE;

  IF v_owner_org IS NULL THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  IF NOT public.rbac_check_permission_request(
    public.rbac_perm_app_read(),
    v_owner_org,
    p_app_id,
    NULL::bigint
  ) THEN
    RAISE EXCEPTION 'NO_PERMISSION';
  END IF;

  v_onboarding := COALESCE(v_onboarding, '{}'::jsonb);
  IF NULLIF(v_onboarding->>'getting_started_dismissed_at', '') IS NULL THEN
    v_now := to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    v_onboarding := v_onboarding || jsonb_build_object('getting_started_dismissed_at', v_now);

    UPDATE public.apps
    SET onboarding = v_onboarding,
        updated_at = now()
    WHERE apps.app_id = p_app_id;
  END IF;

  RETURN v_onboarding;
END;
$$;

ALTER FUNCTION "public"."dismiss_getting_started"(character varying) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."dismiss_getting_started"(character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dismiss_getting_started"(character varying) TO "authenticated";
GRANT ALL ON FUNCTION "public"."dismiss_getting_started"(character varying) TO "service_role";

COMMENT ON FUNCTION "public"."dismiss_getting_started"(character varying) IS
  'Sets onboarding.getting_started_dismissed_at once when the caller can read the app. Does not change features or setup.';

COMMENT ON COLUMN "public"."apps"."onboarding" IS
  'Feature ledger plus setup source and Getting Started dismiss. Shape: {"refreshed_at": iso, "features": {...}, "setup": {"source": manual|cli|mcp|ai, "outcome": in_progress|completed|skipped|switched_to_manual, "steps": {step_id: {"status": done|skipped, "at": iso}}}, "getting_started_dismissed_at": iso}. Manual is the default when setup.source is missing.';
