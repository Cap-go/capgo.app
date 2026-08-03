-- Feed active direct user-to-organization role bindings into the existing
-- function queue dispatcher.
--
-- Execution model:
-- - Where: row-level AFTER INSERT / activation-relevant UPDATE trigger on
--   public.role_bindings.
-- - Frequency: once for each qualifying INSERT or activation-relevant UPDATE.
--   Qualifying-to-qualifying updates are deliberate: tag removal is
--   idempotent, the joined event is an at-least-once fact, and a later write
--   can self-heal a previously exhausted delivery. Non-qualifying rows are
--   rejected by the trigger WHEN clause before the trigger function runs.
-- - Roles: any role allowed to write role_bindings; the existing generic
--   trigger function runs as SECURITY DEFINER.
-- - Cardinality: O(1) pgmq.send per qualifying row. The trigger performs no
--   table scan; the queue handler reloads the binding by its primary key.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pgmq.list_queues()
        WHERE queue_name = 'on_user_org_access'
    ) THEN
        PERFORM pgmq.create('on_user_org_access');
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS on_user_org_access ON public.role_bindings;

CREATE TRIGGER on_user_org_access
AFTER INSERT OR UPDATE OF
principal_type,
principal_id,
scope_type,
org_id,
expires_at,
is_direct
ON public.role_bindings
FOR EACH ROW
WHEN (
    new.principal_type = 'user'
    AND new.scope_type = 'org'
    AND new.org_id IS NOT NULL
    AND new.is_direct IS TRUE
    AND (new.expires_at IS NULL OR new.expires_at > pg_catalog.now())
)
EXECUTE FUNCTION public.trigger_http_queue_post_to_function(
    'on_user_org_access'
);

DO $$
DECLARE
    high_frequency_task_type public.cron_task_type;
    high_frequency_target jsonb;
BEGIN
    SELECT cron.task_type, cron.target::jsonb
    INTO high_frequency_task_type, high_frequency_target
    FROM public.cron_tasks AS cron
    WHERE cron.name = 'high_frequency_queues'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Required cron task high_frequency_queues is missing';
    END IF;

    IF high_frequency_task_type
        IS DISTINCT FROM 'function_queue'::public.cron_task_type THEN
        RAISE EXCEPTION
            'Cron task high_frequency_queues must use task type function_queue';
    END IF;

    IF pg_catalog.jsonb_typeof(high_frequency_target)
        IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION
            'Cron task high_frequency_queues target must be a JSON array';
    END IF;

    IF NOT (high_frequency_target ? 'on_user_org_access') THEN
        UPDATE public.cron_tasks
        SET
            target = (
                high_frequency_target || '["on_user_org_access"]'::jsonb
            )::text,
            updated_at = pg_catalog.now()
        WHERE name = 'high_frequency_queues';
    END IF;
END;
$$;
