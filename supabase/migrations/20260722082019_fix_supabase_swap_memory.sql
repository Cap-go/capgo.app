-- Reduce Capgo-EU swap pressure without upgrading compute:
-- 1) batched pgmq archive cleanup (2-day retention, hourly)
-- 2) reclaim net._http_response (truncate hourly)
-- 3) slim audit payloads + batched 30-day audit cleanup
-- 4) null leftover app_versions.manifest arrays after table migration
-- 5) also omit native_packages from app_versions queue payloads

-- ---------------------------------------------------------------------------
-- Batched pgmq archive / stuck-message cleanup
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."cleanup_queue_messages"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  queue_name text;
  cutoff timestamptz := pg_catalog.now() - INTERVAL '2 days';
  batch_size integer := 10000;
  -- Hard cap of productive batches across ALL queues/phases for one invocation.
  max_batches_total integer := 40;
  batches_used integer := 0;
  deleted_batch integer;
  deleted_archived_total bigint := 0;
  deleted_stuck_total bigint := 0;
  did_work boolean;
BEGIN
  -- Round-robin: at most one archive batch and one stuck batch per queue per pass,
  -- so a busy first queue cannot starve later queues within the global budget.
  LOOP
    EXIT WHEN batches_used >= max_batches_total;
    did_work := false;

    FOR queue_name IN (
      SELECT q.queue_name FROM pgmq.list_queues() q
    ) LOOP
      EXIT WHEN batches_used >= max_batches_total;

      EXECUTE pg_catalog.format(
        'DELETE FROM pgmq.a_%I
         WHERE ctid IN (
           SELECT ctid
           FROM pgmq.a_%I
           WHERE archived_at < $1
           LIMIT $2
         )',
        queue_name,
        queue_name
      )
      USING cutoff, batch_size;

      GET DIAGNOSTICS deleted_batch = ROW_COUNT;
      IF deleted_batch > 0 THEN
        batches_used := batches_used + 1;
        deleted_archived_total := deleted_archived_total + deleted_batch;
        did_work := true;
      END IF;

      IF batches_used >= max_batches_total THEN
        EXIT; -- leave queue loop; do not start stuck deletes over budget
      END IF;

      EXECUTE pg_catalog.format(
        'DELETE FROM pgmq.q_%I
         WHERE ctid IN (
           SELECT ctid
           FROM pgmq.q_%I
           WHERE read_ct > 5
           LIMIT $1
         )',
        queue_name,
        queue_name
      )
      USING batch_size;

      GET DIAGNOSTICS deleted_batch = ROW_COUNT;
      IF deleted_batch > 0 THEN
        batches_used := batches_used + 1;
        deleted_stuck_total := deleted_stuck_total + deleted_batch;
        did_work := true;
      END IF;
    END LOOP;

    EXIT WHEN NOT did_work;
  END LOOP;

  RAISE NOTICE
    'cleanup_queue_messages: archived_deleted=% stuck_deleted=% batches_used=%/%',
    deleted_archived_total,
    deleted_stuck_total,
    batches_used,
    max_batches_total;
END;
$$;

ALTER FUNCTION "public"."cleanup_queue_messages"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."cleanup_queue_messages"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_queue_messages"() TO "service_role";

-- ---------------------------------------------------------------------------
-- Reclaim pg_net response bloat (DELETE alone never shrinks the table)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."cleanup_net_http_response"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  -- Responses are only used for short-lived async HTTP debugging.
  -- Truncate reclaims disk; row deletes do not.
  TRUNCATE TABLE net._http_response;
  RAISE NOTICE 'cleanup_net_http_response: truncated net._http_response';
END;
$$;

ALTER FUNCTION "public"."cleanup_net_http_response"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."cleanup_net_http_response"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_net_http_response"() TO "service_role";

-- ---------------------------------------------------------------------------
-- Batched audit log cleanup (30-day retention)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."cleanup_old_audit_logs"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  cutoff timestamptz := pg_catalog.now() - INTERVAL '30 days';
  batch_size integer := 5000;
  max_batches integer := 40;
  batch_no integer := 0;
  deleted_batch integer;
  deleted_total bigint := 0;
BEGIN
  LOOP
    batch_no := batch_no + 1;
    EXIT WHEN batch_no > max_batches;

    DELETE FROM public.audit_logs
    WHERE ctid IN (
      SELECT ctid
      FROM public.audit_logs
      WHERE created_at < cutoff
      LIMIT batch_size
    );

    GET DIAGNOSTICS deleted_batch = ROW_COUNT;
    deleted_total := deleted_total + deleted_batch;
    EXIT WHEN deleted_batch = 0;
  END LOOP;

  RAISE NOTICE 'cleanup_old_audit_logs: deleted=% max_batches=%', deleted_total, max_batches;
END;
$$;

ALTER FUNCTION "public"."cleanup_old_audit_logs"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."cleanup_old_audit_logs"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_old_audit_logs"() TO "service_role";

-- ---------------------------------------------------------------------------
-- Null leftover dual-storage app_versions.manifest arrays
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."null_migrated_app_version_manifests"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  batch_size integer := 200;
  max_batches integer := 50;
  batch_no integer := 0;
  updated_batch integer;
  updated_total bigint := 0;
BEGIN
  LOOP
    batch_no := batch_no + 1;
    EXIT WHEN batch_no > max_batches;

    WITH doomed AS (
      SELECT av.id
      FROM public.app_versions AS av
      WHERE av.manifest IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(av.manifest) AS entry(file_name, s3_path, file_hash)
          WHERE NOT EXISTS (
            SELECT 1
            FROM public.manifest AS m
            WHERE m.app_version_id = av.id
              -- Match stable identity; file_name may have been normalized at migrate time.
              AND m.s3_path = entry.s3_path
              AND m.file_hash = entry.file_hash
          )
        )
      ORDER BY av.id
      LIMIT batch_size
    )
    UPDATE public.app_versions AS av
    SET manifest = NULL
    FROM doomed
    WHERE av.id = doomed.id;

    GET DIAGNOSTICS updated_batch = ROW_COUNT;
    updated_total := updated_total + updated_batch;
    EXIT WHEN updated_batch = 0;
  END LOOP;

  RAISE NOTICE
    'null_migrated_app_version_manifests: updated=% max_batches=%',
    updated_total,
    max_batches;
END;
$$;

ALTER FUNCTION "public"."null_migrated_app_version_manifests"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."null_migrated_app_version_manifests"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."null_migrated_app_version_manifests"() TO "service_role";

-- ---------------------------------------------------------------------------
-- Slim audit payloads (app_versions fat columns)
-- ---------------------------------------------------------------------------
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
  -- Keep fat field names in changed_fields so upload-time edits remain visible.
  IF TG_TABLE_NAME = 'app_versions' THEN
    IF v_old_record IS NOT NULL THEN
      v_old_record := v_old_record - v_fat_app_version_fields;
    END IF;
    IF v_new_record IS NOT NULL THEN
      v_new_record := v_new_record - v_fat_app_version_fields;
    END IF;

    -- Skip audit only for dual-storage reclaim: non-null manifest -> NULL (+ updated_at).
    IF TG_OP = 'UPDATE'
      AND OLD.manifest IS NOT NULL
      AND NEW.manifest IS NULL
      AND NEW.native_packages IS NOT DISTINCT FROM OLD.native_packages
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(COALESCE(v_changed_fields, ARRAY[]::text[])) AS changed_field(field_name)
        WHERE changed_field.field_name <> ALL(ARRAY['manifest', 'updated_at']::text[])
      ) THEN
      RETURN NEW;
    END IF;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'orgs' THEN
      v_org_id := COALESCE(NEW.id, OLD.id);
      v_record_id := COALESCE(NEW.id, OLD.id)::text;
    WHEN 'apps' THEN
      v_org_id := COALESCE(NEW.owner_org, OLD.owner_org);
      v_record_id := COALESCE(NEW.app_id, OLD.app_id)::text;
    WHEN 'channels' THEN
      v_org_id := COALESCE(NEW.owner_org, OLD.owner_org);
      v_record_id := COALESCE(NEW.id, OLD.id)::text;
    WHEN 'app_versions' THEN
      v_org_id := COALESCE(NEW.owner_org, OLD.owner_org);
      v_record_id := COALESCE(NEW.id, OLD.id)::text;
    WHEN 'org_users' THEN
      v_org_id := COALESCE(NEW.org_id, OLD.org_id);
      v_record_id := COALESCE(NEW.id, OLD.id)::text;
    ELSE
      v_org_id := NULL;
      v_record_id := NULL;
  END CASE;

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

  RETURN COALESCE(NEW, OLD);
END;
$$;

ALTER FUNCTION "public"."audit_log_trigger"() OWNER TO "postgres";

-- ---------------------------------------------------------------------------
-- Also omit native_packages from app_versions queue payloads
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."trigger_http_queue_post_to_function"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  payload jsonb;
  record_payload jsonb;
  old_record_payload jsonb;
  function_type text;
BEGIN
  function_type := CASE
    WHEN NULLIF(TG_ARGV[1], '') IS NULL THEN 'cloudflare'
    WHEN pg_catalog.lower(TG_ARGV[1]) = 'supabase' THEN 'cloudflare'
    ELSE TG_ARGV[1]
  END;

  record_payload := pg_catalog.to_jsonb(NEW);
  old_record_payload := pg_catalog.to_jsonb(OLD);

  -- app_versions fat columns can be multi-MB. Never enqueue them; handlers reload when needed.
  IF TG_TABLE_NAME = 'app_versions' THEN
    IF record_payload IS NOT NULL THEN
      record_payload := record_payload - 'manifest' - 'native_packages';
    END IF;
    IF old_record_payload IS NOT NULL THEN
      old_record_payload := old_record_payload - 'manifest' - 'native_packages';
    END IF;

    -- Skip queue fan-out only for dual-storage reclaim: non-null manifest -> NULL.
    -- native_packages is stripped from payloads, so compare it explicitly.
    IF TG_OP = 'UPDATE'
      AND OLD.manifest IS NOT NULL
      AND NEW.manifest IS NULL
      AND NEW.native_packages IS NOT DISTINCT FROM OLD.native_packages
      AND (record_payload - 'updated_at') IS NOT DISTINCT FROM (old_record_payload - 'updated_at')
    THEN
      RETURN NEW;
    END IF;
  END IF;

  payload := pg_catalog.jsonb_build_object(
    'function_name', TG_ARGV[0],
    'function_type', function_type,
    'payload', pg_catalog.jsonb_build_object(
      'old_record', old_record_payload,
      'record', record_payload,
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA
    )
  );

  IF TG_ARGV[0] IS NOT NULL THEN
    PERFORM "pgmq"."send"(TG_ARGV[0], payload);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."trigger_http_queue_post_to_function"() OWNER TO "postgres";

-- ---------------------------------------------------------------------------
-- Cron schedules: make reclaim jobs hourly / reliable
-- ---------------------------------------------------------------------------
UPDATE public.cron_tasks
SET
  second_interval = NULL,
  minute_interval = NULL,
  hour_interval = 1,
  run_at_hour = NULL,
  run_at_minute = 0,
  run_at_second = NULL,
  updated_at = pg_catalog.now()
WHERE name = 'cleanup_queue_messages';

UPDATE public.cron_tasks
SET
  second_interval = NULL,
  minute_interval = NULL,
  hour_interval = NULL,
  run_at_hour = 3,
  run_at_minute = 0,
  run_at_second = 0,
  updated_at = pg_catalog.now()
WHERE name = 'cleanup_old_audit_logs';

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
)
VALUES
  (
    'cleanup_net_http_response',
    'Truncate net._http_response so pg_net response history cannot bloat disk/RAM',
    'function',
    'public.cleanup_net_http_response()',
    NULL,
    NULL,
    NULL,
    NULL,
    1,
    NULL,
    5,
    NULL,
    NULL,
    NULL,
    true
  ),
  (
    'null_migrated_app_version_manifests',
    'Null leftover app_versions.manifest arrays after rows exist in public.manifest',
    'function',
    'public.null_migrated_app_version_manifests()',
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
  run_at_hour = NULL,
  second_interval = NULL,
  minute_interval = NULL,
  enabled = true,
  updated_at = pg_catalog.now();



UPDATE public.cron_tasks
SET
  description = 'Delete audit_logs older than 30 days in bounded batches',
  updated_at = pg_catalog.now()
WHERE name = 'cleanup_old_audit_logs';


-- ---------------------------------------------------------------------------
-- Allow clearing dual-storage app_versions.manifest after upload (null only).
-- native_packages stays locked: no alternate persisted source of truth.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."check_encrypted_bundle_on_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  org_id uuid;
  org_enforcing boolean;
  org_required_key varchar(21);
  bundle_is_encrypted boolean;
  bundle_key_id varchar(20);
  bundle_was_ready boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Never drop the only copy of legacy file metadata, ready or not.
    IF NEW.manifest IS NULL
      AND OLD.manifest IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(OLD.manifest) AS entry(file_name, s3_path, file_hash)
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.manifest AS m
          WHERE m.app_version_id = OLD.id
            -- Match stable identity; file_name may have been normalized at migrate time.
            AND m.s3_path = entry.s3_path
            AND m.file_hash = entry.file_hash
        )
      )
    THEN
      RAISE EXCEPTION '%',
        'bundle_manifest_not_migrated: Cannot clear app_versions.manifest '
        || 'until every entry exists in public.manifest.';
    END IF;

    bundle_was_ready := OLD.storage_provider IS DISTINCT FROM 'r2-direct';

    -- Nulling a fully migrated dual-storage manifest array is allowed after upload.
    -- native_packages remains locked (compatibility metadata has no table copy).
    -- Rewriting non-null manifest content stays locked.
    IF bundle_was_ready
      AND (
        NEW.name IS DISTINCT FROM OLD.name
        OR NEW.app_id IS DISTINCT FROM OLD.app_id
        OR NEW.session_key IS DISTINCT FROM OLD.session_key
        OR NEW.key_id IS DISTINCT FROM OLD.key_id
        OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
        OR NEW.r2_path IS DISTINCT FROM OLD.r2_path
        OR NEW.external_url IS DISTINCT FROM OLD.external_url
        OR NEW.checksum IS DISTINCT FROM OLD.checksum
        OR (NEW.manifest IS DISTINCT FROM OLD.manifest AND NEW.manifest IS NOT NULL)
        -- Nulling is allowed only when public.manifest has every expected entry.
        OR (
          NEW.manifest IS NULL
          AND OLD.manifest IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(OLD.manifest) AS entry(file_name, s3_path, file_hash)
            WHERE NOT EXISTS (
              SELECT 1
              FROM public.manifest AS m
              WHERE m.app_version_id = OLD.id
                -- Match stable identity; file_name may have been normalized at migrate time.
                AND m.s3_path = entry.s3_path
                AND m.file_hash = entry.file_hash
            )
          )
        )
        OR NEW.native_packages IS DISTINCT FROM OLD.native_packages
      )
    THEN
      PERFORM public.pg_log('deny: BUNDLE_CONTENT_LOCKED_TRIGGER',
        pg_catalog.jsonb_build_object(
          'org_id', OLD.owner_org,
          'app_id', OLD.app_id,
          'version_name', OLD.name,
          'user_id', OLD.user_id,
          'old_storage_provider', OLD.storage_provider,
          'new_storage_provider', NEW.storage_provider,
          'reason', 'bundle_ready'
        ));
      RAISE EXCEPTION '%',
        'bundle_already_ready: Bundle content cannot be changed '
        || 'after upload is complete. Upload a new bundle instead.';
    END IF;
  END IF;

  -- Fully migrated dual-storage nulling must not re-run encryption enforcement.
  -- Incomplete nulling (still missing public.manifest rows) must not bypass checks,
  -- including for in-progress r2-direct uploads.
  IF TG_OP = 'UPDATE'
    AND NEW.session_key IS NOT DISTINCT FROM OLD.session_key
    AND NEW.key_id IS NOT DISTINCT FROM OLD.key_id
    AND NEW.name IS NOT DISTINCT FROM OLD.name
    AND NEW.app_id IS NOT DISTINCT FROM OLD.app_id
    AND NEW.storage_provider IS NOT DISTINCT FROM OLD.storage_provider
    AND NEW.r2_path IS NOT DISTINCT FROM OLD.r2_path
    AND NEW.external_url IS NOT DISTINCT FROM OLD.external_url
    AND NEW.checksum IS NOT DISTINCT FROM OLD.checksum
    AND NEW.native_packages IS NOT DISTINCT FROM OLD.native_packages
    AND (
      NEW.manifest IS NOT DISTINCT FROM OLD.manifest
      OR (
        NEW.manifest IS NULL
        AND OLD.manifest IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(OLD.manifest) AS entry(file_name, s3_path, file_hash)
          WHERE NOT EXISTS (
            SELECT 1
            FROM public.manifest AS m
            WHERE m.app_version_id = OLD.id
              -- Match stable identity; file_name may have been normalized at migrate time.
              AND m.s3_path = entry.s3_path
              AND m.file_hash = entry.file_hash
          )
        )
      )
    )
  THEN
    RETURN NEW;
  END IF;

  -- Derive org_id from NEW.app_id first because
  -- force_valid_owner_org_app_versions runs after this trigger.
  SELECT apps.owner_org INTO org_id
  FROM public.apps
  WHERE apps.app_id = NEW.app_id;

  IF org_id IS NULL THEN
    org_id := NEW.owner_org;
  END IF;

  -- If org not found, allow the existing foreign-key/owner checks to fail.
  IF org_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT enforce_encrypted_bundles, required_encryption_key
  INTO org_enforcing, org_required_key
  FROM public.orgs
  WHERE id = org_id;

  IF org_enforcing IS NULL OR org_enforcing = false THEN
    RETURN NEW;
  END IF;

  bundle_is_encrypted := public.is_bundle_encrypted(NEW.session_key);
  bundle_key_id := NULLIF(pg_catalog.btrim(NEW.key_id), '')::varchar(20);

  IF NOT bundle_is_encrypted THEN
    PERFORM public.pg_log('deny: ORG_REQUIRES_ENCRYPTED_BUNDLES_TRIGGER',
      pg_catalog.jsonb_build_object(
        'org_id', org_id,
        'app_id', NEW.app_id,
        'version_name', NEW.name,
        'user_id', NEW.user_id,
        'reason', 'not_encrypted'
      ));
    RAISE EXCEPTION '%',
      'encryption_required: This organization requires all bundles to be '
      || 'encrypted. Please upload an encrypted bundle with a session_key.';
  END IF;

  IF org_required_key IS NOT NULL AND org_required_key <> '' THEN
    IF bundle_key_id IS NULL THEN
      PERFORM public.pg_log('deny: ORG_REQUIRES_SPECIFIC_ENCRYPTION_KEY_TRIGGER',
        pg_catalog.jsonb_build_object(
          'org_id', org_id,
          'app_id', NEW.app_id,
          'version_name', NEW.name,
          'user_id', NEW.user_id,
          'required_key', org_required_key,
          'bundle_key_id', bundle_key_id,
          'reason', 'missing_key_id'
        ));
      RAISE EXCEPTION '%',
        'encryption_key_required: This organization requires bundles to be '
        || 'encrypted with a specific key. The uploaded bundle does not have '
        || 'a key_id.';
    END IF;

    -- key_id is 20 chars and required_encryption_key may be 20 or 21 chars.
    IF NOT (
      bundle_key_id = pg_catalog.left(org_required_key, 20)
      OR pg_catalog.left(bundle_key_id, pg_catalog.length(org_required_key)) = org_required_key
    ) THEN
      PERFORM public.pg_log('deny: ORG_REQUIRES_SPECIFIC_ENCRYPTION_KEY_TRIGGER',
        pg_catalog.jsonb_build_object(
          'org_id', org_id,
          'app_id', NEW.app_id,
          'version_name', NEW.name,
          'user_id', NEW.user_id,
          'required_key', org_required_key,
          'bundle_key_id', bundle_key_id,
          'reason', 'key_mismatch'
        ));
      RAISE EXCEPTION '%',
        'encryption_key_mismatch: This organization requires bundles to be '
        || 'encrypted with a specific key. The uploaded bundle was encrypted '
        || 'with a different key.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."check_encrypted_bundle_on_insert"() OWNER TO "postgres";
