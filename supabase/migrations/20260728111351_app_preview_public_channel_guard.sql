-- A public/default channel changes app delivery settings. App-preview keys may
-- bootstrap private channels, but must not make a newly created channel public.
-- Keep this in INSERT RLS because `channel add --default` writes the table
-- directly; the channel endpoint performs the matching guard for its raw SQL
-- create-and-promote transaction.
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
