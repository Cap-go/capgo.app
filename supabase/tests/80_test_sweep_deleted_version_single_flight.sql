-- sweep_deleted_version_manifests re-queues unfinished deletes once: it skips
-- versions under a cleanup lease or touched recently, picks up unfinished
-- bundle cleanup from the last 30 days, and no longer inflates manifest_count.
BEGIN;

SELECT plan(8);

CREATE TEMP TABLE sweep_case ON COMMIT DROP AS
SELECT
    id,
    (ARRAY['rows', 'leased', 'recent_touch', 'size_recent', 'size_old'])[row_number() OVER (ORDER BY id)] AS kind
FROM (
    SELECT id FROM public.app_versions WHERE deleted = false ORDER BY id LIMIT 5
) AS versions;

-- Keep the explicit updated_at values below.
ALTER TABLE public.app_versions DISABLE TRIGGER handle_updated_at;

UPDATE public.app_versions AS av
SET deleted = true,
    manifest_count = 0,
    deleted_at = CASE WHEN c.kind = 'size_old' THEN now() - interval '90 days' ELSE now() - interval '2 days' END,
    updated_at = CASE WHEN c.kind = 'recent_touch' THEN now() - interval '5 minutes' ELSE now() - interval '2 hours' END
FROM sweep_case AS c
WHERE av.id = c.id;

SELECT pg_catalog.set_config('capgo.manifest_queue_managed', 'on', true);

INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
SELECT c.id, 'sweep.js', 'orgs/test/apps/test/delta/sweep-' || c.id || '.js', 'sweep-hash-' || c.id, 1
FROM sweep_case AS c
WHERE c.kind IN ('rows', 'leased', 'recent_touch');

DELETE FROM public.app_versions_meta WHERE id IN (SELECT id FROM sweep_case);
INSERT INTO public.app_versions_meta (id, app_id, owner_org, checksum, size)
SELECT av.id, av.app_id, av.owner_org, 'sweep', CASE WHEN c.kind LIKE 'size_%' THEN 1024 ELSE 0 END
FROM sweep_case AS c
JOIN public.app_versions AS av ON av.id = c.id;

INSERT INTO public.version_cleanup_leases (app_version_id, owner, lease_until)
SELECT id, gen_random_uuid(), now() + interval '5 minutes'
FROM sweep_case
WHERE kind = 'leased';

SELECT ok(public.sweep_deleted_version_manifests(1000) >= 2, 'sweeper re-queues unfinished deletes');

SELECT is(
    (SELECT av.updated_at FROM public.app_versions AS av JOIN sweep_case AS c USING (id) WHERE c.kind = 'rows'),
    now(),
    'version with leftover manifest rows is touched'
);

SELECT is(
    (SELECT av.manifest_count FROM public.app_versions AS av JOIN sweep_case AS c USING (id) WHERE c.kind = 'rows'),
    0,
    'touch does not inflate manifest_count'
);

SELECT isnt(
    (SELECT av.updated_at FROM public.app_versions AS av JOIN sweep_case AS c USING (id) WHERE c.kind = 'leased'),
    now(),
    'version under an active cleanup lease is skipped'
);

SELECT isnt(
    (SELECT av.updated_at FROM public.app_versions AS av JOIN sweep_case AS c USING (id) WHERE c.kind = 'recent_touch'),
    now(),
    'version touched in the last 30 minutes is skipped'
);

SELECT is(
    (SELECT av.updated_at FROM public.app_versions AS av JOIN sweep_case AS c USING (id) WHERE c.kind = 'size_recent'),
    now(),
    'recent delete with an uncleared bundle size is touched'
);

SELECT isnt(
    (SELECT av.updated_at FROM public.app_versions AS av JOIN sweep_case AS c USING (id) WHERE c.kind = 'size_old'),
    now(),
    'unfinished delete older than 30 days is left for a reviewed repair'
);

SELECT ok(
    NOT has_table_privilege('authenticated', 'public.version_cleanup_leases', 'SELECT, INSERT, UPDATE, DELETE'),
    'cleanup leases are not reachable through PostgREST roles'
);

ALTER TABLE public.app_versions ENABLE TRIGGER handle_updated_at;

SELECT * FROM finish();

ROLLBACK;
