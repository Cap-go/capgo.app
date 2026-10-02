-- Cron 'queue' tasks enqueue a static tick message ("run this job now"). When
-- the drain processes one message per tick (cron_app_fame drains batch_size 1
-- every 15 minutes, matching its enqueue interval), every failed or skipped
-- drain leaves one extra tick behind forever: the backlog can never catch up,
-- and queue health reports never_read_stale even though the consumer is fine.
-- Ticks carry no data, so skip the enqueue while an identical tick is still
-- waiting unread. Ticks already read (in flight or retrying) do not block the
-- next one, so a slow or failing run still gets a fresh tick afterwards.
CREATE OR REPLACE FUNCTION public.enqueue_cron_tick(
    "queue_name" text, "payload" jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  tick_pending boolean;
BEGIN
  EXECUTE pg_catalog.format(
    'SELECT EXISTS (SELECT 1 FROM pgmq.%I WHERE read_ct = 0 AND message = $1)',
    'q_' || queue_name
  )
  INTO tick_pending
  USING payload;

  IF NOT tick_pending THEN
    PERFORM pgmq.send(queue_name, payload);
  END IF;
END;
$$;

ALTER FUNCTION public.enqueue_cron_tick(text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_cron_tick(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_cron_tick(text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_cron_tick(text, jsonb) FROM authenticated;
GRANT ALL ON FUNCTION public.enqueue_cron_tick(text, jsonb) TO service_role;

COMMENT ON FUNCTION public.enqueue_cron_tick(text, jsonb) IS
'Enqueue a cron tick unless an identical unread tick is already waiting, '
'so tick backlogs cannot accumulate.';

CREATE OR REPLACE FUNCTION public.process_all_cron_tasks() RETURNS void
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  current_hour int;
  current_minute int;
  current_second int;
  current_dow int;
  current_day int;
  task RECORD;
  queue_names text[];
  should_run boolean;
  lock_acquired boolean;
BEGIN
  lock_acquired := pg_catalog.pg_try_advisory_lock(1);

  IF NOT lock_acquired THEN
    RAISE NOTICE 'process_all_cron_tasks: skipped, another instance is already running';
    RETURN;
  END IF;

  BEGIN
    current_hour := EXTRACT(HOUR FROM NOW());
    current_minute := EXTRACT(MINUTE FROM NOW());
    current_second := EXTRACT(SECOND FROM NOW());
    current_dow := EXTRACT(DOW FROM NOW());
    current_day := EXTRACT(DAY FROM NOW());

    FOR task IN SELECT * FROM public.cron_tasks WHERE enabled = true ORDER BY id LOOP
      should_run := false;

      IF task.second_interval IS NOT NULL THEN
        should_run := true;
      ELSIF task.minute_interval IS NOT NULL THEN
        should_run := (current_minute % task.minute_interval = 0)
                      AND (current_second < 10);
      ELSIF task.hour_interval IS NOT NULL THEN
        should_run := (current_hour % task.hour_interval = 0)
                      AND (current_minute = COALESCE(task.run_at_minute, 0))
                      AND (current_second < 10);
      ELSIF task.run_at_hour IS NOT NULL THEN
        should_run := (current_hour = task.run_at_hour)
                      AND (current_minute = COALESCE(task.run_at_minute, 0))
                      AND (current_second < 10);

        IF should_run AND task.run_on_dow IS NOT NULL THEN
          should_run := (current_dow = task.run_on_dow);
        END IF;

        IF should_run AND task.run_on_day IS NOT NULL THEN
          should_run := (current_day = task.run_on_day);
        END IF;
      END IF;

      IF should_run THEN
        BEGIN
          CASE task.task_type
            WHEN 'function' THEN
              EXECUTE 'SELECT ' || task.target;

            WHEN 'queue' THEN
              PERFORM public.enqueue_cron_tick(
                task.target,
                COALESCE(task.payload, jsonb_build_object('function_name', task.target))
              );

            WHEN 'function_queue' THEN
              SELECT array_agg(value::text) INTO queue_names
              FROM jsonb_array_elements_text(task.target::jsonb);

              IF task.batch_size IS NOT NULL THEN
                PERFORM public.process_function_queue(queue_names, task.batch_size);
              ELSE
                PERFORM public.process_function_queue(queue_names);
              END IF;
          END CASE;
        EXCEPTION
          WHEN query_canceled THEN
            RAISE WARNING 'cron task "%" canceled (timeout): %', task.name, SQLERRM;
          WHEN OTHERS THEN
            RAISE WARNING 'cron task "%" failed: %', task.name, SQLERRM;
        END;
      END IF;
    END LOOP;

    IF current_minute % 5 = 0 AND current_second < 10 THEN
      PERFORM public.enqueue_cron_tick(
        'cron_rollout_auto_pause',
        jsonb_build_object(
          'function_name', 'cron_rollout_auto_pause',
          'function_type', 'cloudflare'
        )
      );
    END IF;

    PERFORM public.process_function_queue(ARRAY['cron_rollout_auto_pause']);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.pg_advisory_unlock(1);
    RAISE;
  END;

  PERFORM pg_catalog.pg_advisory_unlock(1);
END;
$$;

ALTER FUNCTION public.process_all_cron_tasks() OWNER TO postgres;
