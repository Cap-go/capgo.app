-- manifest_trash_restore_pending is backend-only bookkeeping for manifest
-- cleanup: PostgREST roles must not read or write it.
BEGIN;

SELECT plan(6);

SELECT has_table('public', 'manifest_trash_restore_pending', 'pending restore table exists');

SELECT
    ok(
        (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.manifest_trash_restore_pending'::regclass),
        'RLS is enabled'
    );

SELECT
    ok(
        NOT has_table_privilege('anon', 'public.manifest_trash_restore_pending', 'SELECT, INSERT, UPDATE, DELETE'),
        'anon has no table privileges'
    );

SELECT
    ok(
        NOT has_table_privilege('authenticated', 'public.manifest_trash_restore_pending', 'SELECT, INSERT, UPDATE, DELETE'),
        'authenticated has no table privileges'
    );

-- Two versions can each keep a pending restore for the same object.
INSERT INTO public.manifest_trash_restore_pending (s3_path, app_version_id)
SELECT 'orgs/test/apps/test/delta/shared.js', id
FROM (SELECT id FROM public.app_versions ORDER BY id LIMIT 2) AS versions;

SELECT
    is(
        (SELECT count(*)::int FROM public.manifest_trash_restore_pending WHERE s3_path = 'orgs/test/apps/test/delta/shared.js'),
        2,
        'pending restores are keyed per version'
    );

DELETE FROM public.app_versions
WHERE id = (SELECT min(app_version_id) FROM public.manifest_trash_restore_pending);

SELECT
    is(
        (SELECT count(*)::int FROM public.manifest_trash_restore_pending WHERE s3_path = 'orgs/test/apps/test/delta/shared.js'),
        1,
        'pending restores are removed with their version'
    );

SELECT * FROM finish();

ROLLBACK;
