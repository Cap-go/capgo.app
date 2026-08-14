-- Refuse zip-only / delta-only channel settings when the linked bundle cannot
-- serve that package. Runs once per channel row write (not a hot path).
-- Lookups: app_versions by PK, then optional EXISTS on indexed manifest.app_version_id.

CREATE OR REPLACE FUNCTION public.channel_update_package_mismatch(
  p_update_package public.channel_update_package,
  p_version_id bigint,
  p_channel_name text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text;
  v_storage_provider text;
  v_r2_path text;
  v_external_url text;
  v_legacy_manifest public.manifest_entry[];
  v_has_zip boolean;
  v_has_delta boolean;
BEGIN
  IF p_version_id IS NULL OR p_update_package IS NULL OR p_update_package = 'all' THEN
    RETURN NULL;
  END IF;

  SELECT
    app_version.name,
    app_version.storage_provider,
    app_version.r2_path,
    app_version.external_url,
    app_version.manifest
  INTO
    v_name,
    v_storage_provider,
    v_r2_path,
    v_external_url,
    v_legacy_manifest
  FROM public.app_versions AS app_version
  WHERE app_version.id = p_version_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_name IN ('builtin', 'unknown') THEN
    RETURN NULL;
  END IF;

  v_has_zip := (
    (v_storage_provider = 'external' AND NULLIF(BTRIM(COALESCE(v_external_url, '')), '') IS NOT NULL)
    OR (
      v_storage_provider IS DISTINCT FROM 'r2-direct'
      AND NULLIF(BTRIM(COALESCE(v_r2_path, '')), '') IS NOT NULL
    )
  );

  v_has_delta := COALESCE(pg_catalog.array_length(v_legacy_manifest, 1), 0) > 0
    OR EXISTS (
      SELECT 1
      FROM public.manifest AS manifest_row
      WHERE manifest_row.app_version_id = p_version_id
    );

  IF p_update_package IN ('zip', 'zip_from_builtin') AND NOT v_has_zip THEN
    RETURN format(
      'CHANNEL_ZIP_REQUIRED: Channel "%s" requires a zip package, but bundle "%s" has no zip. Upload a full zip (omit --delta-only) or set the channel to delta only / zip and delta.',
      p_channel_name,
      v_name
    );
  END IF;

  IF p_update_package IN ('delta', 'delta_from_builtin') AND NOT v_has_delta THEN
    RETURN format(
      'CHANNEL_DELTA_REQUIRED: Channel "%s" requires a delta package, but bundle "%s" has no delta files. Upload with delta enabled (`npx @capgo/cli@latest bundle upload --delta`) or set the channel to zip only / zip and delta.',
      p_channel_name,
      v_name
    );
  END IF;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.channel_update_package_mismatch(public.channel_update_package, bigint, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.channel_update_package_mismatch(public.channel_update_package, bigint, text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.channel_update_package_mismatch(public.channel_update_package, bigint, text) TO service_role;

COMMENT ON FUNCTION public.channel_update_package_mismatch(public.channel_update_package, bigint, text) IS
  'Returns a user-facing error when a channel package mode cannot be served by the given bundle. NULL means compatible. Internal builtin/unknown versions are skipped.';

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

COMMENT ON FUNCTION public.enforce_channel_update_package_bundle() IS
  'Blocks channel writes that pair zip-only or delta-only package modes with a bundle that cannot serve that package, including rollout targets.';

DROP TRIGGER IF EXISTS enforce_channel_update_package_bundle ON public.channels;
CREATE TRIGGER enforce_channel_update_package_bundle
BEFORE INSERT OR UPDATE OF version, rollout_version, update_package ON public.channels
FOR EACH ROW
EXECUTE FUNCTION public.enforce_channel_update_package_bundle();
