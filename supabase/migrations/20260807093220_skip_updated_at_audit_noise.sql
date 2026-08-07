-- Skip audit_logs for pure updated_at bumps on every audited table, and keep
-- apps/orgs stats refresh bookkeeping silent.
--
-- Execution model (audit_log_trigger):
-- - Where: AFTER INSERT/UPDATE/DELETE row trigger on orgs, apps, channels,
--   app_versions, org_users.
-- - Frequency: once per mutating row statement on those tables (not per RLS
--   candidate row). Hot-path plugin endpoints do not write these tables.
-- - Roles: runs as SECURITY DEFINER for authenticated, anon (API key), and
--   service_role writers that mutate audited rows.
-- - Cardinality: bounded by the mutating statement row count; identifier
--   lookups use primary keys (orgs.id, apps.app_id, channels.id,
--   app_versions.id, org_users.id).
-- - Indexes used by cleanup: idx_audit_logs_created_at, idx_audit_logs_operation,
--   idx_audit_logs_table_name for batched ctid deletes ordered by created_at.
--
-- Historical noise is removed via a runtime-budgeted function. Migration applies
-- a small deployment budget; cron_tasks drains the remainder.

-- Skip audit_logs for pure updated_at bumps on every audited table, and keep
-- apps/orgs stats refresh bookkeeping silent. Delete matching historical rows
-- in bounded batches so Capgo-EU audit_logs cleanup stays resumable.

CREATE OR REPLACE FUNCTION "public"."audit_log_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_old_record jsonb;
  v_new_record jsonb;
  v_changed_fields text[];
  v_org_id uuid;
  v_record_id text;
  v_user_id uuid;
  v_key text;
  v_api_key_text text;
  v_api_key public.apikeys%ROWTYPE;
  v_actor_type text := 'system';
  v_actor_user_id uuid;
  v_actor_user_email text;
  v_actor_apikey_id bigint;
  v_actor_apikey_name text;
  v_stats_refresh_fields constant text[] := ARRAY['stats_refresh_requested_at', 'stats_updated_at', 'updated_at'];
  v_background_counter_fields constant text[] := ARRAY['channel_device_count', 'manifest_bundle_count', 'updated_at'];
  v_fat_app_version_fields constant text[] := ARRAY['manifest', 'native_packages'];
BEGIN
  SELECT auth.uid() INTO v_actor_user_id;

  IF v_actor_user_id IS NOT NULL THEN
    v_actor_type := 'user';
  ELSE
    SELECT public.get_apikey_header() INTO v_api_key_text;

    IF v_api_key_text IS NOT NULL THEN
      SELECT *
      INTO v_api_key
      FROM public.find_apikey_by_value(v_api_key_text)
      LIMIT 1;

      -- Attribute only valid, write-capable API keys; a read-only key present on
      -- a request must not be recorded as the actor of a mutation.
      IF v_api_key.id IS NOT NULL
        AND NOT public.is_apikey_expired(v_api_key.expires_at)
        AND (
          public.is_allowed_capgkey(v_api_key_text, '{upload}'::text[])
          OR public.is_allowed_capgkey(v_api_key_text, '{write}'::text[])
          OR public.is_allowed_capgkey(v_api_key_text, '{all}'::text[])
        ) THEN
        v_actor_type := 'apikey';
        v_actor_user_id := v_api_key.user_id;
        v_actor_apikey_id := v_api_key.id;
        v_actor_apikey_name := v_api_key.name;
      END IF;
    END IF;
  END IF;

  IF v_actor_user_id IS NOT NULL THEN
    SELECT users.email
    INTO v_actor_user_email
    FROM public.users AS users
    WHERE users.id = v_actor_user_id;
  END IF;

  v_user_id := v_actor_user_id;

  -- Skip internal app_versions upload/migrate bookkeeping before the generic
  -- changed_fields walk. Compare via to_jsonb only (this trigger is shared across
  -- tables; never touch NEW.column names that only exist on app_versions).
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'app_versions' THEN
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := pg_catalog.to_jsonb(NEW);
    IF (
      v_old_record
        - 'manifest'
        - 'updated_at'
        - 'manifest_count'
        - 'storage_provider'
        - 'r2_path'
    ) IS NOT DISTINCT FROM (
      v_new_record
        - 'manifest'
        - 'updated_at'
        - 'manifest_count'
        - 'storage_provider'
        - 'r2_path'
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_old_record := NULL;
    v_new_record := pg_catalog.to_jsonb(NEW);
  ELSE
    v_old_record := pg_catalog.to_jsonb(OLD);
    v_new_record := pg_catalog.to_jsonb(NEW);

    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_new_record)
    LOOP
      IF v_old_record->v_key IS DISTINCT FROM v_new_record->v_key THEN
        v_changed_fields := pg_catalog.array_append(v_changed_fields, v_key);
      END IF;
    END LOOP;

    -- Pure updated_at bumps are bookkeeping, not user-facing audit events.
    IF v_changed_fields IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name IS DISTINCT FROM 'updated_at'
      ) THEN
      RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = ANY(ARRAY['apps', 'orgs'])
      AND v_changed_fields && ARRAY['stats_refresh_requested_at', 'stats_updated_at']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_stats_refresh_fields)
      ) THEN
      RETURN NEW;
    END IF;

    IF v_actor_type = 'system'
      AND TG_TABLE_NAME = 'apps'
      AND v_changed_fields && ARRAY['channel_device_count', 'manifest_bundle_count']
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(v_changed_fields) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(v_background_counter_fields)
      ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Never persist multi-MB array/json columns in audit TOAST.
  -- Keep fat field names in changed_fields when co-occurring with real user edits.
  IF TG_TABLE_NAME = 'app_versions' THEN
    IF v_old_record IS NOT NULL THEN
      v_old_record := v_old_record - v_fat_app_version_fields;
    END IF;
    IF v_new_record IS NOT NULL THEN
      v_new_record := v_new_record - v_fat_app_version_fields;
    END IF;

  END IF;

  IF TG_OP = 'DELETE' THEN
    CASE TG_TABLE_NAME
      WHEN 'orgs' THEN
        v_org_id := OLD.id;
        v_record_id := OLD.id::text;
      WHEN 'apps' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.app_id::text;
      WHEN 'channels' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.id::text;
      WHEN 'app_versions' THEN
        v_org_id := OLD.owner_org;
        v_record_id := OLD.id::text;
      WHEN 'org_users' THEN
        v_org_id := OLD.org_id;
        v_record_id := OLD.id::text;
      ELSE
        v_org_id := NULL;
        v_record_id := NULL;
    END CASE;
  ELSE
    CASE TG_TABLE_NAME
      WHEN 'orgs' THEN
        v_org_id := NEW.id;
        v_record_id := NEW.id::text;
      WHEN 'apps' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.app_id::text;
      WHEN 'channels' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.id::text;
      WHEN 'app_versions' THEN
        v_org_id := NEW.owner_org;
        v_record_id := NEW.id::text;
      WHEN 'org_users' THEN
        v_org_id := NEW.org_id;
        v_record_id := NEW.id::text;
      ELSE
        v_org_id := NULL;
        v_record_id := NULL;
    END CASE;
  END IF;

  IF v_org_id IS NOT NULL THEN
    INSERT INTO public.audit_logs (
      table_name,
      record_id,
      operation,
      user_id,
      org_id,
      old_record,
      new_record,
      changed_fields,
      actor_type,
      actor_user_id,
      actor_user_email,
      actor_apikey_id,
      actor_apikey_name
    ) VALUES (
      TG_TABLE_NAME,
      v_record_id,
      TG_OP,
      v_user_id,
      v_org_id,
      v_old_record,
      v_new_record,
      v_changed_fields,
      v_actor_type,
      v_actor_user_id,
      v_actor_user_email,
      v_actor_apikey_id,
      v_actor_apikey_name
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."audit_log_trigger"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."cleanup_audit_logs_bookkeeping_noise"(
  "max_batches" integer DEFAULT 100,
  "batch_size" integer DEFAULT 1000,
  "max_runtime_ms" integer DEFAULT 15000
) RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  batch_no integer := 0;
  deleted_batch integer;
  deleted_total bigint := 0;
  v_max_batches integer := GREATEST(1, COALESCE(max_batches, 100));
  v_batch_size integer := GREATEST(1, COALESCE(batch_size, 1000));
  v_max_runtime_ms integer := GREATEST(1000, COALESCE(max_runtime_ms, 15000));
  started_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('statement_timeout', '0', true);

  LOOP
    batch_no := batch_no + 1;
    EXIT WHEN batch_no > v_max_batches;
    EXIT WHEN (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000) >= v_max_runtime_ms;

    DELETE FROM public.audit_logs
    WHERE ctid IN (
      SELECT al.ctid
      FROM public.audit_logs AS al
      WHERE al.operation = 'UPDATE'
        AND al.changed_fields IS NOT NULL
        AND (
          NOT EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(al.changed_fields) AS changed_field(field_name)
            WHERE changed_field.field_name IS DISTINCT FROM 'updated_at'
          )
          OR (
            al.table_name = ANY (ARRAY['apps', 'orgs']::text[])
            AND al.changed_fields && ARRAY['stats_refresh_requested_at', 'stats_updated_at']::text[]
            AND NOT EXISTS (
              SELECT 1
              FROM pg_catalog.unnest(al.changed_fields) AS changed_field(field_name)
              WHERE changed_field.field_name <> ALL (
                ARRAY['stats_refresh_requested_at', 'stats_updated_at', 'updated_at']::text[]
              )
            )
          )
        )
      ORDER BY al.created_at
      LIMIT v_batch_size
    );

    GET DIAGNOSTICS deleted_batch = ROW_COUNT;
    deleted_total := deleted_total + deleted_batch;
    EXIT WHEN deleted_batch = 0;
  END LOOP;

  RAISE NOTICE
    'cleanup_audit_logs_bookkeeping_noise: deleted=% batches=%/% batch_size=% runtime_ms=% budget_ms=%',
    deleted_total,
    LEAST(batch_no, v_max_batches),
    v_max_batches,
    v_batch_size,
    (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000)::bigint,
    v_max_runtime_ms;

  RETURN deleted_total;
END;
$$;

ALTER FUNCTION "public"."cleanup_audit_logs_bookkeeping_noise"("max_batches" integer, "batch_size" integer, "max_runtime_ms" integer) OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."cleanup_audit_logs_bookkeeping_noise"("max_batches" integer, "batch_size" integer, "max_runtime_ms" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_audit_logs_bookkeeping_noise"("max_batches" integer, "batch_size" integer, "max_runtime_ms" integer) TO "service_role";

-- Small deployment-budget pass only; remaining rows drain via cron_tasks.
SELECT public.cleanup_audit_logs_bookkeeping_noise(10, 1000, 5000);

INSERT INTO public.cron_tasks (
  name,
  description,
  task_type,
  target,
  batch_size,
  payload,
  second_interval,
  minute_interval,
  hour_interval,
  run_at_hour,
  run_at_minute,
  run_at_second,
  run_on_dow,
  run_on_day,
  enabled
) VALUES (
  'cleanup_audit_logs_bookkeeping_noise',
  'Delete updated_at-only and apps/orgs stats-refresh audit_logs noise in bounded batches',
  'function',
  'public.cleanup_audit_logs_bookkeeping_noise()',
  NULL,
  NULL,
  NULL,
  NULL,
  1,
  NULL,
  15,
  NULL,
  NULL,
  NULL,
  true
)
ON CONFLICT (name) DO UPDATE
SET
  description = EXCLUDED.description,
  task_type = EXCLUDED.task_type,
  target = EXCLUDED.target,
  hour_interval = EXCLUDED.hour_interval,
  run_at_minute = EXCLUDED.run_at_minute,
  enabled = true,
  updated_at = pg_catalog.now();
