-- Delta storage v2, step 5: validate the foreign keys and queue size lookups.
-- Nothing here blocks writes to apps or app_versions: validation only takes
-- SHARE UPDATE EXCLUSIVE on the new tables and ROW SHARE on their parents.

SET statement_timeout = 0;

-- Apps or versions deleted while the backfill ran left copied rows without a
-- parent (the keys did not exist yet).
DELETE FROM public.version_files AS vf
WHERE NOT EXISTS (SELECT 1 FROM public.app_versions AS av WHERE av.id = vf.app_version_id);
DELETE FROM public.delta_files AS df
WHERE NOT EXISTS (SELECT 1 FROM public.apps AS a WHERE a.app_id = df.app_id);

ALTER TABLE public.delta_files VALIDATE CONSTRAINT delta_files_app_id_fkey;
ALTER TABLE public.version_files VALIDATE CONSTRAINT version_files_app_version_id_fkey;

-- Unsized files of live versions: their pending lookups targeted legacy ids.
-- Delayed so the replacing workers, which know delta_files, process them.
SELECT pgmq.send('on_manifest_create', pg_catalog.jsonb_build_object(
  'function_name', 'on_manifest_create',
  'function_type', 'cloudflare',
  'payload', pg_catalog.jsonb_build_object(
    'old_record', NULL,
    'record', pg_catalog.jsonb_build_object('id', df.id, 'app_id', df.app_id, 's3_path', df.s3_path, 'file_size', df.file_size, 'entry_key', pg_catalog.encode(df.entry_key, 'hex')),
    'type', 'INSERT',
    'table', 'delta_files',
    'schema', 'public'
  )
), 1800)
FROM public.delta_files AS df
WHERE df.file_size = 0
  AND EXISTS (
    SELECT 1
    FROM public.version_files AS vf
    INNER JOIN public.app_versions AS av ON av.id = vf.app_version_id
    WHERE vf.file_ids @> ARRAY[df.id] AND NOT av.deleted
  );

RESET statement_timeout;
