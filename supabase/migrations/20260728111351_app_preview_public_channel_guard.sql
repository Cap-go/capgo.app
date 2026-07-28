-- A public/default channel changes app delivery settings. App-preview keys may
-- bootstrap private channels, but must not create or flip a channel to public.
-- Keep this in INSERT/UPDATE RLS because CLI/PostgREST can write the table
-- directly; the channel endpoint performs the matching guard for its admin and
-- raw-SQL paths.
DROP POLICY IF EXISTS "Allow RBAC channels insert" ON public.channels;
CREATE POLICY "Allow RBAC channels insert"
ON public.channels
FOR INSERT
TO anon, authenticated
WITH CHECK (
  public.rbac_check_permission_request(
    public.rbac_perm_app_create_channel(),
    owner_org,
    app_id,
    NULL::bigint
  )
  AND (
    "public" IS FALSE
    OR public.rbac_check_permission_request(
      public.rbac_perm_app_update_settings(),
      owner_org,
      app_id,
      NULL::bigint
    )
  )
  AND (
    (version IS NULL AND rollout_version IS NULL)
    OR public.rbac_check_permission_request(
      public.rbac_perm_channel_promote_bundle(),
      owner_org,
      app_id,
      NULL::bigint
    )
  )
);

DROP POLICY IF EXISTS "Allow RBAC channels update" ON public.channels;
CREATE POLICY "Allow RBAC channels update"
ON public.channels
FOR UPDATE
TO anon, authenticated
USING (
  public.rbac_check_permission_request(
    public.rbac_perm_channel_update_settings(),
    owner_org,
    app_id,
    id
  )
)
WITH CHECK (
  public.rbac_check_permission_request(
    public.rbac_perm_channel_update_settings(),
    owner_org,
    app_id,
    id
  )
  AND (
    "public" IS FALSE
    OR public.rbac_check_permission_request(
      public.rbac_perm_app_update_settings(),
      owner_org,
      app_id,
      NULL::bigint
    )
  )
);
