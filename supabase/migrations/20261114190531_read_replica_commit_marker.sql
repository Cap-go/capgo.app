-- Primary commit marker replicated to Google EU-2 and regional standbys.
-- Plugin lag probes compare now() to committed_at so a subscription stuck in an
-- apply/reconnect loop (fresh last_msg_receipt_time, no applied commits) still
-- surfaces as lagging.

SET lock_timeout = '5s';

CREATE TABLE public.read_replica_commit_marker (
    id smallint PRIMARY KEY,
    committed_at timestamp with time zone NOT NULL,
    CONSTRAINT read_replica_commit_marker_singleton CHECK (id = 1)
);

COMMENT ON TABLE public.read_replica_commit_marker IS
'Singleton row the primary updates on a schedule and logical replication copies to read replicas. Plugin workers measure replication lag as age(committed_at).';

INSERT INTO public.read_replica_commit_marker (id, committed_at)
VALUES (1, pg_catalog.now());

ALTER TABLE public.read_replica_commit_marker OWNER TO postgres;
ALTER TABLE public.read_replica_commit_marker ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.read_replica_commit_marker FROM PUBLIC;
REVOKE ALL ON TABLE public.read_replica_commit_marker FROM anon;
REVOKE ALL ON TABLE public.read_replica_commit_marker FROM authenticated;
GRANT SELECT ON TABLE public.read_replica_commit_marker TO service_role;
GRANT ALL ON TABLE public.read_replica_commit_marker TO postgres;

CREATE POLICY "Allow service role read on read_replica_commit_marker"
ON public.read_replica_commit_marker
FOR SELECT
TO service_role
USING (true);

CREATE OR REPLACE FUNCTION public.touch_read_replica_commit_marker()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    prior_at timestamp with time zone;
    stall_threshold interval := interval '60 seconds';
BEGIN
    SELECT committed_at INTO prior_at
    FROM public.read_replica_commit_marker
    WHERE id = 1;

    IF prior_at IS NOT NULL AND prior_at < pg_catalog.now() - stall_threshold THEN
        RAISE WARNING 'read_replica_commit_marker stale before touch: age %', pg_catalog.now() - prior_at;
    END IF;

    UPDATE public.read_replica_commit_marker
    SET committed_at = pg_catalog.now()
    WHERE id = 1;
END;
$$;

ALTER FUNCTION public.touch_read_replica_commit_marker() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.touch_read_replica_commit_marker() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.touch_read_replica_commit_marker() FROM anon;
REVOKE EXECUTE ON FUNCTION public.touch_read_replica_commit_marker() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.touch_read_replica_commit_marker() TO service_role;

INSERT INTO public.cron_tasks (
    name,
    description,
    task_type,
    target,
    second_interval,
    enabled
)
VALUES (
    'read_replica_commit_marker',
    'Refresh read_replica_commit_marker.committed_at for plugin replication lag probes',
    'function',
    'public.touch_read_replica_commit_marker()',
    10,
    true
);

DO $$
DECLARE
    publication_name text;
BEGIN
    FOR publication_name IN
        SELECT pubname
        FROM pg_catalog.pg_publication
        WHERE pubname IN ('capgo_google_eu_2_pub', 'capgo_google_replicate')
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_publication_tables
            WHERE pubname = publication_name
              AND schemaname = 'public'
              AND tablename = 'read_replica_commit_marker'
        ) THEN
            EXECUTE pg_catalog.format(
                'ALTER PUBLICATION %I ADD TABLE public.read_replica_commit_marker',
                publication_name
            );
        END IF;
    END LOOP;
END;
$$;