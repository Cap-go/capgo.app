-- Checkpoint schema for a fresh standalone Postgres inventory database.
-- Apply once as an administrator after creating the inventory-only runtime role.
-- Credentials and role creation are managed separately; no secrets belong here.
-- Target: PlanetScale capgo/capgo-r2-inventory, branch main, database postgres.
DO $setup$
DECLARE
    inventory_role name := 'r2_inventory_consumer';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = inventory_role) THEN
        RAISE EXCEPTION 'Inventory runtime role is missing';
    END IF;
    CREATE TABLE public.r2_inventory_checkpoints (
        bucket_name text NOT NULL,
        job_name text NOT NULL,
        partition_key text COLLATE "C" NOT NULL DEFAULT '',
        accepted_event_floor timestamptz,
        checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT r2_inventory_checkpoints_pkey PRIMARY KEY (bucket_name, job_name, partition_key),
        CONSTRAINT r2_inventory_checkpoints_bucket_check CHECK (octet_length(bucket_name) BETWEEN 1 AND 256),
        CONSTRAINT r2_inventory_checkpoints_job_check CHECK (octet_length(job_name) BETWEEN 1 AND 256),
        CONSTRAINT r2_inventory_checkpoints_partition_check CHECK (octet_length(partition_key) <= 1024),
        CONSTRAINT r2_inventory_checkpoints_data_check CHECK (
            jsonb_typeof(checkpoint) = 'object' AND pg_column_size(checkpoint) <= 65536
        ),
        CONSTRAINT r2_inventory_checkpoints_floor_check CHECK (
            (job_name = 'admission' AND partition_key = '' AND accepted_event_floor IS NOT NULL)
            OR (job_name <> 'admission' AND accepted_event_floor IS NULL)
        )
    );
    ALTER TABLE public.r2_inventory_checkpoints OWNER TO postgres;
    REVOKE ALL ON TABLE public.r2_inventory_checkpoints FROM PUBLIC;

    CREATE FUNCTION public.r2_inventory_checkpoints_before_write()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = ''
    AS $guard$
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
                NEW.accepted_event_floor IS NULL OR NEW.accepted_event_floor < OLD.accepted_event_floor
            ) THEN
                RAISE EXCEPTION 'R2 admission floor cannot decrease' USING ERRCODE = '23514';
            END IF;
        END IF;
        NEW.updated_at := pg_catalog.clock_timestamp();
        RETURN NEW;
    END;
    $guard$;
    ALTER FUNCTION public.r2_inventory_checkpoints_before_write() OWNER TO postgres;
    REVOKE ALL ON FUNCTION public.r2_inventory_checkpoints_before_write() FROM PUBLIC;
    CREATE TRIGGER r2_inventory_checkpoints_before_write
    BEFORE INSERT OR UPDATE OR DELETE ON public.r2_inventory_checkpoints
    FOR EACH ROW EXECUTE FUNCTION public.r2_inventory_checkpoints_before_write();

    -- Initialize lazily when the first production batch reaches this database.
    -- This establishes the cutover boundary without pausing or changing the old consumer.
    -- The first batch's older notifications need R2 verification because history was not copied.
    CREATE FUNCTION public.r2_inventory_initial_admission_floor()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = ''
    AS $floor$
    BEGIN
        IF NEW.job_name = 'admission' THEN
            NEW.accepted_event_floor := greatest(NEW.accepted_event_floor, pg_catalog.statement_timestamp());
        END IF;
        RETURN NEW;
    END;
    $floor$;
    ALTER FUNCTION public.r2_inventory_initial_admission_floor() OWNER TO postgres;
    REVOKE ALL ON FUNCTION public.r2_inventory_initial_admission_floor() FROM PUBLIC;
    CREATE TRIGGER r2_inventory_initial_admission_floor
    BEFORE INSERT ON public.r2_inventory_checkpoints
    FOR EACH ROW EXECUTE FUNCTION public.r2_inventory_initial_admission_floor();

    -- New application role has no administrative or database-wide inherited grants.
    EXECUTE pg_catalog.format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', inventory_role);
    EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA public FROM %I', inventory_role);
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA public TO %I', inventory_role);
    EXECUTE pg_catalog.format('GRANT USAGE ON TYPE public.r2_object_state TO %I', inventory_role);
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT, UPDATE ON public.r2_objects, public.r2_inventory_checkpoints TO %I', inventory_role);
END;
$setup$;
