COMMENT ON COLUMN public.apps.onboarding IS
'Feature ledger plus setup source.
Shape: {"refreshed_at": iso, "features": {...}, "setup": {
"todo_list_version": positive integer (default 1),
"source": manual|cli|mcp|ai,
"outcome": in_progress|completed|skipped|switched_to_manual,
"steps": {step_id: {"status": done|skipped, "at": iso}}}}.
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
  v_todo_list_version bigint := 1;
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
  v_step_ids text[] := ARRAY[
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
  ];
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
    AND (v_setup ->> 'todo_list_version') ~ '^[1-9][0-9]{0,15}$'
  THEN
    v_todo_list_version := (v_setup ->> 'todo_list_version')::bigint;
    IF v_todo_list_version > 9007199254740991 THEN
      v_todo_list_version := 1;
    END IF;
  END IF;

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
    -- jsonb -> missing key ->> 'status' is NULL. NULL NOT IN (...) is unknown, not true,
    -- so treat empty status as "step not reported yet".
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
  ELSIF v_patch_outcome IN ('completed', 'skipped') THEN
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
) FROM public;
GRANT ALL ON FUNCTION public.merge_app_onboarding_setup(
    jsonb, jsonb
) TO service_role;

COMMENT ON FUNCTION public.merge_app_onboarding_setup(jsonb, jsonb) IS
'Merges versioned CLI/MCP/AI setup source, outcome, and step progress into
apps.onboarding.setup without touching features.';
