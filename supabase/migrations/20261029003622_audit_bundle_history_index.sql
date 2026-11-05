-- Bundle history counts and pages channel removals by the app and bundle in
-- old_record. The org/table indexes still visit every readable channel update
-- before applying these JSON filters. Index only version changes, then use
-- created_at for either chronological direction without sorting the matches.
CREATE INDEX idx_audit_logs_channel_old_bundle
ON public.audit_logs (
    (old_record ->> 'app_id'),
    (old_record ->> 'version'),
    created_at
)
WHERE
table_name = 'channels'
AND operation = 'UPDATE'
AND changed_fields @> ARRAY['version']::text[];

-- JSON extraction is not leakproof, so RLS prevents the table query from using
-- the JSON expressions as index conditions. Apply exactly the audit_logs SELECT
-- policy's org set here, once, before the indexed app/bundle lookup. This keeps
-- historical audit visibility across app transfers and includes no other orgs.
CREATE OR REPLACE FUNCTION public.get_bundle_channel_removals(
    p_app_id text,
    p_version_id bigint,
    p_limit integer DEFAULT 20,
    p_ascending boolean DEFAULT false,
    p_channel_ids text[] DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    allowed_orgs uuid[] := public.audit_logs_allowed_orgs();
    result jsonb;
BEGIN
    IF COALESCE(pg_catalog.cardinality(allowed_orgs), 0) = 0 THEN
        RETURN pg_catalog.jsonb_build_object('data', '[]'::jsonb, 'count', 0);
    END IF;

    WITH removals AS NOT MATERIALIZED (
        SELECT a.id, a.record_id, a.user_id, a.created_at
        FROM public.audit_logs AS a
        WHERE a.org_id = ANY(allowed_orgs)
          AND a.table_name = 'channels'
          AND a.operation = 'UPDATE'
          AND a.changed_fields @> ARRAY['version']::text[]
          AND a.old_record ->> 'app_id' = p_app_id
          AND a.old_record ->> 'version' = p_version_id::text
          AND (p_channel_ids IS NULL OR a.record_id = ANY(p_channel_ids))
    ), page AS (
        SELECT r.* FROM removals AS r
        ORDER BY
            CASE WHEN p_ascending THEN r.created_at END ASC,
            CASE WHEN NOT p_ascending THEN r.created_at END DESC
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 0), 1000)
    )
    SELECT pg_catalog.jsonb_build_object(
        'data', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p)) FROM page AS p), '[]'::jsonb),
        'count', (SELECT pg_catalog.count(*) FROM removals)
    ) INTO result;

    RETURN result;
END;
$$;

ALTER FUNCTION public.get_bundle_channel_removals(
    text, bigint, integer, boolean, text[]
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_bundle_channel_removals(
    text, bigint, integer, boolean, text[]
) FROM public,
anon,
service_role;
GRANT EXECUTE ON FUNCTION public.get_bundle_channel_removals(
    text, bigint, integer, boolean, text[]
) TO authenticated;
