-- When a bundle is soft-deleted, clear any channel stable/rollout targets that still
-- reference it. Closes the window where /updates could serve a signed URL while
-- storage cleanup has already removed the object (replica lag + stale channel FK).
--
-- Execution profile (app_versions AFTER UPDATE OF deleted, deleted_at):
-- - Where: once per row when deleted flips true or deleted_at is newly set.
-- - Frequency: console-scale bundle deletes, not plugin hot path.
-- - Roles: any caller that soft-deletes app_versions (API, service_role cron).
-- - Cardinality: bounded by channels referencing the version id on that app_id
--   (channels_app_id_idx + version / rollout_version lookups).
-- - Indexes: channels(app_id), channels(version), channels(rollout_version).

CREATE OR REPLACE FUNCTION public.unlink_channels_from_deleted_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT (
    (NEW.deleted IS TRUE AND OLD.deleted IS NOT TRUE)
    OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  ) THEN
    RETURN NEW;
  END IF;

  -- Same bypass internal cleanup uses (soft_delete_versions_for_long_canceled_orgs).
  PERFORM pg_catalog.set_config('capgo.seed_channel_targets', 'true', true);

  UPDATE public.channels AS c
  SET
    version = CASE WHEN c.version = NEW.id THEN NULL ELSE c.version END,
    rollout_version = CASE WHEN c.rollout_version = NEW.id THEN NULL ELSE c.rollout_version END,
    updated_at = pg_catalog.now()
  WHERE c.app_id = NEW.app_id
    AND (c.version = NEW.id OR c.rollout_version = NEW.id);

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.unlink_channels_from_deleted_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.unlink_channels_from_deleted_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unlink_channels_from_deleted_version() TO service_role;

DROP TRIGGER IF EXISTS unlink_channels_from_deleted_version ON public.app_versions;
CREATE TRIGGER unlink_channels_from_deleted_version
AFTER UPDATE OF deleted, deleted_at ON public.app_versions
FOR EACH ROW
EXECUTE FUNCTION public.unlink_channels_from_deleted_version();

COMMENT ON FUNCTION public.unlink_channels_from_deleted_version() IS
  'Clears channels.version and channels.rollout_version when a bundle is soft-deleted.';
