-- Durable create counters for admin daily stats.
-- Count every app INSERT and non-internal version INSERT via PGMQ so deletes
-- later in the day do not undercount the daily totals.

ALTER TABLE public.global_stats
  ADD COLUMN IF NOT EXISTS versions_created bigint DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.global_stats.apps_created IS
  'Number of apps created during the UTC day. Event-sourced via the global_stats_creates queue so deletes later that day still count.';

COMMENT ON COLUMN public.global_stats.versions_created IS
  'Number of non-internal app versions uploaded during the UTC day. Event-sourced via the global_stats_creates queue so deletes later that day still count.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pgmq.list_queues()
    WHERE queue_name = 'global_stats_creates'
  ) THEN
    PERFORM pgmq.create('global_stats_creates');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_global_stats_creates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_metric text;
  v_date_id text;
BEGIN
  IF TG_TABLE_NAME = 'apps' THEN
    v_metric := 'apps_created';
    v_date_id := ((NEW.created_at AT TIME ZONE 'UTC')::date)::text;
  ELSIF TG_TABLE_NAME = 'app_versions' THEN
    IF NEW.name = 'builtin' OR NEW.name = 'unknown' THEN
      RETURN NEW;
    END IF;
    v_metric := 'versions_created';
    v_date_id := ((NEW.created_at AT TIME ZONE 'UTC')::date)::text;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM pgmq.send(
    'global_stats_creates',
    jsonb_build_object(
      'metric', v_metric,
      'date_id', v_date_id,
      'delta', 1
    )
  );

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enqueue_global_stats_creates() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_global_stats_creates() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.process_global_stats_creates_queue(batch_size integer DEFAULT 1000)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  message_record RECORD;
  v_payload jsonb;
  v_metric text;
  v_date_id text;
  v_delta integer;
  msg_ids bigint[] := ARRAY[]::bigint[];
  processed bigint := 0;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 THEN
    batch_size := 100;
  END IF;

  FOR message_record IN
    SELECT *
    FROM pgmq.read('global_stats_creates', 60, batch_size)
  LOOP
    v_payload := message_record.message;
    v_metric := v_payload ->> 'metric';
    v_date_id := v_payload ->> 'date_id';
    v_delta := COALESCE((v_payload ->> 'delta')::integer, 0);

    IF v_metric IS NULL
       OR v_date_id IS NULL
       OR v_date_id !~ '^\d{4}-\d{2}-\d{2}$'
       OR v_delta = 0
       OR v_metric NOT IN ('apps_created', 'versions_created') THEN
      msg_ids := array_append(msg_ids, message_record.msg_id);
      CONTINUE;
    END IF;

    IF v_metric = 'apps_created' THEN
      INSERT INTO public.global_stats (date_id, apps, updates, stars, apps_created)
      VALUES (v_date_id, 0, 0, 0, v_delta)
      ON CONFLICT (date_id) DO UPDATE
      SET apps_created = public.global_stats.apps_created + EXCLUDED.apps_created;
    ELSE
      INSERT INTO public.global_stats (date_id, apps, updates, stars, versions_created)
      VALUES (v_date_id, 0, 0, 0, v_delta)
      ON CONFLICT (date_id) DO UPDATE
      SET versions_created = public.global_stats.versions_created + EXCLUDED.versions_created;
    END IF;

    processed := processed + 1;
    msg_ids := array_append(msg_ids, message_record.msg_id);
  END LOOP;

  IF array_length(msg_ids, 1) IS NOT NULL THEN
    PERFORM pgmq.delete('global_stats_creates', msg_ids);
  END IF;

  RETURN processed;
END;
$$;

ALTER FUNCTION public.process_global_stats_creates_queue(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_global_stats_creates_queue(integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.process_global_stats_creates_queue(integer) TO service_role;

COMMENT ON FUNCTION public.process_global_stats_creates_queue(integer) IS
  'Applies queued app-create and version-upload deltas onto global_stats daily counters.';

DROP TRIGGER IF EXISTS global_stats_creates_on_app_insert ON public.apps;
CREATE TRIGGER global_stats_creates_on_app_insert
AFTER INSERT ON public.apps
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_global_stats_creates();

DROP TRIGGER IF EXISTS global_stats_creates_on_version_insert ON public.app_versions;
CREATE TRIGGER global_stats_creates_on_version_insert
AFTER INSERT ON public.app_versions
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_global_stats_creates();

INSERT INTO public.cron_tasks (
  name,
  description,
  task_type,
  target,
  batch_size,
  payload,
  second_interval,
  minute_interval,
  hour_interval,
  run_at_hour,
  run_at_minute,
  run_at_second,
  run_on_dow,
  run_on_day,
  enabled,
  healthcheck_url
) VALUES (
  'global_stats_creates',
  'Process global stats create counters queue',
  'function',
  'public.process_global_stats_creates_queue(1000)',
  NULL,
  NULL,
  10,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  true,
  NULL
)
ON CONFLICT (name) DO UPDATE
SET
  description = EXCLUDED.description,
  task_type = EXCLUDED.task_type,
  target = EXCLUDED.target,
  second_interval = EXCLUDED.second_interval,
  enabled = EXCLUDED.enabled,
  updated_at = now();
