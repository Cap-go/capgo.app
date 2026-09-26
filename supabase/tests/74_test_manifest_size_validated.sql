BEGIN;

SELECT plan(8);

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
SELECT ok(
  EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'on_manifest_create_compat' AND NOT tgisinternal),
  'rollout compatibility trigger exists'
);

INSERT INTO public.app_versions (id, app_id, name, owner_org, storage_provider)
SELECT -7400001, app_id, 'pgtap-manifest-size-receipts', owner_org, 'r2'
FROM public.apps
ORDER BY app_id
LIMIT 1;

DELETE FROM pgmq.q_on_manifest_create
WHERE message->'payload'->'record'->>'app_version_id' = '-7400001';

INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
VALUES (-7400001, 'trusted.js', 'trusted.js', 'trusted', 123);

SELECT is(
  (SELECT count(*)::integer FROM pgmq.q_on_manifest_create WHERE message->'payload'->'record'->>'app_version_id' = '-7400001'),
  0,
  'receipt-sized rows do not queue an R2 lookup'
);

INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
VALUES (-7400001, 'legacy.js', 'legacy.js', 'legacy', 0);

SELECT is(
  (SELECT count(*)::integer FROM pgmq.q_on_manifest_create WHERE message->'payload'->'record'->>'app_version_id' = '-7400001'),
  1,
  'old Worker rows still queue during rollout'
);

SELECT pg_catalog.set_config('capgo.manifest_queue_managed', 'on', true);
INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
VALUES (-7400001, 'managed.js', 'managed.js', 'managed', 0);

SELECT is(
  (SELECT count(*)::integer FROM pgmq.q_on_manifest_create WHERE message->'payload'->'record'->>'app_version_id' = '-7400001'),
  1,
  'new Worker transactions own legacy queue scheduling'
);

SELECT * FROM finish();
ROLLBACK;
