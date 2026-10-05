-- Internal physical-key inventory. Existing uploads and cleanup stay intact.
CREATE TYPE public.r2_object_state AS ENUM (
    'to_be_uploaded', 'present', 'to_be_deleted', 'deleted'
);
ALTER TYPE public.r2_object_state OWNER TO postgres;
REVOKE ALL ON TYPE public.r2_object_state FROM public;
GRANT USAGE ON TYPE public.r2_object_state TO service_role;

CREATE TABLE public.r2_objects (
    bucket_name text NOT NULL,
    r2_key text COLLATE "C" NOT NULL,
    r2_state public.r2_object_state NOT NULL,
    size_bytes bigint,
    etag text,
    r2_last_modified_at timestamptz,
    last_event_at timestamptz,
    last_reconciled_at timestamptz,
    tombstone_expires_at timestamptz,
    cleanup_requested_at timestamptz,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    revision bigint NOT NULL DEFAULT 1,
    CONSTRAINT r2_objects_pkey PRIMARY KEY (bucket_name, r2_key),
    CONSTRAINT r2_objects_bucket_check CHECK (
        octet_length(bucket_name) BETWEEN 1 AND 256
    ),
    CONSTRAINT r2_objects_key_check CHECK (
        octet_length(r2_key) BETWEEN 1 AND 1024
    ),
    CONSTRAINT r2_objects_size_check CHECK (
        size_bytes IS NULL OR size_bytes >= 0
    ),
    CONSTRAINT r2_objects_cleanup_check CHECK (
        cleanup_requested_at IS NULL OR r2_state IN ('to_be_deleted', 'deleted')
    ),
    CONSTRAINT r2_objects_revision_check CHECK (revision > 0),
    CONSTRAINT r2_objects_tombstone_check CHECK (
        (r2_state = 'deleted' AND tombstone_expires_at IS NOT NULL)
        OR (r2_state <> 'deleted' AND tombstone_expires_at IS NULL)
    )
);
ALTER TABLE public.r2_objects OWNER TO postgres;
ALTER TABLE public.r2_objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY r2_objects_service_role
ON public.r2_objects
TO service_role USING (TRUE) WITH CHECK (TRUE);
REVOKE ALL ON TABLE public.r2_objects FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.r2_objects TO service_role;

CREATE INDEX r2_objects_expired_tombstones_idx
ON public.r2_objects (bucket_name, tombstone_expires_at, r2_key)
WHERE r2_state = 'deleted'::public.r2_object_state
AND cleanup_requested_at IS NULL;

COMMENT ON TABLE public.r2_objects IS
'Internal physical-key inventory, including unreferenced objects. '
'Excluded from regional publications; manifest references remain separate.';
COMMENT ON COLUMN public.r2_objects.last_event_at IS
'Latest accepted R2 eventTime, not the notification processing time.';
COMMENT ON COLUMN public.r2_objects.last_reconciled_at IS
'Conservative request-start boundary of an applied direct R2 observation.';
COMMENT ON COLUMN public.r2_objects.r2_state IS
'Four-state lifecycle; to_be_deleted is irreversible. '
'Worker progress belongs to its queue.';

-- Runs once per changed row on internal writes. It performs no table lookup,
-- permission helper call, or external operation; work is constant per row.
CREATE FUNCTION public.r2_objects_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.revision := 1;
        IF NEW.r2_state = 'to_be_deleted'::public.r2_object_state THEN
            NEW.cleanup_requested_at := pg_catalog.clock_timestamp();
        END IF;
        NEW.first_seen_at := pg_catalog.clock_timestamp();
    ELSE
        IF NEW.bucket_name IS DISTINCT FROM OLD.bucket_name
           OR NEW.r2_key IS DISTINCT FROM OLD.r2_key THEN
            RAISE EXCEPTION 'R2 physical key identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.r2_state = 'to_be_deleted'::public.r2_object_state
           AND NEW.r2_state NOT IN (
               'to_be_deleted'::public.r2_object_state,
               'deleted'::public.r2_object_state
           ) THEN
            RAISE EXCEPTION 'R2 deletion intent cannot be reversed' USING ERRCODE = '23514';
        END IF;
        NEW.cleanup_requested_at := OLD.cleanup_requested_at;
        IF NEW.r2_state = 'to_be_deleted'::public.r2_object_state THEN
            NEW.cleanup_requested_at := COALESCE(OLD.cleanup_requested_at, pg_catalog.clock_timestamp());
        END IF;
        IF NEW.cleanup_requested_at IS NOT NULL AND NEW.r2_state NOT IN (
            'to_be_deleted'::public.r2_object_state, 'deleted'::public.r2_object_state
        ) THEN
            RAISE EXCEPTION 'R2 cleanup retirement cannot be reversed' USING ERRCODE = '23514';
        END IF;
        NEW.revision := OLD.revision + 1;
        NEW.first_seen_at := OLD.first_seen_at;
    END IF;
    NEW.updated_at := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;
ALTER FUNCTION public.r2_objects_before_write() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.r2_objects_before_write() FROM public,
anon,
authenticated,
service_role;
CREATE TRIGGER r2_objects_before_write
BEFORE INSERT OR UPDATE ON public.r2_objects
FOR EACH ROW EXECUTE FUNCTION public.r2_objects_before_write();

-- Bounded operational progress, separate from configuration and event history.
CREATE TABLE public.r2_inventory_checkpoints (
    bucket_name text NOT NULL,
    job_name text NOT NULL,
    partition_key text COLLATE "C" NOT NULL DEFAULT '',
    accepted_event_floor timestamptz,
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT r2_inventory_checkpoints_pkey PRIMARY KEY (
        bucket_name, job_name, partition_key
    ),
    CONSTRAINT r2_inventory_checkpoints_bucket_check CHECK (
        octet_length(bucket_name) BETWEEN 1 AND 256
    ),
    CONSTRAINT r2_inventory_checkpoints_job_check CHECK (
        octet_length(job_name) BETWEEN 1 AND 256
    ),
    CONSTRAINT r2_inventory_checkpoints_partition_check CHECK (
        octet_length(partition_key) <= 1024
    ),
    CONSTRAINT r2_inventory_checkpoints_data_check CHECK (
        jsonb_typeof(checkpoint) = 'object'
        AND pg_column_size(checkpoint) <= 65536
    ),
    CONSTRAINT r2_inventory_checkpoints_floor_check CHECK (
        (
            job_name = 'admission'
            AND partition_key = ''
            AND accepted_event_floor IS NOT NULL
        )
        OR (job_name <> 'admission' AND accepted_event_floor IS NULL)
    )
);
ALTER TABLE public.r2_inventory_checkpoints OWNER TO postgres;
ALTER TABLE public.r2_inventory_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY r2_inventory_checkpoints_service_role
ON public.r2_inventory_checkpoints
TO service_role USING (TRUE) WITH CHECK (TRUE);
REVOKE ALL ON TABLE public.r2_inventory_checkpoints FROM public,
anon,
authenticated;
GRANT SELECT,
INSERT,
UPDATE,
DELETE ON TABLE public.r2_inventory_checkpoints TO service_role;
COMMENT ON TABLE public.r2_inventory_checkpoints IS
'Internal resumable scan checkpoints and per-bucket event-admission floors. '
'Runtime settings remain Vault-backed.';


-- Constant-time guards on a bounded operational table; no resource-table scan.
CREATE FUNCTION public.r2_inventory_checkpoints_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.job_name = 'admission' THEN
            RAISE EXCEPTION 'R2 admission history cannot be removed' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.bucket_name IS DISTINCT FROM OLD.bucket_name
           OR NEW.job_name IS DISTINCT FROM OLD.job_name
           OR NEW.partition_key IS DISTINCT FROM OLD.partition_key THEN
            RAISE EXCEPTION 'R2 checkpoint identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.accepted_event_floor IS NOT NULL AND (
            NEW.accepted_event_floor IS NULL
            OR NEW.accepted_event_floor < OLD.accepted_event_floor
        ) THEN
            RAISE EXCEPTION 'R2 admission floor cannot decrease' USING ERRCODE = '23514';
        END IF;
    END IF;
    NEW.updated_at := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;
ALTER FUNCTION public.r2_inventory_checkpoints_before_write() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.r2_inventory_checkpoints_before_write()
FROM public, anon, authenticated, service_role;
CREATE TRIGGER r2_inventory_checkpoints_before_write
BEFORE INSERT OR UPDATE OR DELETE ON public.r2_inventory_checkpoints
FOR EACH ROW EXECUTE FUNCTION public.r2_inventory_checkpoints_before_write();
