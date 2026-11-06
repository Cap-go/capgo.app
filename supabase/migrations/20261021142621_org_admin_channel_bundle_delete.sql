-- org_admin can create/promote channels but previously could not delete them
-- (or delete bundles). That asymmetry breaks Admin API keys used for CI
-- preview cleanup (`channel delete --delete-bundle`). Grant the matching
-- destructive channel/bundle permissions while still withholding org/app
-- deletion and billing updates for Super Admin only.

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key IN (
  public.rbac_perm_channel_delete(),
  public.rbac_perm_bundle_delete()
)
WHERE r.name = public.rbac_role_org_admin()
ON CONFLICT DO NOTHING;
