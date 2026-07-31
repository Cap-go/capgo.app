-- app_preview is an app-scoped bootstrap role. It can upload bundles and create
-- channels only. The channel lifecycle permissions are granted separately, at
-- the channel scope, after this exact API key creates a channel.
INSERT INTO public.roles (name, scope_type, description, priority_rank, is_assignable, created_by)
VALUES (
  'app_preview',
  public.rbac_scope_app(),
  'Preview deployment bootstrap for an app: upload bundles and create channels',
  69,
  true,
  NULL
)
ON CONFLICT (name) DO UPDATE
SET
  scope_type = EXCLUDED.scope_type,
  description = EXCLUDED.description,
  priority_rank = EXCLUDED.priority_rank,
  is_assignable = EXCLUDED.is_assignable;

-- channel_preview is system-managed for preview lifecycle channels. Its parent
-- app_preview binding remains the organization-bound source of authority.
INSERT INTO public.roles (name, scope_type, description, priority_rank, is_assignable, created_by)
VALUES (
  'channel_preview',
  public.rbac_scope_channel(),
  'Preview deployment lifecycle for a channel created by an app-preview API key',
  68,
  false,
  NULL
)
ON CONFLICT (name) DO UPDATE
SET
  scope_type = EXCLUDED.scope_type,
  description = EXCLUDED.description,
  priority_rank = EXCLUDED.priority_rank,
  is_assignable = EXCLUDED.is_assignable;

-- Remove the previous app-wide channel permissions before adding the narrow
-- app bootstrap permissions below. This makes the migration safe to rerun
-- against a database where an earlier revision granted them already.
DELETE FROM public.role_permissions AS role_permission
USING public.roles AS role, public.permissions AS permission
WHERE role_permission.role_id = role.id
  AND role_permission.permission_id = permission.id
  AND role.name = 'app_preview'
  AND permission.key IN (
    public.rbac_perm_channel_read(),
    public.rbac_perm_channel_promote_bundle(),
    public.rbac_perm_channel_delete()
  );

-- Keep app_preview limited to the bootstrap operations. It deliberately
-- excludes bundle deletion, app settings, device control, role management,
-- channel settings, rollbacks, and every app-wide channel permission.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT roles.id, permissions.id
FROM public.roles
INNER JOIN public.permissions
  ON permissions.key IN (
    public.rbac_perm_app_read(),
    public.rbac_perm_app_read_bundles(),
    public.rbac_perm_app_upload_bundle(),
    public.rbac_perm_app_create_channel()
  )
WHERE roles.name = 'app_preview'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT roles.id, permissions.id
FROM public.roles
INNER JOIN public.permissions
  ON permissions.key IN (
    public.rbac_perm_channel_read(),
    public.rbac_perm_channel_promote_bundle(),
    public.rbac_perm_channel_delete()
  )
WHERE roles.name = 'channel_preview'
ON CONFLICT DO NOTHING;

-- Preview-channel grants are children of their app_preview binding. The foreign
-- key revokes them when the parent is removed; RBAC also checks the parent is
-- still active so expiration changes take effect immediately.
ALTER TABLE public.role_bindings
  ADD COLUMN IF NOT EXISTS parent_binding_id uuid;

ALTER TABLE public.role_bindings
  ADD CONSTRAINT role_bindings_parent_binding_id_fkey
  FOREIGN KEY (parent_binding_id)
  REFERENCES public.role_bindings(id)
  ON DELETE CASCADE
  NOT VALID;

-- Supabase applies local and CI migrations through a pipeline, where
-- CREATE INDEX CONCURRENTLY is invalid. This nullable column was added just
-- above, so no pre-existing binding can enter this partial index.
CREATE INDEX IF NOT EXISTS role_bindings_parent_binding_id_idx
  ON public.role_bindings(parent_binding_id)
  WHERE parent_binding_id IS NOT NULL;

ALTER TABLE public.role_bindings
  VALIDATE CONSTRAINT role_bindings_parent_binding_id_fkey;

ALTER TABLE public.app_versions
  ADD COLUMN IF NOT EXISTS created_by_apikey_rbac_id uuid;

COMMENT ON COLUMN public.app_versions.created_by_apikey_rbac_id IS
  'Immutable API-key RBAC principal recorded only for bundles created by an active app_preview API key. Legacy bundles remain NULL and are not preview-key manageable.';

CREATE OR REPLACE FUNCTION public.current_app_preview_binding_id(
  p_owner_org uuid,
  p_app_id character varying
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_apikey_text text;
  v_apikey public.apikeys%ROWTYPE;
  v_parent_binding_id uuid;
BEGIN
  IF p_owner_org IS NULL OR p_app_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT public.get_apikey_header() INTO v_apikey_text;
  IF v_apikey_text IS NULL OR v_apikey_text = '' THEN
    RETURN NULL;
  END IF;

  SELECT *
  INTO v_apikey
  FROM public.find_apikey_by_value(v_apikey_text)
  LIMIT 1;

  IF v_apikey.id IS NULL OR public.is_apikey_expired(v_apikey.expires_at) THEN
    RETURN NULL;
  END IF;

  SELECT parent_binding.id
  INTO v_parent_binding_id
  FROM public.role_bindings AS parent_binding
  INNER JOIN public.roles AS parent_role
    ON parent_role.id = parent_binding.role_id
    AND parent_role.scope_type = parent_binding.scope_type
  INNER JOIN public.apps AS app
    ON app.id = parent_binding.app_id
  WHERE parent_binding.principal_type = public.rbac_principal_apikey()
    AND parent_binding.principal_id = v_apikey.rbac_id
    AND parent_binding.scope_type = public.rbac_scope_app()
    AND parent_binding.org_id = p_owner_org
    AND parent_role.name = 'app_preview'
    AND app.app_id = p_app_id
    AND app.owner_org = p_owner_org
    AND (parent_binding.expires_at IS NULL OR parent_binding.expires_at > pg_catalog.now())
  LIMIT 1;

  RETURN v_parent_binding_id;
END;
$$;

ALTER FUNCTION public.current_app_preview_binding_id(uuid, character varying) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_app_preview_binding_id(uuid, character varying) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_preview_binding_id(uuid, character varying) TO service_role;

CREATE OR REPLACE FUNCTION public.validate_channel_preview_role_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role_name text;
  v_parent_principal_id uuid;
  v_parent_org_id uuid;
  v_parent_app_id uuid;
  v_channel_org_id uuid;
  v_channel_app_id uuid;
BEGIN
  SELECT roles.name
  INTO v_role_name
  FROM public.roles
  WHERE roles.id = NEW.role_id
  LIMIT 1;

  IF v_role_name IS DISTINCT FROM 'channel_preview' THEN
    RETURN NEW;
  END IF;

  IF NEW.principal_type IS DISTINCT FROM public.rbac_principal_apikey()
    OR NEW.scope_type IS DISTINCT FROM public.rbac_scope_channel()
    OR NEW.is_direct IS DISTINCT FROM false
    OR NEW.parent_binding_id IS NULL
    OR NEW.expires_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'INVALID_CHANNEL_PREVIEW_BINDING'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    parent_binding.principal_id,
    parent_binding.org_id,
    parent_binding.app_id
  INTO
    v_parent_principal_id,
    v_parent_org_id,
    v_parent_app_id
  FROM public.role_bindings AS parent_binding
  INNER JOIN public.roles AS parent_role
    ON parent_role.id = parent_binding.role_id
    AND parent_role.scope_type = parent_binding.scope_type
  WHERE parent_binding.id = NEW.parent_binding_id
    AND parent_binding.principal_type = public.rbac_principal_apikey()
    AND parent_binding.scope_type = public.rbac_scope_app()
    AND parent_role.name = 'app_preview'
    AND (parent_binding.expires_at IS NULL OR parent_binding.expires_at > pg_catalog.now())
  LIMIT 1;

  IF v_parent_principal_id IS NULL
    OR v_parent_principal_id IS DISTINCT FROM NEW.principal_id
    OR v_parent_org_id IS DISTINCT FROM NEW.org_id
    OR v_parent_app_id IS DISTINCT FROM NEW.app_id
  THEN
    RAISE EXCEPTION 'INVALID_CHANNEL_PREVIEW_PARENT'
      USING ERRCODE = '42501';
  END IF;

  SELECT channel.owner_org, app.id
  INTO v_channel_org_id, v_channel_app_id
  FROM public.channels AS channel
  INNER JOIN public.apps AS app
    ON app.app_id = channel.app_id
    AND app.owner_org = channel.owner_org
  WHERE channel.rbac_id = NEW.channel_id
  LIMIT 1;

  IF v_channel_org_id IS NULL
    OR v_channel_org_id IS DISTINCT FROM NEW.org_id
    OR v_channel_app_id IS DISTINCT FROM NEW.app_id
  THEN
    RAISE EXCEPTION 'INVALID_CHANNEL_PREVIEW_SCOPE'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.validate_channel_preview_role_binding() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.validate_channel_preview_role_binding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_channel_preview_role_binding() TO service_role;

DROP TRIGGER IF EXISTS validate_channel_preview_role_binding ON public.role_bindings;
CREATE TRIGGER validate_channel_preview_role_binding
BEFORE INSERT OR UPDATE OF role_id, scope_type, principal_type, principal_id, org_id, app_id, channel_id, parent_binding_id, expires_at, is_direct
ON public.role_bindings
FOR EACH ROW
EXECUTE FUNCTION public.validate_channel_preview_role_binding();

CREATE OR REPLACE FUNCTION public.bind_app_preview_apikey_to_created_channel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_parent_binding_id uuid;
  v_apikey_text text;
  v_apikey public.apikeys%ROWTYPE;
BEGIN
  SELECT public.current_app_preview_binding_id(NEW.owner_org, NEW.app_id)
  INTO v_parent_binding_id;

  IF v_parent_binding_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT public.get_apikey_header() INTO v_apikey_text;
  SELECT *
  INTO v_apikey
  FROM public.find_apikey_by_value(v_apikey_text)
  LIMIT 1;

  IF v_apikey.id IS NULL
    OR public.is_apikey_expired(v_apikey.expires_at)
    OR v_apikey.user_id IS DISTINCT FROM NEW.created_by
  THEN
    RAISE EXCEPTION 'INVALID_PREVIEW_CHANNEL_CREATOR'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.role_bindings (
    principal_type,
    principal_id,
    role_id,
    scope_type,
    org_id,
    app_id,
    channel_id,
    parent_binding_id,
    granted_by,
    granted_at,
    reason,
    is_direct
  )
  SELECT
    public.rbac_principal_apikey(),
    parent_binding.principal_id,
    preview_role.id,
    public.rbac_scope_channel(),
    parent_binding.org_id,
    parent_binding.app_id,
    NEW.rbac_id,
    parent_binding.id,
    v_apikey.user_id,
    pg_catalog.now(),
    'Automatically granted to the app-preview API key that created this channel',
    false
  FROM public.role_bindings AS parent_binding
  INNER JOIN public.roles AS preview_role
    ON preview_role.name = 'channel_preview'
    AND preview_role.scope_type = public.rbac_scope_channel()
  WHERE parent_binding.id = v_parent_binding_id
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.bind_app_preview_apikey_to_created_channel() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bind_app_preview_apikey_to_created_channel() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bind_app_preview_apikey_to_created_channel() TO service_role;

DROP TRIGGER IF EXISTS bind_app_preview_apikey_to_created_channel ON public.channels;
CREATE TRIGGER bind_app_preview_apikey_to_created_channel
AFTER INSERT ON public.channels
FOR EACH ROW
EXECUTE FUNCTION public.bind_app_preview_apikey_to_created_channel();

-- A channel_preview binding is effective only while its exact app_preview parent
-- remains active for the same API key, organization, and app. This prevents a
-- stale child binding from surviving role revocation or expiration.
CREATE OR REPLACE FUNCTION public.rbac_has_permission(
  p_principal_type text,
  p_principal_id uuid,
  p_permission_key text,
  p_org_id uuid,
  p_app_id character varying,
  p_channel_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id uuid := p_org_id;
  v_app_uuid uuid;
  v_app_owner_org uuid;
  v_channel_uuid uuid;
  v_channel_app_id text;
  v_channel_org_id uuid;
  v_has boolean := false;
BEGIN
  IF p_permission_key IS NULL THEN
    RETURN false;
  END IF;

  IF p_app_id IS NOT NULL THEN
    SELECT app.id, app.owner_org
    INTO v_app_uuid, v_app_owner_org
    FROM public.apps AS app
    WHERE app.app_id = p_app_id
    LIMIT 1;

    IF v_app_owner_org IS NOT NULL THEN
      v_org_id := v_app_owner_org;
    END IF;
  END IF;

  IF p_channel_id IS NOT NULL THEN
    SELECT channel.rbac_id, channel.app_id, channel.owner_org
    INTO v_channel_uuid, v_channel_app_id, v_channel_org_id
    FROM public.channels AS channel
    WHERE channel.id = p_channel_id
    LIMIT 1;

    IF v_channel_uuid IS NOT NULL THEN
      IF p_app_id IS NOT NULL AND p_app_id IS DISTINCT FROM v_channel_app_id THEN
        RETURN false;
      END IF;

      IF p_org_id IS NOT NULL AND p_org_id IS DISTINCT FROM v_channel_org_id THEN
        RETURN false;
      END IF;

      SELECT app.id
      INTO v_app_uuid
      FROM public.apps AS app
      WHERE app.app_id = v_channel_app_id
      LIMIT 1;

      v_org_id := v_channel_org_id;
    END IF;
  END IF;

  WITH RECURSIVE scope_catalog AS (
    SELECT public.rbac_scope_org()::text AS scope_type, v_org_id AS org_id, NULL::uuid AS app_id, NULL::uuid AS channel_id WHERE v_org_id IS NOT NULL
    UNION ALL
    SELECT public.rbac_scope_app(), v_org_id, v_app_uuid, NULL::uuid WHERE v_app_uuid IS NOT NULL
    UNION ALL
    SELECT public.rbac_scope_channel(), v_org_id, v_app_uuid, v_channel_uuid WHERE v_channel_uuid IS NOT NULL
  ),
  direct_roles AS (
    SELECT role_binding.role_id, role_binding.scope_type
    FROM scope_catalog AS scope
    INNER JOIN public.role_bindings AS role_binding
      ON role_binding.scope_type = scope.scope_type
      AND (
        (role_binding.scope_type = public.rbac_scope_org() AND role_binding.org_id = scope.org_id)
        OR (role_binding.scope_type = public.rbac_scope_app() AND role_binding.org_id = scope.org_id AND role_binding.app_id = scope.app_id)
        OR (role_binding.scope_type = public.rbac_scope_channel() AND role_binding.org_id = scope.org_id AND role_binding.app_id = scope.app_id AND role_binding.channel_id = scope.channel_id)
      )
    INNER JOIN public.roles AS role
      ON role.id = role_binding.role_id
      AND role.scope_type = role_binding.scope_type
    WHERE role_binding.principal_type = p_principal_type
      AND role_binding.principal_id = p_principal_id
      AND (role_binding.expires_at IS NULL OR role_binding.expires_at > pg_catalog.now())
      AND (
        role.name <> 'channel_preview'
        OR (
          role_binding.principal_type = public.rbac_principal_apikey()
          AND role_binding.is_direct IS FALSE
          AND role_binding.parent_binding_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.role_bindings AS parent_binding
            INNER JOIN public.roles AS parent_role
              ON parent_role.id = parent_binding.role_id
              AND parent_role.scope_type = parent_binding.scope_type
            WHERE parent_binding.id = role_binding.parent_binding_id
              AND parent_binding.principal_type = role_binding.principal_type
              AND parent_binding.principal_id = role_binding.principal_id
              AND parent_binding.scope_type = public.rbac_scope_app()
              AND parent_binding.org_id = scope.org_id
              AND parent_binding.app_id = scope.app_id
              AND parent_role.name = 'app_preview'
              AND (parent_binding.expires_at IS NULL OR parent_binding.expires_at > pg_catalog.now())
          )
        )
      )
  ),
  group_roles AS (
    SELECT role_binding.role_id, role_binding.scope_type
    FROM scope_catalog AS scope
    INNER JOIN public.group_members AS group_member
      ON group_member.user_id = p_principal_id
    INNER JOIN public.groups AS member_group
      ON member_group.id = group_member.group_id
    INNER JOIN public.role_bindings AS role_binding
      ON role_binding.principal_type = public.rbac_principal_group()
      AND role_binding.principal_id = group_member.group_id
    INNER JOIN public.roles AS role
      ON role.id = role_binding.role_id
      AND role.scope_type = role_binding.scope_type
    WHERE p_principal_type = public.rbac_principal_user()
      AND role.name <> 'channel_preview'
      AND role_binding.scope_type = scope.scope_type
      AND (
        (role_binding.scope_type = public.rbac_scope_org() AND role_binding.org_id = scope.org_id)
        OR (role_binding.scope_type = public.rbac_scope_app() AND role_binding.org_id = scope.org_id AND role_binding.app_id = scope.app_id)
        OR (role_binding.scope_type = public.rbac_scope_channel() AND role_binding.org_id = scope.org_id AND role_binding.app_id = scope.app_id AND role_binding.channel_id = scope.channel_id)
      )
      AND (v_org_id IS NULL OR member_group.org_id = v_org_id)
      AND (role_binding.expires_at IS NULL OR role_binding.expires_at > pg_catalog.now())
  ),
  combined_roles AS (
    SELECT role_id, scope_type FROM direct_roles
    UNION
    SELECT role_id, scope_type FROM group_roles
  ),
  role_closure AS (
    SELECT role_id, scope_type FROM combined_roles
    UNION
    SELECT hierarchy.child_role_id, closure.scope_type
    FROM public.role_hierarchy AS hierarchy
    INNER JOIN role_closure AS closure
      ON closure.role_id = hierarchy.parent_role_id
    INNER JOIN public.roles AS child_role
      ON child_role.id = hierarchy.child_role_id
      AND child_role.scope_type = closure.scope_type
  ),
  permission_set AS (
    SELECT DISTINCT permission.key
    FROM role_closure AS closure
    INNER JOIN public.role_permissions AS role_permission
      ON role_permission.role_id = closure.role_id
    INNER JOIN public.permissions AS permission
      ON permission.id = role_permission.permission_id
  )
  SELECT EXISTS (
    SELECT 1
    FROM permission_set
    WHERE permission_set.key = p_permission_key
  )
  INTO v_has;

  RETURN v_has;
END;
$$;

ALTER FUNCTION public.rbac_has_permission(text, uuid, text, uuid, character varying, bigint) OWNER TO postgres;

COMMENT ON FUNCTION public.rbac_has_permission(text, uuid, text, uuid, character varying, bigint) IS
  'Checks org, app, and channel RBAC permissions. System-managed channel_preview bindings require their active organization-bound app_preview parent.';

CREATE OR REPLACE FUNCTION public.current_app_preview_apikey_rbac_id(
  p_owner_org uuid,
  p_app_id character varying
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_parent_binding_id uuid;
  v_apikey_rbac_id uuid;
BEGIN
  SELECT public.current_app_preview_binding_id(p_owner_org, p_app_id)
  INTO v_parent_binding_id;

  IF v_parent_binding_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT parent_binding.principal_id
  INTO v_apikey_rbac_id
  FROM public.role_bindings AS parent_binding
  WHERE parent_binding.id = v_parent_binding_id
  LIMIT 1;

  RETURN v_apikey_rbac_id;
END;
$$;

ALTER FUNCTION public.current_app_preview_apikey_rbac_id(uuid, character varying) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_app_preview_apikey_rbac_id(uuid, character varying) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_preview_apikey_rbac_id(uuid, character varying) TO service_role;

-- Bundle provenance is derived from the authenticated API key, never from a
-- client-provided column. Preview keys can subsequently mutate only their own
-- bundles; legacy bundles without an exact key marker fail closed.
CREATE OR REPLACE FUNCTION public.enforce_preview_bundle_ownership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_preview_apikey_rbac_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT public.current_app_preview_apikey_rbac_id(NEW.owner_org, NEW.app_id)
    INTO v_preview_apikey_rbac_id;

    NEW.created_by_apikey_rbac_id := v_preview_apikey_rbac_id;
    RETURN NEW;
  END IF;

  SELECT public.current_app_preview_apikey_rbac_id(OLD.owner_org, OLD.app_id)
  INTO v_preview_apikey_rbac_id;

  IF NEW.created_by_apikey_rbac_id IS DISTINCT FROM OLD.created_by_apikey_rbac_id THEN
    RAISE EXCEPTION 'PREVIEW_BUNDLE_CREATOR_IMMUTABLE'
      USING ERRCODE = '42501';
  END IF;

  IF v_preview_apikey_rbac_id IS NOT NULL
    AND OLD.created_by_apikey_rbac_id IS DISTINCT FROM v_preview_apikey_rbac_id
  THEN
    RAISE EXCEPTION 'PREVIEW_APIKEY_CAN_ONLY_MANAGE_OWN_BUNDLE'
      USING ERRCODE = '42501';
  END IF;

  -- Endpoint-level lifecycle checks are not sufficient here: an app_preview
  -- key can directly update app_versions through PostgREST. Once a bundle is
  -- referenced by a main channel or another key's preview channel, only a
  -- matching active channel_preview binding may keep it mutable.
  IF v_preview_apikey_rbac_id IS NOT NULL
    AND OLD.created_by_apikey_rbac_id = v_preview_apikey_rbac_id
    AND EXISTS (
      SELECT 1
      FROM public.channels AS channel
      WHERE channel.app_id = OLD.app_id
        AND channel.owner_org = OLD.owner_org
        AND (channel.version = OLD.id OR channel.rollout_version = OLD.id)
        AND NOT EXISTS (
          SELECT 1
          FROM public.role_bindings AS child_binding
          INNER JOIN public.roles AS child_role
            ON child_role.id = child_binding.role_id
            AND child_role.scope_type = child_binding.scope_type
          INNER JOIN public.apps AS app
            ON app.id = child_binding.app_id
            AND app.app_id = channel.app_id
            AND app.owner_org = channel.owner_org
          INNER JOIN public.role_bindings AS parent_binding
            ON parent_binding.id = child_binding.parent_binding_id
          INNER JOIN public.roles AS parent_role
            ON parent_role.id = parent_binding.role_id
            AND parent_role.scope_type = parent_binding.scope_type
          WHERE child_binding.principal_type = public.rbac_principal_apikey()
            AND child_binding.principal_id = v_preview_apikey_rbac_id
            AND child_binding.scope_type = public.rbac_scope_channel()
            AND child_binding.org_id = channel.owner_org
            AND child_binding.channel_id = channel.rbac_id
            AND child_binding.is_direct IS FALSE
            AND child_role.name = 'channel_preview'
            AND (child_binding.expires_at IS NULL OR child_binding.expires_at > pg_catalog.now())
            AND parent_binding.principal_type = child_binding.principal_type
            AND parent_binding.principal_id = child_binding.principal_id
            AND parent_binding.scope_type = public.rbac_scope_app()
            AND parent_binding.org_id = child_binding.org_id
            AND parent_binding.app_id = child_binding.app_id
            AND parent_role.name = 'app_preview'
            AND (parent_binding.expires_at IS NULL OR parent_binding.expires_at > pg_catalog.now())
        )
    )
  THEN
    RAISE EXCEPTION 'PREVIEW_APIKEY_CANNOT_MUTATE_SHARED_BUNDLE'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_preview_bundle_ownership() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_preview_bundle_ownership() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_preview_bundle_ownership() TO service_role;

DROP TRIGGER IF EXISTS track_preview_bundle_creator ON public.app_versions;
CREATE TRIGGER track_preview_bundle_creator
BEFORE INSERT OR UPDATE ON public.app_versions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_preview_bundle_ownership();

CREATE OR REPLACE FUNCTION public.assert_preview_bundle_owner(
  p_owner_org uuid,
  p_app_id character varying,
  p_version_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_preview_apikey_rbac_id uuid;
  v_bundle_creator_apikey_rbac_id uuid;
BEGIN
  IF p_version_id IS NULL THEN
    RETURN;
  END IF;

  SELECT public.current_app_preview_apikey_rbac_id(p_owner_org, p_app_id)
  INTO v_preview_apikey_rbac_id;

  IF v_preview_apikey_rbac_id IS NULL THEN
    RETURN;
  END IF;

  SELECT version.created_by_apikey_rbac_id
  INTO v_bundle_creator_apikey_rbac_id
  FROM public.app_versions AS version
  WHERE version.id = p_version_id
    AND version.app_id = p_app_id
    AND version.owner_org = p_owner_org
    AND version.deleted = false
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_CHANNEL_VERSION';
  END IF;

  IF v_bundle_creator_apikey_rbac_id IS DISTINCT FROM v_preview_apikey_rbac_id THEN
    RAISE EXCEPTION 'PREVIEW_APIKEY_CAN_ONLY_PROMOTE_OWN_BUNDLE'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

ALTER FUNCTION public.assert_preview_bundle_owner(uuid, character varying, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assert_preview_bundle_owner(uuid, character varying, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_preview_bundle_owner(uuid, character varying, bigint) TO service_role;

-- Promotion and preview deletion serialize on each immutable bundle id. The
-- shared lock prevents a new channel reference from appearing between the
-- preview-delete linked-channel check and its app_versions soft delete.
CREATE OR REPLACE FUNCTION public.lock_channel_bundle_lifecycle(
  p_version_id bigint,
  p_rollout_version_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
    PERFORM pg_catalog.pg_advisory_xact_lock(v_bundle_id);
  END LOOP;
END;
$$;

ALTER FUNCTION public.lock_channel_bundle_lifecycle(bigint, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_channel_bundle_lifecycle(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_channel_bundle_lifecycle(bigint, bigint) TO service_role;

-- Service-role endpoints set request.headers.capgkey before their channel
-- write. Keep that key-bound ownership check active even when service_role
-- bypasses the normal channel-permission branch.
CREATE OR REPLACE FUNCTION public.enforce_channel_version_promotion_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_request_role text := COALESCE(auth.role(), session_user);
  v_owner_org uuid;
  v_channel_id bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version IS NOT DISTINCT FROM OLD.version THEN
    RETURN NEW;
  END IF;

  PERFORM public.lock_channel_bundle_lifecycle(NEW.version, NEW.rollout_version);

  IF TG_OP = 'INSERT' THEN
    v_owner_org := public.get_owner_org_by_app_id_internal(NEW.app_id);
    v_channel_id := NULL::bigint;
  ELSE
    v_owner_org := OLD.owner_org;
    v_channel_id := OLD.id;
  END IF;

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
      AND version.deleted = false
    FOR KEY SHARE;

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

ALTER FUNCTION public.enforce_channel_version_promotion_permission() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_channel_version_promotion_permission() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_channel_version_promotion_permission() TO service_role;

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
GRANT EXECUTE ON FUNCTION public.refresh_channel_rollout_id() TO service_role;

-- App-scoped keys no longer need the automatic organization reader for CLI
-- warnings: the warning helper falls back to app.read. Remove only the rows
-- created by that compatibility path, preserving historical migrated keys.
DELETE FROM public.role_bindings AS org_reader
USING public.roles AS org_reader_role
WHERE org_reader.role_id = org_reader_role.id
  AND org_reader.principal_type = public.rbac_principal_apikey()
  AND org_reader.scope_type = public.rbac_scope_org()
  AND org_reader_role.name = public.rbac_role_apikey_org_reader()
  AND org_reader.reason = 'API key app-scope org read compatibility';

-- Keep the API-key listing RPC signed-in only. Reassert explicit grants so the
-- function cannot regain anonymous execution through default ACLs.
REVOKE ALL ON FUNCTION public.get_org_apikeys(uuid) FROM public;
REVOKE ALL ON FUNCTION public.get_org_apikeys(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_org_apikeys(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_org_apikeys(uuid) TO authenticated,
service_role;

-- These helpers are public RPC entry points: anonymous callers authenticate
-- through the request API-key header, while each function performs its own RBAC
-- authorization before returning data.
REVOKE ALL ON FUNCTION public.check_org_members_2fa_enabled(uuid) FROM public;
REVOKE ALL ON FUNCTION public.check_org_members_2fa_enabled(uuid) FROM anon,
authenticated,
service_role;
GRANT EXECUTE ON FUNCTION public.check_org_members_2fa_enabled(uuid) TO anon,
authenticated,
service_role;

REVOKE ALL ON FUNCTION public.get_org_perm_for_apikey_v2(
    text, text
) FROM public;
REVOKE ALL ON FUNCTION public.get_org_perm_for_apikey_v2(text, text) FROM anon,
authenticated,
service_role;
GRANT EXECUTE ON FUNCTION public.get_org_perm_for_apikey_v2(text, text) TO anon,
authenticated,
service_role;

REVOKE ALL ON FUNCTION public.check_org_members_password_policy(
    uuid
) FROM public;
REVOKE ALL ON FUNCTION public.check_org_members_password_policy(uuid) FROM anon,
authenticated,
service_role;
GRANT EXECUTE ON FUNCTION public.check_org_members_password_policy(
    uuid
) TO anon,
authenticated,
service_role;

REVOKE ALL ON FUNCTION public.get_org_members(uuid) FROM public;
REVOKE ALL ON FUNCTION public.get_org_members(uuid) FROM anon,
authenticated,
service_role;
GRANT EXECUTE ON FUNCTION public.get_org_members(uuid) TO anon,
authenticated,
service_role;

REVOKE ALL ON FUNCTION public.get_org_members_rbac(uuid) FROM public;
REVOKE ALL ON FUNCTION public.get_org_members_rbac(uuid) FROM anon,
authenticated,
service_role;
GRANT EXECUTE ON FUNCTION public.get_org_members_rbac(uuid) TO anon,
authenticated,
service_role;

REVOKE ALL ON FUNCTION public.update_org_invite_role_rbac(
    uuid, uuid, text
) FROM public;
REVOKE ALL ON FUNCTION public.update_org_invite_role_rbac(
    uuid, uuid, text
) FROM anon,
authenticated,
service_role;
GRANT EXECUTE ON FUNCTION public.update_org_invite_role_rbac(
    uuid, uuid, text
) TO anon,
authenticated,
service_role;

REVOKE ALL ON FUNCTION public.update_tmp_invite_role_rbac(
    uuid, text, text
) FROM public;
REVOKE ALL ON FUNCTION public.update_tmp_invite_role_rbac(
    uuid, text, text
) FROM anon,
authenticated,
service_role;
GRANT EXECUTE ON FUNCTION public.update_tmp_invite_role_rbac(
    uuid, text, text
) TO anon,
authenticated,
service_role;

-- Default privileges can grant EXECUTE directly to anon/authenticated after a
-- function-level PUBLIC revoke. Reassert the service-only ACLs explicitly.
DO $$
DECLARE
  function_signature pg_catalog.regprocedure;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.apikey_has_current_org_create_capability(uuid)'::pg_catalog.regprocedure,
    'public.apikey_has_global_permission(text, text)'::pg_catalog.regprocedure,
    'public.apikeys_force_server_key()'::pg_catalog.regprocedure,
    'public.apikeys_strip_plain_key_for_hashed()'::pg_catalog.regprocedure,
    'public.assert_effective_super_admin_binding_removal(uuid, text)'::pg_catalog.regprocedure,
    'public.prevent_role_binding_priority_escalation()'::pg_catalog.regprocedure,
    'public.check_encrypted_bundle_on_insert()'::pg_catalog.regprocedure,
    'public.check_org_hashed_key_enforcement(uuid, public.apikeys)'::pg_catalog.regprocedure,
    'public.cleanup_onboarding_app_data_on_complete()'::pg_catalog.regprocedure,
    'public.delete_old_deleted_versions()'::pg_catalog.regprocedure,
    'public.enqueue_credit_usage_posthog_event()'::pg_catalog.regprocedure,
    'public.generate_org_user_stripe_info_on_org_create()'::pg_catalog.regprocedure,
    'public.get_apikey()'::pg_catalog.regprocedure,
    'public.get_org_members(uuid, uuid)'::pg_catalog.regprocedure,
    'public.noupdate()'::pg_catalog.regprocedure,
    'public.prevent_last_super_admin_binding_delete()'::pg_catalog.regprocedure,
    'public.prevent_last_super_admin_binding_update()'::pg_catalog.regprocedure,
    'public.process_all_cron_tasks()'::pg_catalog.regprocedure,
    'public.process_queue_with_healthcheck(text[], integer, text)'::pg_catalog.regprocedure,
    'public.reassign_webhook_created_by_before_user_delete()'::pg_catalog.regprocedure,
    'public.sanitize_apps_text_fields()'::pg_catalog.regprocedure,
    'public.sanitize_orgs_text_fields()'::pg_catalog.regprocedure,
    'public.sanitize_tmp_users_text_fields()'::pg_catalog.regprocedure,
    'public.sanitize_users_text_fields()'::pg_catalog.regprocedure,
    'public.set_webhook_created_by()'::pg_catalog.regprocedure,
    'public.sync_org_has_usage_credits_from_grants()'::pg_catalog.regprocedure
  ]
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', function_signature);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO service_role', function_signature);
  END LOOP;
END;
$$;

-- channel_preview is deliberately non-assignable. Its only write path is the
-- nested channel-creation trigger above; the validator below this exemption
-- still verifies its exact active app_preview parent before the row is stored.
CREATE OR REPLACE FUNCTION public.prevent_role_binding_priority_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_role_priority integer;
  v_new_role_priority integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.lock_rbac_orgs(OLD.org_id);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.lock_rbac_orgs(NEW.org_id);
  ELSE
    PERFORM public.lock_rbac_orgs(OLD.org_id, NEW.org_id);
  END IF;

  IF (TG_OP = 'DELETE' AND public.is_org_delete_cascade(OLD.org_id))
    OR (TG_OP = 'INSERT' AND public.is_org_delete_cascade(NEW.org_id))
    OR (TG_OP = 'UPDATE' AND (public.is_org_delete_cascade(OLD.org_id) OR public.is_org_delete_cascade(NEW.org_id)))
  THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT (
      (
        OLD.principal_type = public.rbac_principal_user()
        AND public.is_nested_self_org_departure_cleanup(OLD.org_id, OLD.principal_id)
      )
      OR (
        OLD.principal_type = public.rbac_principal_apikey()
        AND EXISTS (
          SELECT 1
          FROM public.apikeys
          WHERE apikeys.rbac_id = OLD.principal_id
            AND public.is_nested_self_org_departure_cleanup(OLD.org_id, apikeys.user_id)
        )
      )
    ) THEN
      PERFORM public.assert_effective_super_admin_binding_removal(OLD.id, 'CANNOT_DELETE_LAST_SUPER_ADMIN_BINDING');
    END IF;
  ELSIF TG_OP = 'UPDATE'
    AND NOT (
      NEW.org_id IS NOT DISTINCT FROM OLD.org_id
      AND NEW.principal_type IS NOT DISTINCT FROM OLD.principal_type
      AND NEW.principal_id IS NOT DISTINCT FROM OLD.principal_id
      AND public.is_active_org_super_admin_binding(
        NEW.role_id,
        NEW.scope_type,
        NEW.principal_type,
        NEW.org_id,
        NEW.expires_at
      )
    )
  THEN
    PERFORM public.assert_effective_super_admin_binding_removal(OLD.id, 'CANNOT_DEMOTE_LAST_SUPER_ADMIN_BINDING');
  END IF;

  -- A future expiry removes this binding. Keep another non-expiring effective
  -- administrator so a chain of scheduled expirations cannot orphan the org.
  IF TG_OP = 'UPDATE'
    AND NEW.expires_at IS NOT NULL
    AND NEW.expires_at IS DISTINCT FROM OLD.expires_at
    AND public.is_active_org_super_admin_binding(
      OLD.role_id,
      OLD.scope_type,
      OLD.principal_type,
      OLD.org_id,
      OLD.expires_at
    )
    AND public.is_active_org_super_admin_binding(
      NEW.role_id,
      NEW.scope_type,
      NEW.principal_type,
      NEW.org_id,
      NEW.expires_at
    )
    AND NOT public.has_effective_non_expiring_org_super_admin_after_removal(
      NEW.org_id,
      OLD.id
    )
  THEN
    RAISE EXCEPTION 'CANNOT_DEMOTE_LAST_SUPER_ADMIN_BINDING'
      USING HINT = 'At least one effective active organization super admin must remain after this binding expires.';
  END IF;

  IF public.is_internal_request_role(public.current_request_role()) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE'
    AND (
      (
        OLD.principal_type = public.rbac_principal_user()
        AND public.is_nested_self_org_departure_cleanup(OLD.org_id, OLD.principal_id)
      )
      OR (
        OLD.principal_type = public.rbac_principal_apikey()
        AND EXISTS (
          SELECT 1
          FROM public.apikeys
          WHERE apikeys.rbac_id = OLD.principal_id
            AND public.is_nested_self_org_departure_cleanup(OLD.org_id, apikeys.user_id)
        )
      )
    )
  THEN
    RETURN OLD;
  END IF;

  IF TG_OP <> 'DELETE'
    AND pg_trigger_depth() > 1
    AND current_setting('capgo.org_creation_bootstrap_org_id', true) = NEW.org_id::text
    AND NEW.principal_type = public.rbac_principal_user()
    AND NEW.scope_type = public.rbac_scope_org()
    AND NEW.principal_id = NEW.granted_by
    AND NEW.app_id IS NULL
    AND NEW.bundle_id IS NULL
    AND NEW.channel_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.orgs
      WHERE orgs.id = NEW.org_id
        AND orgs.created_by = NEW.principal_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.roles
      WHERE roles.id = NEW.role_id
        AND roles.scope_type = public.rbac_scope_org()
        AND roles.name = public.rbac_role_org_super_admin()
    )
  THEN
    RETURN NEW;
  END IF;

  -- The channel insert trigger is the sole creator of this non-assignable role.
  -- validate_channel_preview_role_binding fires after this guard and checks the
  -- exact active parent, key, organization, app, and channel scope.
  IF TG_OP = 'INSERT'
    AND pg_trigger_depth() > 1
    AND NEW.principal_type = public.rbac_principal_apikey()
    AND NEW.scope_type = public.rbac_scope_channel()
    AND NEW.is_direct IS FALSE
    AND NEW.parent_binding_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.roles
      WHERE roles.id = NEW.role_id
        AND roles.scope_type = public.rbac_scope_channel()
        AND roles.name = 'channel_preview'
        AND roles.is_assignable IS FALSE
    )
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT roles.priority_rank
    INTO v_old_role_priority
    FROM public.roles
    WHERE roles.id = OLD.role_id
      AND roles.scope_type = OLD.scope_type
    LIMIT 1;

    PERFORM public.assert_request_principal_rank(
      OLD.org_id,
      v_old_role_priority,
      'role_binding_old'
    );
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT roles.priority_rank
    INTO v_new_role_priority
    FROM public.roles
    WHERE roles.id = NEW.role_id
      AND roles.scope_type = NEW.scope_type
      AND roles.is_assignable IS TRUE
    LIMIT 1;

    IF v_new_role_priority IS NULL THEN
      PERFORM public.pg_log(
        'deny: ROLE_BINDING_ROLE_UNKNOWN',
        pg_catalog.jsonb_build_object('org_id', NEW.org_id, 'role_id', NEW.role_id)
      );
      RAISE EXCEPTION 'Admins cannot assign this role!';
    END IF;

    PERFORM public.assert_request_principal_rank(
      NEW.org_id,
      v_new_role_priority,
      'role_binding_new'
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_role_binding_priority_escalation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prevent_role_binding_priority_escalation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_role_binding_priority_escalation() TO service_role;

-- The squashed baseline is already applied in existing environments, so ensure
-- its scheduler registration is restored with a forward-only migration.
SELECT
    cron.schedule(
        'process_all_cron_tasks',
        '10 seconds',
        $job$SELECT public.process_all_cron_tasks();$job$
    )
WHERE NOT EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'process_all_cron_tasks'
);
