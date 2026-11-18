-- capgo-22.63.1: short lock window for apps / app_versions (data migration is 20261117152410).
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.app_versions, public.apps IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.daily_storage_hourly
DROP CONSTRAINT IF EXISTS daily_storage_hourly_app_id_fkey;

-- ---------------------------------------------------------------------------
-- 2e. Close bundle lifetimes when an app is deleted
-- ---------------------------------------------------------------------------
-- Byte-hours are rebuilt from version_meta (a positive event when a bundle is
-- stored, a negative one when it is removed). Deleting an app through the API
-- removes app_versions_meta before app_versions, so the version delete path
-- cannot emit the negative events and the bundles stay "stored": a recreated
-- app ID would be billed for them. Close every still-open lifetime of the app
-- at the deletion (the transaction time, like version_meta's default). This
-- stops the deleted app's hours at its deletion, whatever the queue delay
-- before on_app_delete finalizes them (up to the message's occurred_at).
CREATE OR REPLACE FUNCTION public.close_app_storage_lifetimes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  -- clock_timestamp(): the deletion's statement time, not the transaction start.
  INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
  SELECT GREATEST(added.timestamp, pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())), added.app_id, added.version_id, -added.size, added.lifetime
  FROM public.version_meta added
  WHERE added.app_id = OLD.app_id
    AND added.size > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.version_meta removed
      WHERE removed.app_id = added.app_id
        AND removed.version_id = added.version_id
        AND removed.lifetime = added.lifetime
        AND removed.size < 0
    )
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.close_app_storage_lifetimes() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_app_storage_lifetimes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_app_storage_lifetimes() FROM anon, authenticated;

DROP TRIGGER IF EXISTS close_app_storage_lifetimes ON public.apps;
CREATE TRIGGER close_app_storage_lifetimes
AFTER DELETE ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.close_app_storage_lifetimes();

-- Same for one bundle hard-deleted on its own (cron_clear_versions removes a
-- bundle whose R2 object is gone): the app_versions_meta cascade removes its
-- size before on_version_delete runs, so that path cannot close it either.
CREATE OR REPLACE FUNCTION public.close_version_storage_lifetime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  -- clock_timestamp(): the deletion's statement time, not the transaction start.
  INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
  SELECT GREATEST(added.timestamp, pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())), added.app_id, added.version_id, -added.size, added.lifetime
  FROM public.version_meta added
  WHERE added.app_id = OLD.app_id
    AND added.version_id = OLD.id
    AND added.size > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.version_meta removed
      WHERE removed.app_id = added.app_id
        AND removed.version_id = added.version_id
        AND removed.lifetime = added.lifetime
        AND removed.size < 0
    )
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.close_version_storage_lifetime() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_version_storage_lifetime() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_version_storage_lifetime() FROM anon, authenticated;

DROP TRIGGER IF EXISTS close_version_storage_lifetime ON public.app_versions;
CREATE TRIGGER close_version_storage_lifetime
AFTER DELETE ON public.app_versions
FOR EACH ROW EXECUTE FUNCTION public.close_version_storage_lifetime();

-- A soft deletion closes the bundle's lifetime in the same transaction, at
-- that server time: the asynchronous removal job can run much later (after a
-- hard deletion that would otherwise close it at the later time). The job's
-- own removal write then finds the event and changes nothing.
CREATE OR REPLACE FUNCTION public.close_soft_deleted_version_storage_lifetime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
  SELECT
    -- The soft deletion's statement time (now() is the transaction start).
    GREATEST(added.timestamp, pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())),
    added.app_id, added.version_id, -added.size, added.lifetime
  FROM public.version_meta added
  WHERE added.app_id = NEW.app_id
    AND added.version_id = NEW.id
    AND added.size > 0
    AND NOT EXISTS (
      SELECT 1
      FROM public.version_meta removed
      WHERE removed.app_id = added.app_id
        AND removed.version_id = added.version_id
        AND removed.lifetime = added.lifetime
        AND removed.size < 0
    )
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.close_soft_deleted_version_storage_lifetime() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_soft_deleted_version_storage_lifetime() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_soft_deleted_version_storage_lifetime() FROM anon, authenticated;

DROP TRIGGER IF EXISTS close_soft_deleted_version_storage_lifetime ON public.app_versions;
CREATE TRIGGER close_soft_deleted_version_storage_lifetime
AFTER UPDATE OF deleted ON public.app_versions
FOR EACH ROW
WHEN (NEW.deleted AND NOT OLD.deleted)
EXECUTE FUNCTION public.close_soft_deleted_version_storage_lifetime();

-- A restored bundle is stored again from the restore, in the next lifetime,
-- in the restoring transaction: its upload job can run after a second
-- deletion, when the bundle is no longer live. The size is the one its last
-- lifetime was billed for. Nothing happens unless that lifetime is closed.
CREATE OR REPLACE FUNCTION public.open_restored_version_storage_lifetime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  INSERT INTO public.version_meta (timestamp, app_id, version_id, size, lifetime)
  SELECT
    -- The restore's statement time, never before the removal it reopens.
    GREATEST(latest.removed_at, pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())),
    NEW.app_id, NEW.id, latest.size, latest.lifetime + 1
  FROM (
    SELECT
      event.lifetime,
      (pg_catalog.array_agg(event.size ORDER BY event.timestamp) FILTER (WHERE event.size > 0))[1] AS size,
      pg_catalog.min(event.timestamp) FILTER (WHERE event.size < 0) AS removed_at
    FROM public.version_meta event
    WHERE event.app_id = NEW.app_id
      AND event.version_id = NEW.id
    GROUP BY event.lifetime
    ORDER BY event.lifetime DESC
    LIMIT 1
  ) latest
  WHERE latest.size IS NOT NULL
    AND latest.removed_at IS NOT NULL
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.open_restored_version_storage_lifetime() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.open_restored_version_storage_lifetime() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_restored_version_storage_lifetime() FROM anon, authenticated;

DROP TRIGGER IF EXISTS open_restored_version_storage_lifetime ON public.app_versions;
CREATE TRIGGER open_restored_version_storage_lifetime
AFTER UPDATE OF deleted ON public.app_versions
FOR EACH ROW
WHEN (OLD.deleted AND NOT NEW.deleted)
EXECUTE FUNCTION public.open_restored_version_storage_lifetime();

-- ---------------------------------------------------------------------------
-- 2h. Ownership history is backend-controlled
-- ---------------------------------------------------------------------------
-- apps.created_at and apps.transfer_history now delimit billable ownership
-- segments (cron_stat_app accrues from them). Clients could edit both through
-- the console's apps writes (an owner moving created_at into the future would
-- stop all accrual). Only internal roles and transfer_app may change them; a
-- client insert gets the real creation time and an empty history.
CREATE OR REPLACE FUNCTION public.guard_apps_ownership_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF public.is_internal_request_role(public.current_request_role())
    OR pg_catalog.current_setting('capgo.allow_owner_org_transfer', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.now();
    NEW.transfer_history := '{}';
    RETURN NEW;
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.transfer_history IS DISTINCT FROM OLD.transfer_history THEN
    RAISE EXCEPTION 'APP_OWNERSHIP_HISTORY_CLIENT_WRITE_DENIED'
      USING ERRCODE = '42501',
        DETAIL = 'apps.created_at and apps.transfer_history are set by the backend and transfer_app().';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_apps_ownership_history() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_apps_ownership_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_apps_ownership_history() FROM anon, authenticated;

DROP TRIGGER IF EXISTS guard_apps_ownership_history ON public.apps;
CREATE TRIGGER guard_apps_ownership_history
BEFORE INSERT OR UPDATE OF created_at, transfer_history ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.guard_apps_ownership_history();

