-- on_app_delete removes an app's R2 prefix (orgs/{org}/apps/{app}/) in bounded
-- passes, each queuing the next one with a delay while objects are left.
--
-- app_storage_cleanups is the durable state of an unfinished cleanup: a pass
-- claims it before its queue message is acknowledged, and it is cleared only
-- when the prefix is empty, the pass budget is spent, or the app id exists
-- again in the org. A pass that dies, or whose next message could not be
-- queued, leaves its row behind; requeue_stalled_app_storage_cleanups (cron)
-- queues the next pass for rows past due_at, replaying pass 0 (deleted_apps,
-- app_id rows) from the stored apps row until it has finished once.
--
-- An app created again with the same id in the same org owns that prefix
-- again. Every decision about it runs here on the primary, under one advisory
-- lock per app id, never from a worker read that the query cache could serve
-- stale: claiming and finishing a pass check the apps row, and creating such
-- an app (or moving one into the org) clears the state row, so its queued
-- passes are rejected when they claim.
--
-- Scale: one call per pass (internal queue worker, never plugin traffic), one
-- trigger run per apps INSERT or owner_org change, and a sweeper reading at
-- most p_limit due rows through the due_at index. The apps trigger is one
-- primary-key delete.

CREATE TABLE public.app_storage_cleanups (
  app_id character varying NOT NULL,
  owner_org uuid NOT NULL,
  -- The only pass allowed to run: claims for any other pass are rejected.
  pass integer NOT NULL DEFAULT 0,
  -- A worker claimed that pass and its lease (due_at) has not run out.
  running boolean NOT NULL DEFAULT false,
  -- When the sweeper may assume that pass died and queue the next one.
  due_at timestamptz NOT NULL,
  -- The deleted apps row, so the sweeper can replay pass 0.
  record jsonb NOT NULL,
  -- Pass 0 (deleted_apps, app_id rows) finished; until then the sweeper
  -- replays pass 0 instead of moving on to storage-only passes.
  first_pass_done boolean NOT NULL DEFAULT false,
  -- deleted_apps was written for this deletion (replays must not add another).
  deletion_recorded boolean NOT NULL DEFAULT false,
  -- Sweeper requeues; bounded like passes.
  requeues integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (app_id, owner_org)
);
ALTER TABLE public.app_storage_cleanups OWNER TO postgres;
ALTER TABLE public.app_storage_cleanups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_storage_cleanups FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.app_storage_cleanups TO service_role;
CREATE POLICY "Deny all direct access" ON public.app_storage_cleanups AS RESTRICTIVE USING (false) WITH CHECK (false);
CREATE INDEX app_storage_cleanups_due_at_idx ON public.app_storage_cleanups (due_at);

-- Passes after the first; the first also records deleted_apps and removes
-- rows. Matches MAX_STORAGE_CLEANUP_PASSES in triggers/on_app_delete.ts.
CREATE FUNCTION public.app_storage_cleanup_message(p_app_id text, p_owner_org uuid, p_pass integer)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'function_name', 'on_app_delete',
    'payload', pg_catalog.jsonb_build_object(
      'type', 'DELETE',
      'table', 'apps',
      'schema', 'public',
      'record', NULL,
      'old_record', pg_catalog.jsonb_build_object('app_id', p_app_id, 'owner_org', p_owner_org),
      'storage_cleanup_pass', p_pass
    )
  )
$$;
ALTER FUNCTION public.app_storage_cleanup_message(text, uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.app_storage_cleanup_message(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.app_storage_cleanup_message(text, uuid, integer) TO service_role;

-- Claims pass p_pass before its message is acknowledged. Returns:
--   'claimed'    run it;
--   'recreated'  the app id exists again in the org (state cleared): delete nothing;
--   'superseded' another pass owns the cleanup, or it already finished;
--   'running'    a duplicate delivery of a pass whose lease is still held.
-- Only pass 0 may create the state, and only the recorded pass may run, so a
-- message the sweeper replaced cannot start a second chain.
CREATE FUNCTION public.begin_app_storage_cleanup_pass(
  p_app_id text,
  p_owner_org uuid,
  p_pass integer,
  p_lease_seconds integer,
  p_record jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.app_storage_cleanups%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_storage_cleanup:' || p_app_id, 0));
  IF EXISTS (SELECT 1 FROM public.apps WHERE app_id = p_app_id AND owner_org = p_owner_org) THEN
    DELETE FROM public.app_storage_cleanups WHERE app_id = p_app_id AND owner_org = p_owner_org;
    RETURN 'recreated';
  END IF;

  SELECT * INTO v_row FROM public.app_storage_cleanups
  WHERE app_id = p_app_id AND owner_org = p_owner_org
  FOR UPDATE;

  IF NOT FOUND THEN
    IF p_pass <> 0 THEN
      RETURN 'superseded';
    END IF;
    INSERT INTO public.app_storage_cleanups (app_id, owner_org, pass, running, due_at, record)
    VALUES (p_app_id, p_owner_org, 0, true, pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds), COALESCE(p_record, '{}'::jsonb));
    RETURN 'claimed';
  END IF;

  IF v_row.pass <> p_pass THEN
    RETURN 'superseded';
  END IF;
  IF v_row.running AND v_row.due_at > pg_catalog.clock_timestamp() THEN
    RETURN 'running';
  END IF;

  UPDATE public.app_storage_cleanups
  SET running = true, due_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds)
  WHERE app_id = p_app_id AND owner_org = p_owner_org;
  RETURN 'claimed';
END;
$$;
ALTER FUNCTION public.begin_app_storage_cleanup_pass(text, uuid, integer, integer, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.begin_app_storage_cleanup_pass(text, uuid, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_app_storage_cleanup_pass(text, uuid, integer, integer, jsonb) TO service_role;

-- Records the deletion in deleted_apps (billing) once per cleanup, so a
-- replayed pass 0 does not add a second row. Without cleanup state (the app id
-- exists again, or the app had no storage claim) it records unconditionally,
-- like before.
CREATE FUNCTION public.record_app_deletion_once(
  p_app_id text,
  p_owner_org uuid,
  p_created_at timestamptz,
  p_transfer_history jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recorded boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_storage_cleanup:' || p_app_id, 0));
  SELECT deletion_recorded INTO v_recorded FROM public.app_storage_cleanups
  WHERE app_id = p_app_id AND owner_org = p_owner_org
  FOR UPDATE;
  IF v_recorded THEN
    RETURN false;
  END IF;
  INSERT INTO public.deleted_apps (app_id, created_at, owner_org, transfer_history)
  VALUES (p_app_id, p_created_at, p_owner_org, ARRAY(SELECT pg_catalog.jsonb_array_elements(COALESCE(p_transfer_history, '[]'::jsonb))));
  UPDATE public.app_storage_cleanups SET deletion_recorded = true
  WHERE app_id = p_app_id AND owner_org = p_owner_org;
  RETURN true;
END;
$$;
ALTER FUNCTION public.record_app_deletion_once(text, uuid, timestamptz, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_app_deletion_once(text, uuid, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_app_deletion_once(text, uuid, timestamptz, jsonb) TO service_role;

-- Ends pass p_pass, only when it still owns the cleanup (otherwise nothing
-- happens). With p_done (prefix empty or budget spent) the state is cleared.
-- Otherwise the next pass is queued with a delay, unless the app id exists
-- again in the org. Returns the queued message id, or NULL.
CREATE FUNCTION public.finish_app_storage_cleanup_pass(
  p_app_id text,
  p_owner_org uuid,
  p_pass integer,
  p_done boolean,
  p_delay_seconds integer,
  p_lease_seconds integer
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_msg_id bigint;
  v_delay integer := GREATEST(COALESCE(p_delay_seconds, 0), 0);
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_storage_cleanup:' || p_app_id, 0));
  IF NOT EXISTS (
    SELECT 1 FROM public.app_storage_cleanups
    WHERE app_id = p_app_id AND owner_org = p_owner_org AND pass = p_pass
  ) THEN
    RETURN NULL;
  END IF;
  IF p_done OR EXISTS (SELECT 1 FROM public.apps WHERE app_id = p_app_id AND owner_org = p_owner_org) THEN
    DELETE FROM public.app_storage_cleanups WHERE app_id = p_app_id AND owner_org = p_owner_org;
    RETURN NULL;
  END IF;
  v_msg_id := pgmq.send('on_app_delete', public.app_storage_cleanup_message(p_app_id, p_owner_org, p_pass + 1), v_delay);
  UPDATE public.app_storage_cleanups
  SET pass = p_pass + 1,
    first_pass_done = true,
    running = false,
    due_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => v_delay + p_lease_seconds)
  WHERE app_id = p_app_id AND owner_org = p_owner_org;
  RETURN v_msg_id;
END;
$$;
ALTER FUNCTION public.finish_app_storage_cleanup_pass(text, uuid, integer, boolean, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_app_storage_cleanup_pass(text, uuid, integer, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_app_storage_cleanup_pass(text, uuid, integer, boolean, integer, integer) TO service_role;

-- Requeues cleanups whose pass never finished (worker killed, next message
-- not queued or stuck in a backlog). Until pass 0 finished it replays pass 0
-- from the stored record, so deleted_apps and the app_id rows are not skipped;
-- after that it queues the next storage pass, which makes the replaced message
-- superseded so only one chain continues. Requeues are bounded like passes.
-- Returns how many messages were queued.
CREATE FUNCTION public.requeue_stalled_app_storage_cleanups(p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- A plain value (not clock_timestamp() in the predicate) bounds the due_at index scan.
  v_cutoff timestamptz := pg_catalog.clock_timestamp();
  v_row record;
  v_queued integer := 0;
BEGIN
  FOR v_row IN
    SELECT c.app_id, c.owner_org, c.pass, c.record, c.first_pass_done, c.requeues
    FROM public.app_storage_cleanups AS c
    WHERE c.due_at < v_cutoff
    ORDER BY c.due_at
    LIMIT GREATEST(COALESCE(p_limit, 100), 1)
    FOR UPDATE SKIP LOCKED
  LOOP
    -- A pass that is finishing right now holds this lock; leave the row to it.
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('app_storage_cleanup:' || v_row.app_id, 0)) THEN
      CONTINUE;
    END IF;
    IF v_row.pass + 1 >= 50 OR v_row.requeues + 1 >= 50
      OR EXISTS (SELECT 1 FROM public.apps WHERE app_id = v_row.app_id AND owner_org = v_row.owner_org) THEN
      DELETE FROM public.app_storage_cleanups WHERE app_id = v_row.app_id AND owner_org = v_row.owner_org;
      CONTINUE;
    END IF;
    IF v_row.first_pass_done THEN
      PERFORM pgmq.send('on_app_delete', public.app_storage_cleanup_message(v_row.app_id, v_row.owner_org, v_row.pass + 1), 0);
    ELSE
      PERFORM pgmq.send('on_app_delete', pg_catalog.jsonb_build_object(
        'function_name', 'on_app_delete',
        'payload', pg_catalog.jsonb_build_object(
          'type', 'DELETE', 'table', 'apps', 'schema', 'public', 'record', NULL, 'old_record', v_row.record
        )
      ), 0);
    END IF;
    UPDATE public.app_storage_cleanups
    SET pass = CASE WHEN v_row.first_pass_done THEN v_row.pass + 1 ELSE 0 END,
      requeues = v_row.requeues + 1,
      running = false,
      due_at = pg_catalog.clock_timestamp() + interval '2 minutes'
    WHERE app_id = v_row.app_id AND owner_org = v_row.owner_org;
    v_queued := v_queued + 1;
  END LOOP;
  RETURN v_queued;
END;
$$;
ALTER FUNCTION public.requeue_stalled_app_storage_cleanups(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.requeue_stalled_app_storage_cleanups(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_stalled_app_storage_cleanups(integer) TO service_role;

-- Clearing the state is enough: a queued or replayed follow-up message then
-- finds no state (or the app) and is rejected by its claim, so the queue is
-- never scanned. The first message of a deletion still records deleted_apps.
CREATE FUNCTION public.drop_app_storage_cleanup_passes() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_storage_cleanup:' || NEW.app_id, 0));
  DELETE FROM public.app_storage_cleanups WHERE app_id = NEW.app_id AND owner_org = NEW.owner_org;
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.drop_app_storage_cleanup_passes() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.drop_app_storage_cleanup_passes() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER drop_app_storage_cleanup_passes
AFTER INSERT OR UPDATE OF owner_org ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.drop_app_storage_cleanup_passes();

INSERT INTO public.cron_tasks (
  name,
  description,
  task_type,
  target,
  second_interval,
  minute_interval,
  enabled
)
VALUES (
  'requeue_stalled_app_storage_cleanups',
  'Queue the next pass of app storage cleanups whose pass never finished',
  'function',
  'public.requeue_stalled_app_storage_cleanups(100)',
  null,
  1,
  true
)
ON CONFLICT (name) DO NOTHING;
