-- Extend channel override retention from 1 month to 90 days.
-- channel_devices.updated_at only changes when the override is written, not when
-- the device checks for updates, and production device activity lives on the
-- read replicas (not primary PG), so we cannot gate cleanup on "recent device".

CREATE OR REPLACE FUNCTION "public"."cleanup_old_channel_devices"() RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
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
        -- Delete channel_devices where the last override write (updated_at or created_at) is older than 90 days
        DELETE FROM public.channel_devices
        WHERE COALESCE(updated_at, created_at) < NOW() - INTERVAL '90 days';

        GET DIAGNOSTICS deleted_count = ROW_COUNT;

        -- Re-enable triggers before any further operations
        ALTER TABLE public.channel_devices ENABLE TRIGGER channel_device_count_enqueue;

        IF deleted_count > 0 THEN
            RAISE NOTICE 'cleanup_old_channel_devices: Deleted % stale channel device entries', deleted_count;

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

ALTER FUNCTION "public"."cleanup_old_channel_devices"() OWNER TO "postgres";

UPDATE public.cron_tasks
SET
  description = 'Delete channel_devices older than 90 days',
  updated_at = now()
WHERE name = 'cleanup_old_channel_devices';
