-- No rollout or backfill: only a persisted, eligible double-intent A assignment
-- can provision the second checklist. Existing experiments remain independent.
CREATE OR REPLACE FUNCTION public.add_double_intent_onboarding_paths(p_onboarding jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_onboarding jsonb := COALESCE(p_onboarding, '{}'::jsonb);
  v_setup jsonb;
  v_steps jsonb;
  v_builder jsonb;
  v_defaults jsonb := public.new_builder_onboarding_setup_v1() #> '{steps,builder}';
  v_paths jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(v_onboarding) <> 'object' THEN
    RETURN v_onboarding;
  END IF;
  -- Legacy setup was stored at the root. Carry its fields forward without
  -- deleting the original metadata; nested values take precedence when present.
  SELECT COALESCE(pg_catalog.jsonb_object_agg(field.key, field.value), '{}'::jsonb)
  INTO v_setup
  FROM pg_catalog.jsonb_each(v_onboarding) AS field
  WHERE field.key = ANY (ARRAY[
    'todo_list_version', 'ota_todo_list_version', 'builder_todo_list_version',
    'paths', 'selected_path', 'selected_builder_platform', 'source', 'outcome',
    'steps', 'started_at', 'completed_at', 'updated_at', 'source_updated_at', 'last_run_id'
  ]);
  IF pg_catalog.jsonb_typeof(v_onboarding -> 'setup') = 'object' THEN
    v_setup := v_setup || (v_onboarding -> 'setup');
  END IF;
  -- Never reopen dismissed/completed onboarding or overwrite a future version.
  IF v_onboarding ? 'getting_started_dismissed_at'
    OR v_setup ->> 'outcome' IN ('completed', 'skipped')
    OR COALESCE(v_setup ->> 'todo_list_version', '4') NOT IN ('1', '2', '3', '4')
    OR COALESCE(v_setup ->> 'ota_todo_list_version', '1') <> '1'
    OR COALESCE(v_setup ->> 'builder_todo_list_version', '1') <> '1'
  THEN
    RETURN v_onboarding;
  END IF;
  v_steps := CASE WHEN pg_catalog.jsonb_typeof(v_setup -> 'steps') = 'object'
    THEN v_setup -> 'steps' ELSE '{}'::jsonb END;
  v_builder := CASE WHEN pg_catalog.jsonb_typeof(v_steps -> 'builder') = 'object'
    THEN v_steps -> 'builder' ELSE '{}'::jsonb END;
  -- Defaults go on the left, so every existing step record (including warning,
  -- timestamps, annotations and source metadata) wins unchanged.
  v_builder := v_builder || pg_catalog.jsonb_build_object(
    'ios', v_defaults -> 'ios' || CASE WHEN pg_catalog.jsonb_typeof(v_builder -> 'ios') = 'object'
      THEN v_builder -> 'ios' ELSE '{}'::jsonb END,
    'android', v_defaults -> 'android' || CASE WHEN pg_catalog.jsonb_typeof(v_builder -> 'android') = 'object'
      THEN v_builder -> 'android' ELSE '{}'::jsonb END
  );
  v_steps := v_steps || pg_catalog.jsonb_build_object(
    'ota', public.new_ota_onboarding_steps_v1(v_steps)
      || CASE WHEN pg_catalog.jsonb_typeof(v_steps -> 'ota') = 'object'
        THEN v_steps -> 'ota' ELSE '{}'::jsonb END,
    'builder', v_builder
  );
  v_paths := CASE WHEN pg_catalog.jsonb_typeof(v_setup -> 'paths') = 'array'
    THEN v_setup -> 'paths' ELSE '[]'::jsonb END;
  IF NOT v_paths ? 'ota' THEN
    v_paths := v_paths || '["ota"]'::jsonb;
  END IF;
  IF NOT v_paths ? 'builder' THEN
    v_paths := v_paths || '["builder"]'::jsonb;
  END IF;
  RETURN pg_catalog.jsonb_set(v_onboarding, '{setup}', v_setup || pg_catalog.jsonb_build_object(
    'todo_list_version', 4,
    'ota_todo_list_version', '1',
    'builder_todo_list_version', '1',
    'paths', v_paths,
    -- Current frontend renders one selected checklist. New dual-path apps keep
    -- the existing OTA default; upgrades retain either valid selected path.
    'selected_path', CASE WHEN v_setup ->> 'selected_path' IN ('ota', 'builder')
      THEN v_setup ->> 'selected_path' ELSE 'ota' END,
    'steps', v_steps
  ), true);
END;
$$;

ALTER FUNCTION public.add_double_intent_onboarding_paths(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.add_double_intent_onboarding_paths(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_double_intent_onboarding_paths(jsonb) TO service_role;

-- Internal assignment reconciliation only, never a user-facing selection RPC.
-- One indexed users PK lookup per request, then only that creator's orgs/apps
-- (finx_orgs_created_by -> finx_apps_owner_org). No global resource scans/RBAC
-- calls per candidate row, and no work for control/missing/ineligible users.
CREATE OR REPLACE FUNCTION public.reconcile_double_intent_app_onboarding(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user public.users%ROWTYPE;
  v_changed integer;
BEGIN
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_user.created_via_invite IS DISTINCT FROM false
    OR COALESCE(v_user.onboarding ->> 'intent', '') NOT IN ('both', 'exploring')
    OR COALESCE(v_user.onboarding #>> '{abtests,todo_list_v4_double_intent,branch}', '') <> 'A'
  THEN
    RETURN 0;
  END IF;
  UPDATE public.apps AS a
  SET onboarding = public.add_double_intent_onboarding_paths(a.onboarding)
  FROM public.orgs AS o
  WHERE o.created_by = p_user_id AND a.owner_org = o.id
    AND o.onboarding ->> 'intent' IN ('both', 'exploring')
    AND a.onboarding ->> 'created_by_user_id' = p_user_id::text
    AND a.need_onboarding IS TRUE
    AND NOT a.onboarding ? 'getting_started_dismissed_at'
    AND COALESCE(a.onboarding #>> '{setup,outcome}', '') NOT IN ('completed', 'skipped')
    AND a.onboarding IS DISTINCT FROM public.add_double_intent_onboarding_paths(a.onboarding);
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$$;

ALTER FUNCTION public.reconcile_double_intent_app_onboarding(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reconcile_double_intent_app_onboarding(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_double_intent_app_onboarding(uuid) TO service_role;

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
    -- Serialize app creation with assignment reconciliation. If assignment wins
    -- the user lock first, this insert sees it; otherwise reconciliation sees
    -- the committed app. A single users PK lookup bounds this insert-time lock.
    PERFORM 1 FROM public.users AS u WHERE u.id = v_creator FOR SHARE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.users AS u
    JOIN public.orgs AS o ON o.id = NEW.owner_org
    WHERE u.id = v_creator AND o.created_by = u.id
      AND u.created_via_invite IS FALSE
      AND u.onboarding ->> 'intent' IN ('both', 'exploring')
      AND o.onboarding ->> 'intent' IN ('both', 'exploring')
      AND u.onboarding #>> '{abtests,todo_list_v4_double_intent,branch}' = 'A'
  ) THEN
    NEW.onboarding := public.add_double_intent_onboarding_paths(NEW.onboarding);
  ELSIF NOT EXISTS (
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
