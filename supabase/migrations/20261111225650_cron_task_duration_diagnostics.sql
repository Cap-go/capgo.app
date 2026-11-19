-- pg_stat_statements attributes every nested job to this scheduler. Record only
-- slow job names and elapsed time, never payloads, so a future latency spike can
-- be traced to its job without logging every ten-second tick or storing rows.
-- Scheduling, queue retry budgets, grants, and task execution are unchanged.
-- Execution model: the existing privileged scheduler reads the small cron_tasks
-- configuration table once per tick; two clock reads run per due task, never
-- per customer/device/manifest row. No additional data scans or writes.
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
  task_started_at timestamptz;
  task_duration_ms numeric;
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
        task_started_at := pg_catalog.clock_timestamp();
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
        task_duration_ms := EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - task_started_at)) * 1000;
        IF task_duration_ms >= 1000 THEN
          RAISE WARNING 'cron task "%" slow: duration_ms=%', task.name, pg_catalog.round(task_duration_ms);
        END IF;
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

    task_started_at := pg_catalog.clock_timestamp();
    PERFORM public.process_function_queue(ARRAY['cron_rollout_auto_pause']);
    task_duration_ms := EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - task_started_at)) * 1000;
    IF task_duration_ms >= 1000 THEN
      RAISE WARNING 'cron task "cron_rollout_auto_pause dispatch" slow: duration_ms=%', pg_catalog.round(task_duration_ms);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.pg_advisory_unlock(1);
    RAISE;
  END;

  PERFORM pg_catalog.pg_advisory_unlock(1);
END;
$$;

ALTER FUNCTION public.process_all_cron_tasks() OWNER TO postgres;
