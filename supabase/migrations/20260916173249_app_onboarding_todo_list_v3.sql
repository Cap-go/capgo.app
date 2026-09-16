COMMENT ON COLUMN public.apps.onboarding IS
'Feature ledger plus setup source.
Shape: {"refreshed_at": iso, "features": {...}, "setup": {
"todo_list_version": positive integer (default 2),
"source": manual|cli|mcp|ai,
"outcome": in_progress|completed|skipped|switched_to_manual,
"steps": {step_id: {"status": done|skipped, "at": iso}}}}.
Version 1 starts with add_app; version 2 starts with login_cli_mcp.
Version 3 has seven goals and is assigned at app creation by the OTA experiment.
Manual is the default when setup.source is missing.';

CREATE OR REPLACE FUNCTION public.merge_app_onboarding_setup(
    p_existing jsonb,
    p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_current jsonb := COALESCE(p_existing, '{}'::jsonb);
  v_setup jsonb;
  v_todo_list_version bigint := 2;
  v_source text;
  v_next_source text;
  v_outcome text;
  v_patch_outcome text;
  v_steps jsonb;
  v_patch_steps jsonb;
  v_step_id text;
  v_step jsonb;
  v_existing_step jsonb;
  v_now text;
  v_all_present boolean := true;
  v_any_skipped boolean := false;
  v_step_ids text[];
  v_source_rank integer;
  v_next_rank integer;
BEGIN
  IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
    v_current := '{}'::jsonb;
  END IF;

  IF jsonb_typeof(v_current -> 'setup') = 'object' THEN
    v_setup := v_current -> 'setup';
  ELSE
    v_setup := v_current;
  END IF;

  IF jsonb_typeof(v_setup -> 'todo_list_version') = 'number'
    AND (v_setup ->> 'todo_list_version')::numeric
      BETWEEN 1 AND 9007199254740991
    AND (v_setup ->> 'todo_list_version')::numeric
      = trunc((v_setup ->> 'todo_list_version')::numeric)
  THEN
    v_todo_list_version := (v_setup ->> 'todo_list_version')::bigint;
  END IF;

  v_step_ids := CASE WHEN v_todo_list_version = 1 THEN ARRAY[
    'add_app',
    'add_channel',
    'add_updater',
    'add_code',
    'add_encryption',
    'select_platform',
    'build_project',
    'run_device',
    'add_code_change',
    'upload_bundle',
    'test_update',
    'completion'
  ] WHEN v_todo_list_version = 3 THEN ARRAY[
    'login_cli_mcp', 'add_channel', 'add_updater', 'add_code',
    'run_device', 'upload_bundle', 'test_update'
  ] ELSE ARRAY[
    'login_cli_mcp',
    'add_channel',
    'add_updater',
    'add_code',
    'add_encryption',
    'select_platform',
    'build_project',
    'run_device',
    'add_code_change',
    'upload_bundle',
    'test_update',
    'completion'
  ] END;

  v_source := CASE v_setup ->> 'source'
    WHEN 'cli' THEN 'cli'
    WHEN 'mcp' THEN 'mcp'
    WHEN 'ai' THEN 'ai'
    WHEN 'manual' THEN 'manual'
    ELSE 'manual'
  END;
  v_next_source := NULLIF(p_patch ->> 'source', '');
  v_source_rank := CASE v_source
    WHEN 'manual' THEN 0
    WHEN 'ai' THEN 1
    WHEN 'cli' THEN 2
    WHEN 'mcp' THEN 3
    ELSE 0
  END;
  v_next_rank := CASE v_next_source
    WHEN 'manual' THEN 0
    WHEN 'ai' THEN 1
    WHEN 'cli' THEN 2
    WHEN 'mcp' THEN 3
    ELSE -1
  END;
  IF v_next_rank >= v_source_rank THEN
    v_source := v_next_source;
  END IF;

  v_steps := COALESCE(v_setup -> 'steps', '{}'::jsonb);
  IF jsonb_typeof(v_steps) IS DISTINCT FROM 'object' THEN
    v_steps := '{}'::jsonb;
  END IF;

  v_patch_steps := p_patch -> 'steps';
  IF jsonb_typeof(v_patch_steps) = 'object' THEN
    FOR v_step_id, v_step IN
      SELECT key, value FROM jsonb_each(v_patch_steps)
    LOOP
      IF v_step_id <> ALL (v_step_ids) THEN
        CONTINUE;
      END IF;
      IF jsonb_typeof(v_step) IS DISTINCT FROM 'object' THEN
        CONTINUE;
      END IF;
      IF COALESCE(v_step ->> 'status', '') NOT IN ('done', 'skipped') THEN
        CONTINUE;
      END IF;
      v_existing_step := v_steps -> v_step_id;
      IF jsonb_typeof(v_existing_step) = 'object'
        AND v_existing_step ->> 'status' = 'done'
        AND v_step ->> 'status' = 'skipped'
      THEN
        CONTINUE;
      END IF;
      v_steps := jsonb_set(
        v_steps,
        ARRAY[v_step_id],
        jsonb_strip_nulls(jsonb_build_object(
          'status', v_step ->> 'status',
          'at', COALESCE(
            NULLIF(v_step ->> 'at', ''),
            NULLIF(v_existing_step ->> 'at', ''),
            to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
        )),
        true
      );
    END LOOP;
  END IF;

  FOREACH v_step_id IN ARRAY v_step_ids LOOP
    -- jsonb -> missing key ->> 'status' is NULL. Treat it as not reported yet.
    IF COALESCE(v_steps -> v_step_id ->> 'status', '') NOT IN ('done', 'skipped') THEN
      v_all_present := false;
    ELSIF v_steps -> v_step_id ->> 'status' = 'skipped' THEN
      v_any_skipped := true;
    END IF;
  END LOOP;

  v_patch_outcome := p_patch ->> 'outcome';
  v_outcome := CASE v_setup ->> 'outcome'
    WHEN 'completed' THEN 'completed'
    WHEN 'skipped' THEN 'skipped'
    WHEN 'switched_to_manual' THEN 'switched_to_manual'
    ELSE 'in_progress'
  END;
  IF v_all_present THEN
    v_outcome := CASE WHEN v_any_skipped THEN 'skipped' ELSE 'completed' END;
  ELSIF v_patch_outcome = 'skipped' OR (v_patch_outcome = 'completed' AND v_todo_list_version <> 3) THEN
    v_outcome := v_patch_outcome;
  ELSIF v_patch_outcome = 'switched_to_manual' OR v_outcome = 'switched_to_manual' THEN
    v_outcome := 'switched_to_manual';
  ELSE
    v_outcome := 'in_progress';
  END IF;

  v_now := to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  RETURN (v_current - 'source' - 'outcome' - 'steps' - 'updated_at' - 'todo_list_version')
    || jsonb_build_object(
      'setup', jsonb_build_object(
        'todo_list_version', v_todo_list_version,
        'source', v_source,
        'outcome', v_outcome,
        'steps', v_steps,
        'updated_at', v_now
      )
    );
END;
$$;

ALTER FUNCTION public.merge_app_onboarding_setup(
    jsonb, jsonb
) OWNER TO "postgres";
REVOKE ALL ON FUNCTION public.merge_app_onboarding_setup(
    jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.merge_app_onboarding_setup(
    jsonb, jsonb
) TO service_role;

COMMENT ON FUNCTION public.merge_app_onboarding_setup(jsonb, jsonb) IS
'Merges versioned CLI/MCP/AI setup source, outcome, and step progress into
apps.onboarding.setup without touching features.';


-- One indexed creator lookup per CLI/MCP event; no scan over all apps.
DROP INDEX IF EXISTS public.idx_apps_onboarding_v2_creator;
CREATE INDEX IF NOT EXISTS idx_apps_onboarding_login_creator
ON public.apps ((onboarding ->> 'created_by_user_id'))
WHERE onboarding #>> '{setup,todo_list_version}' IN ('2', '3');

-- Runs once per inserted app. Both lookups use primary keys (users.id/orgs.id).
-- The trigger runs after protect_apps_onboarding, so authenticated inserts cannot
-- choose a branch/version or forge the server-side creator ledger.
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
    v_setup := CASE WHEN jsonb_typeof(NEW.onboarding -> 'setup') = 'object'
      THEN NEW.onboarding -> 'setup' ELSE '{}'::jsonb END;
    NEW.onboarding := COALESCE(NEW.onboarding, '{}'::jsonb)
      || jsonb_build_object('created_by_user_id', v_creator::text);
    NEW.onboarding := jsonb_set(COALESCE(NEW.onboarding, '{}'::jsonb), '{setup}',
      v_setup || jsonb_build_object('todo_list_version', 3), true);
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.assign_app_onboarding_todo_list_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_app_onboarding_todo_list_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_app_onboarding_todo_list_version() TO service_role;
CREATE OR REPLACE TRIGGER zz_assign_app_onboarding_todo_list_version
BEFORE INSERT ON public.apps FOR EACH ROW
EXECUTE FUNCTION public.assign_app_onboarding_todo_list_version();
