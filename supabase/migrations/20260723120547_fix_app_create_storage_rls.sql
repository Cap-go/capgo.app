-- Fix images bucket INSERT/UPDATE policies left behind during RBAC consolidation.
-- Bare `name` inside EXISTS (SELECT ... FROM public.apps ...) resolves to
-- apps.name (display name), not storage.objects.name (object path). Always
-- qualify as objects.name in those subqueries.
--
-- Allow org.create_app for icon INSERT/UPDATE when the target app is missing or
-- still pending onboarding, so upsert:true during app add/init does not fail
-- RLS for keys that can create apps but lack app.update_settings.

DROP POLICY IF EXISTS "Allow user or apikey to insert they own folder in images" ON storage.objects;
CREATE POLICY "Allow user or apikey to insert they own folder in images"
ON storage.objects
FOR INSERT
TO anon, authenticated
WITH CHECK (
  bucket_id = 'images'
  AND (
    (
      (storage.foldername(objects.name))[1] = 'org'
      AND (storage.foldername(objects.name))[3] IS NOT NULL
      AND (storage.foldername(objects.name))[3] <> 'logo'
      AND (
        public.rbac_check_permission_request(
          public.rbac_perm_app_update_settings(),
          ((storage.foldername(objects.name))[2])::uuid,
          ((storage.foldername(objects.name))[3])::character varying,
          NULL::bigint
        )
        OR (
          -- create-only keys may upsert the onboarding icon only
          -- (org/{org_id}/{app_id}/icon), not arbitrary image assets
          storage.filename(objects.name) = 'icon'
          AND public.rbac_check_permission_request(
            public.rbac_perm_org_create_app(),
            ((storage.foldername(objects.name))[2])::uuid,
            NULL::character varying,
            NULL::bigint
          )
          AND (
            NOT EXISTS (
              SELECT 1
              FROM public.apps
              WHERE apps.owner_org = ((storage.foldername(objects.name))[2])::uuid
                AND apps.app_id = ((storage.foldername(objects.name))[3])::character varying
            )
            OR EXISTS (
              SELECT 1
              FROM public.apps
              WHERE apps.owner_org = ((storage.foldername(objects.name))[2])::uuid
                AND apps.app_id = ((storage.foldername(objects.name))[3])::character varying
                AND apps.need_onboarding IS TRUE
            )
          )
        )
      )
    )
    OR (
      (storage.foldername(objects.name))[1] = 'org'
      AND (storage.foldername(objects.name))[3] = 'logo'
      AND public.rbac_check_permission_request(
        public.rbac_perm_org_update_settings(),
        ((storage.foldername(objects.name))[2])::uuid,
        NULL::character varying,
        NULL::bigint
      )
    )
    OR (
      (SELECT auth.uid())::text = (storage.foldername(objects.name))[1]
    )
  )
);

DROP POLICY IF EXISTS "Allow user or apikey to update they own folder in images" ON storage.objects;
CREATE POLICY "Allow user or apikey to update they own folder in images"
ON storage.objects
FOR UPDATE
TO anon, authenticated
USING (
  bucket_id = 'images'
  AND (
    (
      (storage.foldername(objects.name))[1] = 'org'
      AND (storage.foldername(objects.name))[3] IS NOT NULL
      AND (storage.foldername(objects.name))[3] <> 'logo'
      AND (
        public.rbac_check_permission_request(
          public.rbac_perm_app_update_settings(),
          ((storage.foldername(objects.name))[2])::uuid,
          ((storage.foldername(objects.name))[3])::character varying,
          NULL::bigint
        )
        OR (
          storage.filename(objects.name) = 'icon'
          AND public.rbac_check_permission_request(
            public.rbac_perm_org_create_app(),
            ((storage.foldername(objects.name))[2])::uuid,
            NULL::character varying,
            NULL::bigint
          )
          AND (
            NOT EXISTS (
              SELECT 1
              FROM public.apps
              WHERE apps.owner_org = ((storage.foldername(objects.name))[2])::uuid
                AND apps.app_id = ((storage.foldername(objects.name))[3])::character varying
            )
            OR EXISTS (
              SELECT 1
              FROM public.apps
              WHERE apps.owner_org = ((storage.foldername(objects.name))[2])::uuid
                AND apps.app_id = ((storage.foldername(objects.name))[3])::character varying
                AND apps.need_onboarding IS TRUE
            )
          )
        )
      )
    )
    OR (
      (storage.foldername(objects.name))[1] = 'org'
      AND (storage.foldername(objects.name))[3] = 'logo'
      AND public.rbac_check_permission_request(
        public.rbac_perm_org_update_settings(),
        ((storage.foldername(objects.name))[2])::uuid,
        NULL::character varying,
        NULL::bigint
      )
    )
    OR (
      (SELECT auth.uid())::text = (storage.foldername(objects.name))[1]
    )
  )
)
WITH CHECK (
  bucket_id = 'images'
  AND (
    (
      (storage.foldername(objects.name))[1] = 'org'
      AND (storage.foldername(objects.name))[3] IS NOT NULL
      AND (storage.foldername(objects.name))[3] <> 'logo'
      AND (
        public.rbac_check_permission_request(
          public.rbac_perm_app_update_settings(),
          ((storage.foldername(objects.name))[2])::uuid,
          ((storage.foldername(objects.name))[3])::character varying,
          NULL::bigint
        )
        OR (
          storage.filename(objects.name) = 'icon'
          AND public.rbac_check_permission_request(
            public.rbac_perm_org_create_app(),
            ((storage.foldername(objects.name))[2])::uuid,
            NULL::character varying,
            NULL::bigint
          )
          AND (
            NOT EXISTS (
              SELECT 1
              FROM public.apps
              WHERE apps.owner_org = ((storage.foldername(objects.name))[2])::uuid
                AND apps.app_id = ((storage.foldername(objects.name))[3])::character varying
            )
            OR EXISTS (
              SELECT 1
              FROM public.apps
              WHERE apps.owner_org = ((storage.foldername(objects.name))[2])::uuid
                AND apps.app_id = ((storage.foldername(objects.name))[3])::character varying
                AND apps.need_onboarding IS TRUE
            )
          )
        )
      )
    )
    OR (
      (storage.foldername(objects.name))[1] = 'org'
      AND (storage.foldername(objects.name))[3] = 'logo'
      AND public.rbac_check_permission_request(
        public.rbac_perm_org_update_settings(),
        ((storage.foldername(objects.name))[2])::uuid,
        NULL::character varying,
        NULL::bigint
      )
    )
    OR (
      (SELECT auth.uid())::text = (storage.foldername(objects.name))[1]
    )
  )
);
