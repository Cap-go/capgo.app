-- GHSA-5rg9-rhwj-wj76: r2-direct staging rows were treated as "not ready" and
-- stayed mutable via PostgREST after checksum/session_key were set. Upload is
-- complete once storage_provider is no longer r2-direct; during r2-direct staging
-- with checksum set, identity fields lock but r2_path updates and finalize
-- (r2-direct -> r2) remain allowed.

CREATE OR REPLACE FUNCTION "public"."check_encrypted_bundle_on_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  org_id uuid;
  org_enforcing boolean;
  org_required_key varchar(21);
  bundle_is_encrypted boolean;
  bundle_key_id varchar(20);
  bundle_upload_complete boolean;
  bundle_identity_locked boolean;
  is_r2_direct_finalize boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF pg_catalog.current_setting('capgo.reclaim_manifest_null', true) = 'on'
      AND NEW.manifest IS NULL
      AND OLD.manifest IS NOT NULL
      AND NEW.native_packages IS NOT DISTINCT FROM OLD.native_packages
      AND NEW.name IS NOT DISTINCT FROM OLD.name
      AND NEW.app_id IS NOT DISTINCT FROM OLD.app_id
      AND NEW.session_key IS NOT DISTINCT FROM OLD.session_key
      AND NEW.key_id IS NOT DISTINCT FROM OLD.key_id
      AND NEW.storage_provider IS NOT DISTINCT FROM OLD.storage_provider
      AND NEW.r2_path IS NOT DISTINCT FROM OLD.r2_path
      AND NEW.external_url IS NOT DISTINCT FROM OLD.external_url
      AND NEW.checksum IS NOT DISTINCT FROM OLD.checksum
    THEN
      RETURN NEW;
    END IF;

    IF NEW.manifest IS NULL
      AND OLD.manifest IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(OLD.manifest) AS entry(file_name, s3_path, file_hash)
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.manifest AS m
          WHERE m.app_version_id = OLD.id
            AND m.s3_path = entry.s3_path
            AND m.file_hash = entry.file_hash
        )
      )
    THEN
      RAISE EXCEPTION '%',
        'bundle_manifest_not_migrated: Cannot clear app_versions.manifest '
        || 'until every entry exists in public.manifest.';
    END IF;

    bundle_upload_complete := OLD.storage_provider IS DISTINCT FROM 'r2-direct';

    IF bundle_upload_complete
      AND (
        NEW.name IS DISTINCT FROM OLD.name
        OR NEW.app_id IS DISTINCT FROM OLD.app_id
        OR NEW.session_key IS DISTINCT FROM OLD.session_key
        OR NEW.key_id IS DISTINCT FROM OLD.key_id
        OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
        OR NEW.r2_path IS DISTINCT FROM OLD.r2_path
        OR NEW.external_url IS DISTINCT FROM OLD.external_url
        OR NEW.checksum IS DISTINCT FROM OLD.checksum
        OR (NEW.manifest IS DISTINCT FROM OLD.manifest AND NEW.manifest IS NOT NULL)
        OR (
          NEW.manifest IS NULL
          AND OLD.manifest IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(OLD.manifest) AS entry(file_name, s3_path, file_hash)
            WHERE NOT EXISTS (
              SELECT 1
              FROM public.manifest AS m
              WHERE m.app_version_id = OLD.id
                AND m.s3_path = entry.s3_path
                AND m.file_hash = entry.file_hash
            )
          )
        )
        OR NEW.native_packages IS DISTINCT FROM OLD.native_packages
      )
    THEN
      PERFORM public.pg_log('deny: BUNDLE_CONTENT_LOCKED_TRIGGER',
        pg_catalog.jsonb_build_object(
          'org_id', OLD.owner_org,
          'app_id', OLD.app_id,
          'version_name', OLD.name,
          'user_id', OLD.user_id,
          'old_storage_provider', OLD.storage_provider,
          'new_storage_provider', NEW.storage_provider,
          'reason', 'bundle_upload_complete'
        ));
      RAISE EXCEPTION '%',
        'bundle_already_ready: Bundle content cannot be changed '
        || 'after upload is complete. Upload a new bundle instead.';
    END IF;

    -- GHSA-5rg9-rhwj-wj76: CLI/TUS creates r2-direct rows with checksum before
    -- finalize. Lock identity fields once checksum is set; still allow r2_path
    -- writes and the one-shot finalize (r2-direct -> r2).
    IF OLD.storage_provider = 'r2-direct' THEN
      bundle_identity_locked := NULLIF(BTRIM(COALESCE(OLD.checksum, '')), '') IS NOT NULL;

      is_r2_direct_finalize := (
        NEW.storage_provider = 'r2'
        AND NEW.name IS NOT DISTINCT FROM OLD.name
        AND NEW.app_id IS NOT DISTINCT FROM OLD.app_id
        AND NEW.session_key IS NOT DISTINCT FROM OLD.session_key
        AND NEW.key_id IS NOT DISTINCT FROM OLD.key_id
        AND NEW.checksum IS NOT DISTINCT FROM OLD.checksum
        AND NEW.external_url IS NOT DISTINCT FROM OLD.external_url
        AND NEW.native_packages IS NOT DISTINCT FROM OLD.native_packages
      );

      IF bundle_identity_locked
        AND (
          NEW.name IS DISTINCT FROM OLD.name
          OR NEW.app_id IS DISTINCT FROM OLD.app_id
          OR NEW.session_key IS DISTINCT FROM OLD.session_key
          OR NEW.key_id IS DISTINCT FROM OLD.key_id
          OR NEW.checksum IS DISTINCT FROM OLD.checksum
          OR NEW.external_url IS DISTINCT FROM OLD.external_url
          OR NEW.native_packages IS DISTINCT FROM OLD.native_packages
          OR (NEW.manifest IS DISTINCT FROM OLD.manifest AND NEW.manifest IS NOT NULL)
          OR (
            NEW.manifest IS NULL
            AND OLD.manifest IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM pg_catalog.unnest(OLD.manifest) AS entry(file_name, s3_path, file_hash)
              WHERE NOT EXISTS (
                SELECT 1
                FROM public.manifest AS m
                WHERE m.app_version_id = OLD.id
                  AND m.s3_path = entry.s3_path
                  AND m.file_hash = entry.file_hash
              )
            )
          )
          OR (
            NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
            AND NOT is_r2_direct_finalize
          )
        )
      THEN
        PERFORM public.pg_log('deny: BUNDLE_CONTENT_LOCKED_TRIGGER',
          pg_catalog.jsonb_build_object(
            'org_id', OLD.owner_org,
            'app_id', OLD.app_id,
            'version_name', OLD.name,
            'user_id', OLD.user_id,
            'old_storage_provider', OLD.storage_provider,
            'new_storage_provider', NEW.storage_provider,
            'reason', 'r2_direct_identity_locked'
          ));
        RAISE EXCEPTION '%',
          'bundle_already_ready: Bundle content cannot be changed '
          || 'after upload is complete. Upload a new bundle instead.';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.session_key IS NOT DISTINCT FROM OLD.session_key
    AND NEW.key_id IS NOT DISTINCT FROM OLD.key_id
    AND NEW.name IS NOT DISTINCT FROM OLD.name
    AND NEW.app_id IS NOT DISTINCT FROM OLD.app_id
    AND NEW.storage_provider IS NOT DISTINCT FROM OLD.storage_provider
    AND NEW.r2_path IS NOT DISTINCT FROM OLD.r2_path
    AND NEW.external_url IS NOT DISTINCT FROM OLD.external_url
    AND NEW.checksum IS NOT DISTINCT FROM OLD.checksum
    AND NEW.native_packages IS NOT DISTINCT FROM OLD.native_packages
    AND (
      NEW.manifest IS NOT DISTINCT FROM OLD.manifest
      OR (
        NEW.manifest IS NULL
        AND OLD.manifest IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(OLD.manifest) AS entry(file_name, s3_path, file_hash)
          WHERE NOT EXISTS (
            SELECT 1
            FROM public.manifest AS m
            WHERE m.app_version_id = OLD.id
              AND m.s3_path = entry.s3_path
              AND m.file_hash = entry.file_hash
          )
        )
      )
    )
  THEN
    RETURN NEW;
  END IF;

  SELECT apps.owner_org INTO org_id
  FROM public.apps
  WHERE apps.app_id = NEW.app_id;

  IF org_id IS NULL THEN
    org_id := NEW.owner_org;
  END IF;

  IF org_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT enforce_encrypted_bundles, required_encryption_key
  INTO org_enforcing, org_required_key
  FROM public.orgs
  WHERE id = org_id;

  IF org_enforcing IS NULL OR org_enforcing = false THEN
    RETURN NEW;
  END IF;

  bundle_is_encrypted := public.is_bundle_encrypted(NEW.session_key);
  bundle_key_id := NULLIF(pg_catalog.btrim(NEW.key_id), '')::varchar(20);

  IF NOT bundle_is_encrypted THEN
    PERFORM public.pg_log('deny: ORG_REQUIRES_ENCRYPTED_BUNDLES_TRIGGER',
      pg_catalog.jsonb_build_object(
        'org_id', org_id,
        'app_id', NEW.app_id,
        'version_name', NEW.name,
        'user_id', NEW.user_id,
        'reason', 'not_encrypted'
      ));
    RAISE EXCEPTION '%',
      'encryption_required: This organization requires all bundles to be '
      || 'encrypted. Please upload an encrypted bundle with a session_key.';
  END IF;

  IF org_required_key IS NOT NULL AND org_required_key <> '' THEN
    IF bundle_key_id IS NULL THEN
      PERFORM public.pg_log('deny: ORG_REQUIRES_SPECIFIC_ENCRYPTION_KEY_TRIGGER',
        pg_catalog.jsonb_build_object(
          'org_id', org_id,
          'app_id', NEW.app_id,
          'version_name', NEW.name,
          'user_id', NEW.user_id,
          'required_key', org_required_key,
          'bundle_key_id', bundle_key_id,
          'reason', 'missing_key_id'
        ));
      RAISE EXCEPTION '%',
        'encryption_key_required: This organization requires bundles to be '
        || 'encrypted with a specific key. The uploaded bundle does not have '
        || 'a key_id.';
    END IF;

    IF NOT (
      bundle_key_id = pg_catalog.left(org_required_key, 20)
      OR pg_catalog.left(bundle_key_id, pg_catalog.length(org_required_key)) = org_required_key
    ) THEN
      PERFORM public.pg_log('deny: ORG_REQUIRES_SPECIFIC_ENCRYPTION_KEY_TRIGGER',
        pg_catalog.jsonb_build_object(
          'org_id', org_id,
          'app_id', NEW.app_id,
          'version_name', NEW.name,
          'user_id', NEW.user_id,
          'required_key', org_required_key,
          'bundle_key_id', bundle_key_id,
          'reason', 'key_mismatch'
        ));
      RAISE EXCEPTION '%',
        'encryption_key_mismatch: This organization requires bundles to be '
        || 'encrypted with a specific key. The uploaded bundle was encrypted '
        || 'with a different key.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Keep bundle row locks before advisory locks so channel promotion and
-- app_versions protected-field updates serialize without deadlocks.
CREATE OR REPLACE FUNCTION "public"."lock_channel_bundle_lifecycle"("p_version_id" bigint, "p_rollout_version_id" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_bundle_id bigint;
BEGIN
  FOR v_bundle_id IN
    SELECT bundle.bundle_id
    FROM pg_catalog.unnest(ARRAY[p_version_id, p_rollout_version_id]) AS bundle(bundle_id)
    WHERE bundle.bundle_id IS NOT NULL
    ORDER BY bundle.bundle_id
  LOOP
    PERFORM 1
    FROM public.app_versions AS version
    WHERE version.id = v_bundle_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVALID_CHANNEL_BUNDLE';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(v_bundle_id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."enforce_channel_version_promotion_permission"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_request_role text := COALESCE(auth.role(), session_user);
  v_owner_org uuid;
  v_channel_id bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version IS NOT DISTINCT FROM OLD.version THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_owner_org := public.get_owner_org_by_app_id_internal(NEW.app_id);
    v_channel_id := NULL::bigint;
  ELSE
    v_owner_org := OLD.owner_org;
    v_channel_id := OLD.id;
  END IF;

  PERFORM public.lock_channel_bundle_lifecycle(NEW.version, NEW.rollout_version);

  -- A blank target is the native/builtin channel state; an initial target needs
  -- app-level promotion, while changing an existing target is channel-scoped.
  IF v_request_role NOT IN ('service_role', 'postgres')
    AND pg_catalog.current_setting('capgo.seed_channel_targets', true) IS DISTINCT FROM 'true'
  THEN
    IF v_request_role IS DISTINCT FROM 'anon' AND v_request_role IS DISTINCT FROM 'authenticated' THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_CHANNEL_PROMOTE_BUNDLE'
        USING ERRCODE = '42501';
    END IF;

    IF NOT (TG_OP = 'INSERT' AND NEW.version IS NULL)
      AND NOT public.rbac_check_permission_request(
        public.rbac_perm_channel_promote_bundle(),
        v_owner_org,
        NEW.app_id,
        v_channel_id
      ) THEN
      RAISE EXCEPTION 'PERMISSION_DENIED_CHANNEL_PROMOTE_BUNDLE'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.version IS NOT NULL THEN
    PERFORM 1
    FROM public.app_versions AS version
    WHERE version.id = NEW.version
      AND version.app_id = NEW.app_id
      AND version.owner_org = v_owner_org
      AND version.deleted = false;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVALID_CHANNEL_VERSION';
    END IF;

    -- Service-role endpoints carry the key in request.headers. This helper
    -- no-ops for other callers and preserves preview-key bundle ownership.
    PERFORM public.assert_preview_bundle_owner(
      v_owner_org,
      NEW.app_id,
      NEW.version
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."refresh_channel_rollout_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
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
    NEW.rollout_percentage_bps := 0;
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
        AND version.deleted = false;

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
