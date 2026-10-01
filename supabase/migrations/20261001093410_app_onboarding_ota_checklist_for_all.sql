-- Every app now uses the seven-step OTA checklist (todo list v4, OTA v1)
-- unless its creator is on the Builder v4 path. Previously only apps in an
-- organization whose intent was "ota" got it; every other new app fell back to
-- the twelve-step v2 list.

CREATE OR REPLACE FUNCTION public.new_ota_onboarding_steps_v1(p_legacy_steps jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  -- Carries done/skipped statuses (and their metadata) from a flat v1-v3 step
  -- record. v1 named the first step add_app instead of login_cli_mcp.
  SELECT pg_catalog.jsonb_object_agg(
    step.id,
    CASE
      WHEN legacy.value ->> 'status' IN ('done', 'skipped') THEN legacy.value
      ELSE pg_catalog.jsonb_build_object('status', 'pending')
    END
  )
  FROM unnest(ARRAY[
    'login_cli_mcp', 'add_channel', 'add_updater', 'add_code',
    'run_device', 'upload_bundle', 'test_update'
  ]) AS step(id)
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN pg_catalog.jsonb_typeof(COALESCE(p_legacy_steps, '{}'::jsonb)) <> 'object' THEN NULL
      WHEN pg_catalog.jsonb_typeof(p_legacy_steps -> step.id) = 'object' THEN p_legacy_steps -> step.id
      WHEN step.id = 'login_cli_mcp' AND pg_catalog.jsonb_typeof(p_legacy_steps -> 'add_app') = 'object'
        THEN p_legacy_steps -> 'add_app'
    END AS value
  ) AS legacy ON true;
$$;

ALTER FUNCTION public.new_ota_onboarding_steps_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.new_ota_onboarding_steps_v1(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.new_ota_onboarding_steps_v1(jsonb) TO service_role;

-- OTA v4 is the default. Builder v4 stays restricted to a creator-owned
-- organization and a manually assigned treatment branch, and an organization
-- whose intent is "ota" always gets OTA.
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
  v_setup := CASE WHEN pg_catalog.jsonb_typeof(NEW.onboarding -> 'setup') = 'object'
    THEN NEW.onboarding -> 'setup' ELSE '{}'::jsonb END;
  IF v_creator IS NOT NULL THEN
    NEW.onboarding := COALESCE(NEW.onboarding, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('created_by_user_id', v_creator::text);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.orgs AS o
    WHERE o.id = NEW.owner_org
      AND o.onboarding ->> 'intent' = 'ota'
  ) AND EXISTS (
    SELECT 1 FROM public.users AS u
    JOIN public.orgs AS o ON o.id = NEW.owner_org
    WHERE u.id = v_creator AND o.created_by = u.id
      AND u.onboarding ->> 'intent' = 'builder'
      AND u.onboarding #>> '{abtests,builder_todo_list_v4,branch}' = 'A'
  ) THEN
    NEW.onboarding := pg_catalog.jsonb_set(COALESCE(NEW.onboarding, '{}'::jsonb), '{setup}',
      (v_setup - 'ota_todo_list_version' - 'selected_builder_platform')
        || public.new_builder_onboarding_setup_v1(), true);
  ELSE
    NEW.onboarding := pg_catalog.jsonb_set(COALESCE(NEW.onboarding, '{}'::jsonb), '{setup}',
      v_setup || pg_catalog.jsonb_build_object(
        'todo_list_version', 4,
        'ota_todo_list_version', '1',
        'paths', pg_catalog.jsonb_build_array('ota'),
        'selected_path', 'ota',
        'steps', pg_catalog.jsonb_build_object('ota', public.new_ota_onboarding_steps_v1())
      ), true);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.assign_app_onboarding_todo_list_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_app_onboarding_todo_list_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_app_onboarding_todo_list_version() TO service_role;

-- Move apps still in onboarding off the twelve-step v1/v2 lists, keeping the
-- statuses of the seven steps both lists share. Apps that already finished
-- onboarding keep their data so Getting started does not reappear for them.
WITH pending AS (
  SELECT
    a.id,
    CASE WHEN pg_catalog.jsonb_typeof(a.onboarding -> 'setup') = 'object'
      THEN a.onboarding -> 'setup' ELSE '{}'::jsonb END AS setup
  FROM public.apps AS a
  WHERE a.need_onboarding IS TRUE
)
UPDATE public.apps AS a
SET onboarding = pg_catalog.jsonb_set(
  COALESCE(a.onboarding, '{}'::jsonb),
  '{setup}',
  (pending.setup - 'steps') || pg_catalog.jsonb_build_object(
    'todo_list_version', 4,
    'ota_todo_list_version', '1',
    'paths', pg_catalog.jsonb_build_array('ota'),
    'selected_path', 'ota',
    'steps', pg_catalog.jsonb_build_object('ota', public.new_ota_onboarding_steps_v1(pending.setup -> 'steps'))
  ),
  true
)
FROM pending
WHERE a.id = pending.id
  AND COALESCE(pending.setup ->> 'todo_list_version', '2') IN ('1', '2');
