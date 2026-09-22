COMMENT ON COLUMN public.apps.onboarding IS
'Feature ledger plus setup source.
Shape: {"refreshed_at": iso, "features": {...}, "setup": {
"todo_list_version": positive integer (default 2),
"source": manual|cli|mcp|ai,
"outcome": in_progress|completed|skipped|switched_to_manual,
"steps": {step_id: {"status": done|skipped, "at": iso}}}} for v1-v3.
Version 1 starts with add_app; version 2 starts with login_cli_mcp.
Version 3 has seven flat goals. Version 4 has independent paths.
OTA v1 uses setup.ota_todo_list_version="1" and setup.steps.ota.
Builder v1 uses setup.builder_todo_list_version="1" and
setup.steps.builder.ios/android. Each path is present only when assigned.
Manual is the default when setup.source is missing.';

-- Fixed, testable initializer. The app-insert trigger does not call it until
-- the Builder experiment assignment is wired in a later migration.
CREATE OR REPLACE FUNCTION public.new_builder_onboarding_setup_v1()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'todo_list_version', 4,
    'builder_todo_list_version', '1',
    'paths', pg_catalog.jsonb_build_array('builder'),
    'selected_path', 'builder',
    'outcome', 'in_progress',
    'steps', pg_catalog.jsonb_build_object(
      'builder', pg_catalog.jsonb_build_object(
        'ios', pg_catalog.jsonb_build_object(
          'start_setup', pg_catalog.jsonb_build_object('status', 'pending'),
          'choose_destination', pg_catalog.jsonb_build_object('status', 'pending'),
          'connect_app_store', pg_catalog.jsonb_build_object('status', 'pending'),
          'prepare_certificate', pg_catalog.jsonb_build_object('status', 'pending'),
          'prepare_profile', pg_catalog.jsonb_build_object('status', 'pending'),
          'successful_cloud_build', pg_catalog.jsonb_build_object('status', 'pending')
        ),
        'android', pg_catalog.jsonb_build_object(
          'start_setup', pg_catalog.jsonb_build_object('status', 'pending'),
          'prepare_keystore', pg_catalog.jsonb_build_object('status', 'pending'),
          'connect_google_play', pg_catalog.jsonb_build_object('status', 'pending'),
          'successful_cloud_build', pg_catalog.jsonb_build_object('status', 'pending')
        )
      )
    )
  );
$$;
ALTER FUNCTION public.new_builder_onboarding_setup_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.new_builder_onboarding_setup_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.new_builder_onboarding_setup_v1() TO service_role;

-- Existing OTA assignment stays active. Builder assignment is deliberately
-- disabled until builder_todo_list_v4 (Builder-intent, 0% automatic assignment)
-- exists and a later migration replaces FALSE with a branch-A check.
CREATE OR REPLACE FUNCTION public.assign_app_onboarding_todo_list_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_creator uuid := auth.uid();
  v_setup jsonb;
BEGIN
  IF v_creator IS NULL AND (NEW.onboarding ->> 'created_by_user_id')
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    v_creator := (NEW.onboarding ->> 'created_by_user_id')::uuid;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.users AS u
    JOIN public.orgs AS o ON o.id = NEW.owner_org
    WHERE u.id = v_creator AND o.created_by = u.id
      AND u.onboarding ->> 'intent' = 'ota'
      AND u.onboarding #>> '{abtests,ota_todo_list_v3,branch}' = 'A'
  ) THEN
    v_setup := CASE WHEN pg_catalog.jsonb_typeof(NEW.onboarding -> 'setup') = 'object'
      THEN NEW.onboarding -> 'setup' ELSE '{}'::jsonb END;
    NEW.onboarding := COALESCE(NEW.onboarding, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('created_by_user_id', v_creator::text);
    NEW.onboarding := pg_catalog.jsonb_set(COALESCE(NEW.onboarding, '{}'::jsonb), '{setup}',
      v_setup || pg_catalog.jsonb_build_object(
        'todo_list_version', 4,
        'ota_todo_list_version', '1',
        'paths', pg_catalog.jsonb_build_array('ota'),
        'selected_path', 'ota',
        'steps', pg_catalog.jsonb_build_object('ota', pg_catalog.jsonb_build_object(
          'login_cli_mcp', pg_catalog.jsonb_build_object('status', 'pending'),
          'add_channel', pg_catalog.jsonb_build_object('status', 'pending'),
          'add_updater', pg_catalog.jsonb_build_object('status', 'pending'),
          'add_code', pg_catalog.jsonb_build_object('status', 'pending'),
          'run_device', pg_catalog.jsonb_build_object('status', 'pending'),
          'upload_bundle', pg_catalog.jsonb_build_object('status', 'pending'),
          'test_update', pg_catalog.jsonb_build_object('status', 'pending')
        ))
      ), true);
  -- Replace FALSE only after the experiment PR merges. The future predicate
  -- must verify Builder intent, creator-owned organization, and branch A at
  -- users.onboarding #>> '{abtests,builder_todo_list_v4,branch}'.
  ELSIF FALSE THEN
    v_setup := CASE WHEN pg_catalog.jsonb_typeof(NEW.onboarding -> 'setup') = 'object'
      THEN NEW.onboarding -> 'setup' ELSE '{}'::jsonb END;
    NEW.onboarding := COALESCE(NEW.onboarding, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('created_by_user_id', v_creator::text);
    NEW.onboarding := pg_catalog.jsonb_set(COALESCE(NEW.onboarding, '{}'::jsonb), '{setup}',
      (v_setup - 'ota_todo_list_version' - 'selected_builder_platform')
        || public.new_builder_onboarding_setup_v1(), true);
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.assign_app_onboarding_todo_list_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_app_onboarding_todo_list_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_app_onboarding_todo_list_version() TO service_role;
