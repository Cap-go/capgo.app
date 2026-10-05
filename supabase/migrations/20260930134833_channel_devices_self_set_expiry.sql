-- Only expire channel overrides that a device assigned to itself.
--
-- cleanup_old_channel_devices used to delete every channel_devices row whose
-- last write was more than 90 days ago, including overrides created from the
-- console or the Public API. Those devices then silently fell back to their
-- default channel. Overrides written by the /channel_self plugin endpoint
-- (allow_device_self_set) are the only ones that should age out.
--
-- is_self_set marks rows written by /channel_self. Existing rows are backfilled
-- as false (kept forever) because their origin is unknown. Writes that come
-- through PostgREST as anon/authenticated (console, API keys, old CLIs) are
-- always stored as not self-set, whatever the payload says.

ALTER TABLE public.channel_devices
ADD COLUMN IF NOT EXISTS is_self_set boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.channel_devices.is_self_set IS
'Written by the device through /channel_self. Only these rows expire '
'(cleanup_old_channel_devices); console/API overrides never expire.';

CREATE OR REPLACE FUNCTION public.channel_devices_force_admin_origin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- PostgREST user and API-key requests run as anon/authenticated. Those are
  -- console, Public API, or CLI writes, never device self-assignment.
  IF current_user IN ('anon', 'authenticated') THEN
    NEW.is_self_set := false;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.channel_devices_force_admin_origin()
OWNER TO postgres;
REVOKE ALL ON FUNCTION public.channel_devices_force_admin_origin()
FROM public;
GRANT ALL ON FUNCTION public.channel_devices_force_admin_origin()
TO service_role;

COMMENT ON FUNCTION public.channel_devices_force_admin_origin() IS
'Forces is_self_set = false for anon/authenticated writes (console, API '
'key, CLI) so admin overrides never expire.';

DROP TRIGGER IF EXISTS channel_devices_force_admin_origin
ON public.channel_devices;
CREATE TRIGGER channel_devices_force_admin_origin
BEFORE INSERT OR UPDATE ON public.channel_devices
FOR EACH ROW
EXECUTE FUNCTION public.channel_devices_force_admin_origin();

CREATE OR REPLACE FUNCTION public.cleanup_old_channel_devices() RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    deleted_count bigint;
    purged_count bigint;
BEGIN
    -- Disable triggers on channel_devices to avoid unnecessary queue operations during bulk cleanup
    -- This prevents the enqueue_channel_device_counts trigger from firing for each deleted row
    ALTER TABLE public.channel_devices DISABLE TRIGGER channel_device_count_enqueue;

    -- Use nested block with exception handler to ensure trigger is re-enabled on any failure
    BEGIN
        -- Only device self-assigned overrides expire, 90 days after the device last
        -- (re)wrote them. Console/API overrides are kept until explicitly removed.
        DELETE FROM public.channel_devices
        WHERE is_self_set
          AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '90 days';

        GET DIAGNOSTICS deleted_count = ROW_COUNT;

        -- Re-enable triggers before any further operations
        ALTER TABLE public.channel_devices ENABLE TRIGGER channel_device_count_enqueue;

        IF deleted_count > 0 THEN
            RAISE NOTICE 'cleanup_old_channel_devices: Deleted % stale self-set channel device entries', deleted_count;

            -- Purge any pending messages in the channel_device_counts queue before recomputing
            -- This prevents stale deltas from being applied after the full recount
            SELECT pgmq.purge_queue('channel_device_counts') INTO purged_count;
            IF purged_count > 0 THEN
                RAISE NOTICE 'cleanup_old_channel_devices: Purged % pending queue messages', purged_count;
            END IF;

            -- Recalculate channel_device_count for all apps since we bypassed the trigger
            -- This is more efficient than firing triggers for potentially thousands of rows
            UPDATE public.apps
            SET channel_device_count = COALESCE((
                SELECT COUNT(*)
                FROM public.channel_devices cd
                WHERE cd.app_id = apps.app_id
            ), 0);

            RAISE NOTICE 'cleanup_old_channel_devices: Recalculated channel_device_count for all apps';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Ensure trigger is re-enabled even on failure
        ALTER TABLE public.channel_devices ENABLE TRIGGER channel_device_count_enqueue;
        RAISE;
    END;
END;
$$;

ALTER FUNCTION public.cleanup_old_channel_devices() OWNER TO postgres;

UPDATE public.cron_tasks
SET
    description = 'Delete self-set channel overrides idle for 90 days',
    updated_at = now()
WHERE name = 'cleanup_old_channel_devices';
