BEGIN;

SELECT plan(7);

SELECT ok(pg_catalog.to_regclass('public.manifest_size_validated') IS NULL, 'validation table is removed');
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'app_versions_manifest_size_validated_fkey'),
  'reverse validation foreign key is removed'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'on_manifest_create' AND NOT tgisinternal),
  'unconditional manifest trigger is removed'
);
SELECT ok(
  pg_catalog.to_regprocedure('public.create_manifest_size_validation()') IS NULL,
  'validation row trigger function is removed'
);
SELECT is(
  (SELECT c.relkind::text FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.manifest'::regclass),
  'v',
  'manifest is a compatibility view over the delta tables'
);

INSERT INTO public.app_versions (id, app_id, name, owner_org, storage_provider)
SELECT -7400001, app_id, 'pgtap-manifest-size-receipts', owner_org, 'r2'
FROM public.apps
ORDER BY app_id
LIMIT 1;

DELETE FROM pgmq.q_on_manifest_create
WHERE message->'payload'->'record'->>'s3_path' IN ('pgtap-trusted.js', 'pgtap-legacy.js');

INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
VALUES (-7400001, 'trusted.js', 'pgtap-trusted.js', 'trusted', 123);

SELECT is(
  (SELECT count(*)::integer FROM pgmq.q_on_manifest_create WHERE message->'payload'->'record'->>'s3_path' = 'pgtap-trusted.js'),
  0,
  'sized rows written through the view do not queue an R2 lookup'
);

-- Workers of the previous deploy insert unsized rows through the view.
INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
VALUES (-7400001, 'legacy.js', 'pgtap-legacy.js', 'legacy', 0);

SELECT is(
  (SELECT count(*)::integer FROM pgmq.q_on_manifest_create
   WHERE message->'payload'->>'table' = 'delta_files' AND message->'payload'->'record'->>'s3_path' = 'pgtap-legacy.js'),
  1,
  'unsized rows written through the view queue one delta_files lookup'
);

SELECT * FROM finish();
ROLLBACK;
