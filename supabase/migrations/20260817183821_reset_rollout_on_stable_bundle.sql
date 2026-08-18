-- Setting a new stable channel bundle must drop leftover progressive rollout.
-- Otherwise /updates keeps serving the old rollout target (sticky device cache
-- keyed by rollout_id) while the channel row shows the new version.

CREATE OR REPLACE FUNCTION public.refresh_channel_rollout_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rollout_changed boolean;
  v_channel_id bigint;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.version IS DISTINCT FROM OLD.version
    AND NEW.rollout_version IS NOT DISTINCT FROM OLD.rollout_version
    AND NEW.rollout_version IS NOT NULL
  THEN
    NEW.rollout_version := NULL;
    NEW.rollout_enabled := false;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_rollout_changed := NEW.rollout_version IS NOT NULL;
    v_channel_id := NULL::bigint;
  ELSE
    v_rollout_changed := NEW.rollout_version IS DISTINCT FROM OLD.rollout_version;
    v_channel_id := NEW.id;
  END IF;

  IF v_rollout_changed THEN
    PERFORM public.lock_channel_bundle_lifecycle(NEW.version, NEW.rollout_version);

    IF (auth.uid() IS NOT NULL OR public.get_apikey_header() IS NOT NULL)
      AND NOT public.rbac_check_permission_request(
        public.rbac_perm_channel_promote_bundle(),
        NEW.owner_org,
        NEW.app_id,
        v_channel_id
      )
    THEN
      RAISE EXCEPTION 'NO_RIGHTS';
    END IF;

    IF NEW.rollout_version IS NOT NULL THEN
      PERFORM 1
      FROM public.app_versions AS version
      WHERE version.id = NEW.rollout_version
        AND version.app_id = NEW.app_id
        AND version.owner_org = NEW.owner_org
        AND version.deleted = false
      FOR KEY SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_ROLLOUT_VERSION';
      END IF;

      PERFORM public.assert_preview_bundle_owner(
        NEW.owner_org,
        NEW.app_id,
        NEW.rollout_version
      );
    END IF;

    NEW.rollout_id = gen_random_uuid();
    IF NEW.rollout_version IS NULL THEN
      NEW.rollout_paused_at = NULL;
      IF TG_OP = 'INSERT' THEN
        NEW.rollout_pause_reason = NULL;
        NEW.auto_pause_last_triggered_at = NULL;
      ELSE
        IF NEW.rollout_pause_reason IS NOT DISTINCT FROM OLD.rollout_pause_reason THEN
          NEW.rollout_pause_reason = NULL;
        END IF;
        IF NEW.auto_pause_last_triggered_at IS NOT DISTINCT FROM OLD.auto_pause_last_triggered_at THEN
          NEW.auto_pause_last_triggered_at = NULL;
        END IF;
      END IF;
    ELSE
      NEW.rollout_paused_at = NULL;
      NEW.rollout_pause_reason = NULL;
      NEW.auto_pause_last_triggered_at = NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.refresh_channel_rollout_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refresh_channel_rollout_id() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refresh_channel_rollout_id() TO service_role;

COMMENT ON FUNCTION public.refresh_channel_rollout_id() IS
  'Rotates rollout_id when the rollout target changes so device assignment caches miss. Setting a new stable bundle without an explicit new rollout target clears leftover rollout so devices receive the new bundle.';

DROP TRIGGER IF EXISTS refresh_channel_rollout_id ON public.channels;
CREATE TRIGGER refresh_channel_rollout_id
BEFORE INSERT OR UPDATE OF rollout_version, version
ON public.channels
FOR EACH ROW
EXECUTE FUNCTION public.refresh_channel_rollout_id();

-- This trigger runs before refresh_channel_rollout_id. Skip leftover rollout
-- package checks when the stable bundle is being replaced; that write drops
-- the leftover target in refresh_channel_rollout_id.
CREATE OR REPLACE FUNCTION public.enforce_channel_update_package_bundle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_msg text;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.update_package IS NOT DISTINCT FROM OLD.update_package
    AND NEW.version IS NOT DISTINCT FROM OLD.version
    AND NEW.rollout_version IS NOT DISTINCT FROM OLD.rollout_version
  THEN
    RETURN NEW;
  END IF;

  v_msg := public.channel_update_package_mismatch(NEW.update_package, NEW.version, NEW.name);
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION '%', v_msg
      USING ERRCODE = '22023';
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.version IS DISTINCT FROM OLD.version
    AND NEW.rollout_version IS NOT DISTINCT FROM OLD.rollout_version
  THEN
    RETURN NEW;
  END IF;

  v_msg := public.channel_update_package_mismatch(NEW.update_package, NEW.rollout_version, NEW.name);
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION '%', v_msg
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_channel_update_package_bundle() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_channel_update_package_bundle() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_channel_update_package_bundle() TO service_role;
