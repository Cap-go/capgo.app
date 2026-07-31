-- Route queue trigger jobs to Cloudflare by default and keep app_versions
-- queue payloads small by omitting the inline manifest jsonb column.
-- Manifest rows are reloaded from app_versions when on_version_update needs them.

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
    WHEN lower(TG_ARGV[1]) = 'supabase' THEN 'cloudflare'
    ELSE TG_ARGV[1]
  END;

  record_payload := to_jsonb(NEW);
  old_record_payload := to_jsonb(OLD);

  -- app_versions.manifest can be multi-MB. Never enqueue it; handlers reload when needed.
  IF TG_TABLE_NAME = 'app_versions' THEN
    IF record_payload IS NOT NULL THEN
      record_payload := record_payload - 'manifest';
    END IF;
    IF old_record_payload IS NOT NULL THEN
      old_record_payload := old_record_payload - 'manifest';
    END IF;
  END IF;

  payload := jsonb_build_object(
    'function_name', TG_ARGV[0],
    'function_type', function_type,
    'payload', jsonb_build_object(
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
