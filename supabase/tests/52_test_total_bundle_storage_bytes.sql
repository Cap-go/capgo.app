BEGIN;

SELECT plan(1);

CREATE OR REPLACE FUNCTION my_tests() RETURNS SETOF TEXT AS $$
DECLARE
  test_app_id text := 'com.test.total-bundle-storage';
  test_owner_org uuid;
  active_version_id bigint;
  deleted_version_id bigint;
  before_bytes bigint;
BEGIN
  SELECT owner_org
  INTO test_owner_org
  FROM public.apps
  LIMIT 1;

  before_bytes := public.total_bundle_storage_bytes();

  INSERT INTO public.apps (app_id, name, icon_url, owner_org)
  VALUES (test_app_id, 'Total bundle storage test', 'https://example.com/icon.png', test_owner_org);

  INSERT INTO public.app_versions (app_id, name, storage_provider, owner_org, deleted)
  VALUES (test_app_id, '1.0.0-active', 'r2', test_owner_org, false)
  RETURNING id INTO active_version_id;

  INSERT INTO public.app_versions (app_id, name, storage_provider, owner_org, deleted, deleted_at)
  VALUES (test_app_id, '1.0.0-deleted', 'r2', test_owner_org, true, now())
  RETURNING id INTO deleted_version_id;

  INSERT INTO public.app_versions_meta (app_id, checksum, size, id, owner_org)
  VALUES
    (test_app_id, 'active-checksum', 100, active_version_id, test_owner_org),
    (test_app_id, 'deleted-checksum', 1000, deleted_version_id, test_owner_org);

  INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
  VALUES
    (active_version_id, 'active.js', 'orgs/test/active.js', 'active-hash', 200),
    (deleted_version_id, 'deleted.js', 'orgs/test/deleted.js', 'deleted-hash', 2000);

  RETURN NEXT IS(
    public.total_bundle_storage_bytes(),
    before_bytes + 100,
    'total_bundle_storage_bytes should count active version metadata bytes and ignore manifest bytes'
  );
END;
$$ LANGUAGE plpgsql;

SELECT my_tests();

SELECT *
FROM finish();

ROLLBACK;
