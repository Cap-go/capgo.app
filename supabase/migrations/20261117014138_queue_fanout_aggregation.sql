-- Cut queue fan-out for channel device counters and stats emails.
--
-- 1. channel_devices counters
--    The row-level trigger queued one channel_device_counts message per
--    inserted or deleted override (an app delete cascading 100k overrides
--    queued 100k messages), and the consumer ran one UPDATE public.apps per
--    message, firing the apps triggers on the same hot row every time.
--    The trigger is now statement-level with transition tables and queues one
--    message per app per statement, skipping apps that no longer exist (the
--    cascade from an app delete). The consumer sums the deltas per app and
--    runs a single UPDATE per batch. Message shape is unchanged
--    ({app_id, owner_org, delta}), so messages queued before this migration
--    are still consumed correctly.
--
-- 2. Weekly/monthly stats emails
--    The producers queued one cron_email message per app, and the handler
--    resolved the org recipients once per app even when the app had nothing
--    to report. They now queue only apps the handler would email about, one
--    message per org carrying its appIds, with one pgmq.send per org (Tinbase has no send_batch).

-- ---------------------------------------------------------------------------
-- 1a. Statement-level enqueue trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_channel_device_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_messages jsonb[];
  v_message jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(
      jsonb_build_object('app_id', d.app_id, 'owner_org', d.owner_org, 'delta', d.delta)
      ORDER BY d.app_id
    )
    INTO v_messages
    FROM (
      SELECT nr.app_id, (array_agg(nr.owner_org))[1] AS owner_org, count(*) AS delta
      FROM new_rows AS nr
      GROUP BY nr.app_id
    ) AS d;
    -- No apps lookup here: the channel_devices -> apps FK already guarantees
    -- the app exists, and this path runs on every /channel_self write.
  ELSIF TG_OP = 'DELETE' THEN
    -- A cascade from DELETE FROM apps runs after the app row is gone: there is
    -- no counter left to update, so nothing is queued for that app.
    SELECT array_agg(
      jsonb_build_object('app_id', d.app_id, 'owner_org', d.owner_org, 'delta', -d.delta)
      ORDER BY d.app_id
    )
    INTO v_messages
    FROM (
      SELECT o.app_id, (array_agg(o.owner_org))[1] AS owner_org, count(*) AS delta
      FROM old_rows AS o
      GROUP BY o.app_id
    ) AS d
    WHERE EXISTS (SELECT 1 FROM public.apps AS a WHERE a.app_id = d.app_id);
  ELSE
    RETURN NULL;
  END IF;

  IF cardinality(v_messages) > 0 THEN
    FOREACH v_message IN ARRAY v_messages LOOP
      PERFORM pgmq.send('channel_device_counts', v_message);
    END LOOP;
  END IF;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.enqueue_channel_device_counts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_channel_device_counts() FROM public;

-- Transition tables need one trigger per event.
DROP TRIGGER IF EXISTS channel_device_count_enqueue ON public.channel_devices;
DROP TRIGGER IF EXISTS channel_device_count_enqueue_delete ON public.channel_devices;

CREATE TRIGGER channel_device_count_enqueue
AFTER INSERT ON public.channel_devices
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.enqueue_channel_device_counts();

CREATE TRIGGER channel_device_count_enqueue_delete
AFTER DELETE ON public.channel_devices
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.enqueue_channel_device_counts();

-- ---------------------------------------------------------------------------
-- 1b. Consumer: one UPDATE per batch
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.process_channel_device_counts_queue(
  batch_size integer DEFAULT 1000
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  msg_ids bigint[];
  messages jsonb[];
  processed bigint;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 THEN
    batch_size := 100;
  END IF;

  SELECT array_agg(r.msg_id), array_agg(r.message)
  INTO msg_ids, messages
  FROM pgmq.read('channel_device_counts', 60, batch_size) AS r;

  IF msg_ids IS NULL THEN
    RETURN 0;
  END IF;

  -- Same meaning as before: messages that carry an app and a non-zero delta.
  SELECT count(*)
  INTO processed
  FROM unnest(messages) AS m(message)
  WHERE m.message ->> 'app_id' IS NOT NULL
    AND COALESCE((m.message ->> 'delta')::bigint, 0) <> 0;

  UPDATE public.apps AS a
  SET channel_device_count = GREATEST(a.channel_device_count + d.delta, 0),
      updated_at = now()
  FROM (
    SELECT m.message ->> 'app_id' AS app_id,
           sum(COALESCE((m.message ->> 'delta')::bigint, 0)) AS delta
    FROM unnest(messages) AS m(message)
    WHERE m.message ->> 'app_id' IS NOT NULL
    GROUP BY 1
    HAVING sum(COALESCE((m.message ->> 'delta')::bigint, 0)) <> 0
  ) AS d
  WHERE a.app_id = d.app_id;

  PERFORM pgmq.delete('channel_device_counts', msg_ids);

  RETURN processed;
END;
$$;

ALTER FUNCTION public.process_channel_device_counts_queue(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_channel_device_counts_queue(integer) FROM public;
GRANT ALL ON FUNCTION public.process_channel_device_counts_queue(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 1c. Expiry cleanup: grouped recount, only touch rows that changed
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cleanup_old_channel_devices() RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    deleted_count bigint;
    purged_count bigint;
    updated_count bigint;
BEGIN
    -- Disable the counter triggers during the bulk delete; the counts are
    -- recomputed below instead of applying queued deltas.
    ALTER TABLE public.channel_devices DISABLE TRIGGER channel_device_count_enqueue;
    ALTER TABLE public.channel_devices DISABLE TRIGGER channel_device_count_enqueue_delete;

    -- Use nested block with exception handler to ensure triggers are re-enabled on any failure
    BEGIN
        -- Only device self-assigned overrides expire, 90 days after the device last
        -- (re)wrote them. Console/API overrides are kept until explicitly removed.
        DELETE FROM public.channel_devices
        WHERE is_self_set
          AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '90 days';

        GET DIAGNOSTICS deleted_count = ROW_COUNT;

        -- Re-enable triggers before any further operations
        ALTER TABLE public.channel_devices ENABLE TRIGGER channel_device_count_enqueue;
        ALTER TABLE public.channel_devices ENABLE TRIGGER channel_device_count_enqueue_delete;

        IF deleted_count > 0 THEN
            RAISE NOTICE 'cleanup_old_channel_devices: Deleted % stale self-set channel device entries', deleted_count;

            -- Purge any pending messages in the channel_device_counts queue before recomputing
            -- This prevents stale deltas from being applied after the full recount
            SELECT pgmq.purge_queue('channel_device_counts') INTO purged_count;
            IF purged_count > 0 THEN
                RAISE NOTICE 'cleanup_old_channel_devices: Purged % pending queue messages', purged_count;
            END IF;

            -- One grouped scan of channel_devices; rewrite only apps whose
            -- stored counter is wrong instead of every apps row.
            UPDATE public.apps AS a
            SET channel_device_count = c.device_count
            FROM (
                SELECT apps.app_id, COALESCE(cd.device_count, 0) AS device_count
                FROM public.apps
                LEFT JOIN (
                    SELECT channel_devices.app_id, count(*) AS device_count
                    FROM public.channel_devices
                    GROUP BY channel_devices.app_id
                ) AS cd ON cd.app_id = apps.app_id
            ) AS c
            WHERE a.app_id = c.app_id
              AND a.channel_device_count IS DISTINCT FROM c.device_count;

            GET DIAGNOSTICS updated_count = ROW_COUNT;
            RAISE NOTICE 'cleanup_old_channel_devices: Recalculated channel_device_count, % apps changed', updated_count;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- Ensure triggers are re-enabled even on failure
        ALTER TABLE public.channel_devices ENABLE TRIGGER channel_device_count_enqueue;
        ALTER TABLE public.channel_devices ENABLE TRIGGER channel_device_count_enqueue_delete;
        RAISE;
    END;
END;
$$;

ALTER FUNCTION public.cleanup_old_channel_devices() OWNER TO postgres;

-- ---------------------------------------------------------------------------
-- 2. Stats emails: only apps with something to report, one message per org
-- ---------------------------------------------------------------------------

-- Matches cron_email.ts sendWeeklyInstallStats: an email is sent only when
-- SUM(install) or SUM(fail) of daily_version over the seven completed UTC days
-- before today is > 0 (getWeeklyReportRange / WEEKLY_REPORT_SQL).
CREATE OR REPLACE FUNCTION public.process_stats_email_weekly() RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_end date := (now() AT TIME ZONE 'UTC')::date;
  v_start date := (now() AT TIME ZONE 'UTC')::date - 7;
  v_messages jsonb[];
  v_message jsonb;
BEGIN
  SELECT array_agg(
    jsonb_build_object(
      'function_name', 'cron_email',
      'function_type', 'cloudflare',
      'payload', jsonb_build_object(
        'email', org_apps.management_email,
        'orgId', org_apps.org_id,
        'appIds', org_apps.app_ids,
        'type', 'weekly_install_stats'
      )
    )
    ORDER BY org_apps.org_id
  )
  INTO v_messages
  FROM (
    SELECT o.id AS org_id, o.management_email,
           jsonb_agg(a.app_id ORDER BY a.app_id) AS app_ids
    FROM public.apps AS a
    JOIN public.orgs AS o ON a.owner_org = o.id
    CROSS JOIN LATERAL (
      -- Uses the (app_id, date) index, one app and seven buckets at a time.
      SELECT COALESCE(sum(dv.install), 0) AS installs,
             COALESCE(sum(dv.fail), 0) AS fails
      FROM public.daily_version AS dv
      WHERE dv.app_id = a.app_id
        AND dv.date >= v_start
        AND dv.date < v_end
    ) AS stats
    WHERE stats.installs > 0 OR stats.fails > 0
    GROUP BY o.id, o.management_email
  ) AS org_apps;

  IF cardinality(v_messages) > 0 THEN
    FOREACH v_message IN ARRAY v_messages LOOP
      PERFORM pgmq.send('cron_email', v_message);
    END LOOP;
  END IF;
END;
$$;

ALTER FUNCTION public.process_stats_email_weekly() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_stats_email_weekly() FROM public;

-- Matches cron_email.ts sendMonthlyCreateStats: an email is sent only when the
-- app created at least one app_versions row or one deploy_history row in the
-- previous UTC calendar month (getPreviousMonthUtcRange).
CREATE OR REPLACE FUNCTION public.process_stats_email_monthly() RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_end timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_start timestamptz := (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC';
  v_messages jsonb[];
  v_message jsonb;
BEGIN
  SELECT array_agg(
    jsonb_build_object(
      'function_name', 'cron_email',
      'function_type', 'cloudflare',
      'payload', jsonb_build_object(
        'email', org_apps.management_email,
        'orgId', org_apps.org_id,
        'appIds', org_apps.app_ids,
        'type', 'monthly_create_stats'
      )
    )
    ORDER BY org_apps.org_id
  )
  INTO v_messages
  FROM (
    SELECT o.id AS org_id, o.management_email,
           jsonb_agg(a.app_id ORDER BY a.app_id) AS app_ids
    FROM public.apps AS a
    JOIN public.orgs AS o ON a.owner_org = o.id
    WHERE EXISTS (
        SELECT 1 FROM public.app_versions AS av
        WHERE av.app_id = a.app_id
          AND av.created_at >= v_start
          AND av.created_at < v_end
      )
      OR EXISTS (
        SELECT 1 FROM public.deploy_history AS dh
        WHERE dh.app_id = a.app_id
          AND dh.deployed_at >= v_start
          AND dh.deployed_at < v_end
      )
    GROUP BY o.id, o.management_email
  ) AS org_apps;

  IF cardinality(v_messages) > 0 THEN
    FOREACH v_message IN ARRAY v_messages LOOP
      PERFORM pgmq.send('cron_email', v_message);
    END LOOP;
  END IF;
END;
$$;

ALTER FUNCTION public.process_stats_email_monthly() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_stats_email_monthly() FROM public;
