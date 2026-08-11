CREATE OR REPLACE FUNCTION "public"."get_update_stats"() RETURNS TABLE("app_id" character varying, "failed" bigint, "install" bigint, "get" bigint, "success_rate" numeric, "healthy" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    RETURN QUERY
    WITH stats AS (
        SELECT
            version_usage.app_id,
            COALESCE(SUM(CASE WHEN action = 'fail' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN action = 'install' THEN 1 ELSE 0 END), 0) AS install,
            COALESCE(SUM(CASE WHEN action = 'get' THEN 1 ELSE 0 END), 0) AS get
        FROM
            public.version_usage
        WHERE
            timestamp >= (date_trunc('minute', now()) - INTERVAL '10 minutes')
            AND timestamp < (date_trunc('minute', now()) - INTERVAL '9 minutes')
        GROUP BY
            version_usage.app_id
    )
    SELECT
        stats.app_id,
        stats.failed,
        stats.install,
        stats.get,
        CASE
            WHEN (stats.install + stats.failed) > 0 THEN
                ROUND((stats.install::numeric / (stats.install + stats.failed)) * 100, 2)
            ELSE 100
        END AS success_rate,
        CASE
            WHEN (stats.install + stats.failed) > 0 THEN
                ((stats.install::numeric / (stats.install + stats.failed)) * 100 >= 70)
            ELSE true
        END AS healthy
    FROM
        stats
    WHERE
        (stats.install + stats.failed) > 0;
END;
$$;

ALTER FUNCTION "public"."get_update_stats"() OWNER TO "postgres";
