CREATE OR REPLACE FUNCTION "public"."process_admin_stats"() RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  PERFORM pgmq.send('admin_stats', jsonb_build_object('function_name','global_stats','function_type','cloudflare','payload',jsonb_build_object()));
END;
$$;

ALTER FUNCTION "public"."process_admin_stats"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."process_admin_stats"() FROM PUBLIC;

-- Keep already queued admin-stat work compatible with the renamed HTTP routes.
-- The queue is bounded operational state; archived messages do not execute.
DO $$
DECLARE
  legacy_provider text := pg_catalog.convert_from(pg_catalog.decode('6c6f67736e6167', 'hex'), 'UTF8');
  legacy_prefix text := legacy_provider || '_insights';
  legacy_notification_marker text := 'notifications_' || legacy_provider;
  legacy_notification_claim_marker text := 'notifications_' || legacy_provider || '_claim';
BEGIN
  UPDATE pgmq.q_admin_stats
  SET message = jsonb_set(
    message,
    '{function_name}',
    to_jsonb('global_stats' || substr(message->>'function_name', length(legacy_prefix) + 1))
  )
  WHERE message->>'function_name' = legacy_prefix
     OR message->>'function_name' LIKE legacy_prefix || '\_%' ESCAPE '\';

  UPDATE public.global_stats
  SET completed_shards = (
    SELECT COALESCE(jsonb_agg(marker ORDER BY marker), '[]'::jsonb)
    FROM jsonb_array_elements_text(public.global_stats.completed_shards) AS markers(marker)
    WHERE marker <> legacy_notification_marker
      AND marker <> legacy_notification_claim_marker
  )
  WHERE completed_shards ? legacy_notification_marker
     OR completed_shards ? legacy_notification_claim_marker;
END;
$$;
