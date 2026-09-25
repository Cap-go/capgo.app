BEGIN;

SELECT plan(12);

SELECT ok(
  pg_catalog.to_regclass('public.manifest_size_validated') IS NOT NULL,
  'manifest_size_validated exists'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.manifest_size_validated'::regclass),
  'manifest_size_validated has RLS enabled'
);
SELECT policies_are(
  'public',
  'manifest_size_validated',
  ARRAY['Deny client access to manifest size validation']
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.app_versions av
    LEFT JOIN public.manifest_size_validated msv ON msv.id = av.id
    WHERE msv.id IS NULL
  ),
  'every existing app version has validation state'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.manifest_size_validated WHERE validated
  ),
  'backfilled validation state is false'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_publication_tables
    WHERE schemaname = 'public'
      AND tablename = 'manifest_size_validated'
  ),
  'validation state is not logically replicated'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.manifest_size_validated', 'INSERT,UPDATE,DELETE'),
  'anon cannot write validation state'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.manifest_size_validated', 'INSERT,UPDATE,DELETE'),
  'authenticated users cannot write validation state'
);

SELECT ok(
  has_table_privilege('service_role', 'public.manifest_size_validated', 'SELECT,INSERT,UPDATE,DELETE'),
  'service role can manage validation state'
);

INSERT INTO public.app_versions (id, app_id, name, owner_org, storage_provider)
SELECT -7400001, app_id, 'pgtap-manifest-size-validation', owner_org, 'r2'
FROM public.apps
ORDER BY app_id
LIMIT 1;

SELECT is(
  (SELECT validated FROM public.manifest_size_validated WHERE id = -7400001),
  false,
  'new app versions automatically receive false validation state'
);

SET CONSTRAINTS app_versions_manifest_size_validated_fkey IMMEDIATE;

SELECT throws_ok(
  $$DELETE FROM public.manifest_size_validated WHERE id = -7400001$$,
  '23503',
  'update or delete on table "manifest_size_validated" violates foreign key constraint "app_versions_manifest_size_validated_fkey" on table "app_versions"',
  'validation state cannot be removed while its app version exists'
);

SET CONSTRAINTS app_versions_manifest_size_validated_fkey DEFERRED;
DELETE FROM public.app_versions WHERE id = -7400001;

SELECT is(
  (SELECT count(*)::integer FROM public.manifest_size_validated WHERE id = -7400001),
  0,
  'deleting an app version cascades its validation state'
);

SELECT * FROM finish();
ROLLBACK;
