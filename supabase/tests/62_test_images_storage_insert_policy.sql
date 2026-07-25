BEGIN;

SELECT plan(2);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Allow user or apikey to insert they own folder in images'
      -- Bare name inside FROM apps resolves to apps.name; policy must use objects.name.
      AND with_check NOT LIKE '%foldername((apps.name%'
      AND with_check NOT LIKE '%foldername(("apps"."name"%'
      AND with_check NOT LIKE '%foldername(apps.name%'
      AND with_check LIKE '%foldername%objects.name%'
      AND with_check LIKE '%rbac_perm_org_create_app%'
      AND with_check LIKE '%need_onboarding%'
      AND with_check LIKE '%filename%objects.name%'
      AND with_check LIKE '%''icon''%'
  ),
  'images insert policy uses storage objects.name path and org.create_app for new/pending app icons'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Allow user or apikey to update they own folder in images'
      AND qual LIKE '%need_onboarding%'
      AND with_check LIKE '%need_onboarding%'
      AND qual LIKE '%rbac_perm_org_create_app%'
      AND with_check LIKE '%rbac_perm_org_create_app%'
      AND qual LIKE '%foldername%objects.name%'
      AND with_check LIKE '%foldername%objects.name%'
      AND qual LIKE '%filename%objects.name%'
      AND with_check LIKE '%filename%objects.name%'
      AND qual LIKE '%''icon''%'
      AND with_check LIKE '%''icon''%'
      AND coalesce(qual, '') NOT LIKE '%foldername((apps.name%'
      AND coalesce(with_check, '') NOT LIKE '%foldername((apps.name%'
      AND coalesce(qual, '') NOT LIKE '%foldername(apps.name%'
      AND coalesce(with_check, '') NOT LIKE '%foldername(apps.name%'
  ),
  'images update policy allows org.create_app for missing or pending onboarding app icons'
);

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
