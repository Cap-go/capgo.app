-- on_app_delete removes an app's R2 prefix (orgs/{org}/apps/{app}/) in bounded
-- passes, each queuing the next one with a delay while objects are left. An app
-- created again with the same id in the same org owns that prefix again, so no
-- later pass may run for it. Both sides of that race are decided here on the
-- primary, under one advisory lock per app id, instead of by a worker read that
-- the query cache could serve stale:
-- * queue_app_storage_cleanup_pass queues the next pass only while no such app
--   exists;
-- * creating such an app (or moving one into the org) drops the passes already
--   queued.
-- Runs once per pass (service connection, never plugin traffic) and once per
-- apps INSERT or owner_org change. The queue scan is bounded by the size of
-- the on_app_delete queue, which holds only pending app deletions.

CREATE FUNCTION public.queue_app_storage_cleanup_pass(
  p_app_id text,
  p_owner_org uuid,
  p_message jsonb,
  p_delay_seconds integer
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_storage_cleanup:' || p_app_id, 0));
  IF EXISTS (SELECT 1 FROM public.apps WHERE app_id = p_app_id AND owner_org = p_owner_org) THEN
    RETURN NULL;
  END IF;
  RETURN pgmq.send('on_app_delete', p_message, GREATEST(COALESCE(p_delay_seconds, 0), 0));
END;
$$;

ALTER FUNCTION public.queue_app_storage_cleanup_pass(text, uuid, jsonb, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_app_storage_cleanup_pass(text, uuid, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_app_storage_cleanup_pass(text, uuid, jsonb, integer) TO service_role;

CREATE FUNCTION public.drop_app_storage_cleanup_passes() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('app_storage_cleanup:' || NEW.app_id, 0));
  -- Only follow-up passes: the first message of a deletion also records
  -- deleted_apps and removes the app's rows, which must still happen.
  PERFORM pgmq.delete('on_app_delete', ARRAY(
    SELECT q.msg_id
    FROM pgmq.q_on_app_delete AS q
    WHERE q.message -> 'payload' ? 'storage_cleanup_pass'
      AND q.message -> 'payload' -> 'old_record' ->> 'app_id' = NEW.app_id
      AND q.message -> 'payload' -> 'old_record' ->> 'owner_org' = NEW.owner_org::text
  ));
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.drop_app_storage_cleanup_passes() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.drop_app_storage_cleanup_passes() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER drop_app_storage_cleanup_passes
AFTER INSERT OR UPDATE OF owner_org ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.drop_app_storage_cleanup_passes();
