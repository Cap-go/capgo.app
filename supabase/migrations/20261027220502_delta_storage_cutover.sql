-- Delta storage v2, step 3: replace the legacy public.manifest table by a
-- compatibility view. Short: only versions uploaded since the backfill are
-- converted, found through indexes, while the table is locked.

SET lock_timeout = '5s';

BEGIN;

-- Uploads still running on the previous deploy wait here.
LOCK TABLE public.manifest IN ACCESS EXCLUSIVE MODE;

-- Found through app_versions and the manifest app_version_id index: no scan
-- of the legacy table while it is locked.
CREATE TEMP TABLE delta_catch_up ON COMMIT DROP AS
SELECT
  m.id,
  m.app_version_id,
  av.app_id,
  m.s3_path,
  m.file_name,
  m.file_hash,
  COALESCE(m.file_size, 0) AS file_size,
  public.delta_path_key(m.s3_path) AS path_key,
  public.delta_entry_key(m.s3_path, m.file_name, m.file_hash) AS entry_key
FROM public.app_versions AS av
CROSS JOIN LATERAL (
  SELECT legacy.id, legacy.app_version_id, legacy.s3_path, legacy.file_name, legacy.file_hash, legacy.file_size
  FROM public.manifest AS legacy
  WHERE legacy.app_version_id = av.id
) AS m
WHERE NOT EXISTS (SELECT 1 FROM public.version_files AS vf WHERE vf.app_version_id = av.id)
  AND m.s3_path IS NOT NULL AND m.file_name IS NOT NULL AND m.file_hash IS NOT NULL;

INSERT INTO public.delta_files AS df (app_id, s3_path, file_name, file_hash, file_size, path_key, entry_key)
SELECT DISTINCT ON (c.entry_key)
  c.app_id, c.s3_path, c.file_name, c.file_hash, c.file_size, c.path_key, c.entry_key
FROM delta_catch_up AS c
ORDER BY c.entry_key, c.file_size DESC
ON CONFLICT (entry_key) DO UPDATE
SET file_size = EXCLUDED.file_size
WHERE df.file_size = 0 AND EXCLUDED.file_size > 0;

INSERT INTO public.version_files (app_version_id, file_ids)
SELECT c.app_version_id, pg_catalog.array_agg(df.id ORDER BY c.id)
FROM delta_catch_up AS c
INNER JOIN public.delta_files AS df ON df.entry_key = c.entry_key
GROUP BY c.app_version_id
ON CONFLICT (app_version_id) DO NOTHING;

-- Dropping the table also removes it from every publication.
DROP TABLE public.manifest;
DROP FUNCTION IF EXISTS public.queue_legacy_manifest_size_lookup_compat();

-- Compatibility: published CLIs read public.manifest (AI version bump), and
-- workers of the previous deploy still write it until they are replaced.
-- id is the delta_files id.
CREATE VIEW public.manifest WITH (security_invoker = true) AS
SELECT
  df.id,
  vf.app_version_id,
  df.file_name,
  df.s3_path,
  df.file_hash,
  df.file_size
FROM public.version_files AS vf
CROSS JOIN LATERAL pg_catalog.unnest(vf.file_ids) WITH ORDINALITY AS entry (file_id, ord)
INNER JOIN public.delta_files AS df ON df.id = entry.file_id;
ALTER VIEW public.manifest OWNER TO postgres;
-- Default privileges grant everything to the API roles; users only read.
REVOKE ALL ON TABLE public.manifest FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.manifest TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.manifest TO service_role;
COMMENT ON VIEW public.manifest IS
  'Compatibility view over version_files/delta_files for published CLIs and previous workers.';

-- An inserted legacy row becomes a shared delta_files row appended to the
-- version's file list. Definer rights for the pgmq queue; only service_role
-- and postgres may write the view at all.
CREATE FUNCTION public.manifest_compat_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_app_id character varying;
  v_entry_key bytea;
  v_id bigint;
BEGIN
  SELECT av.app_id INTO v_app_id FROM public.app_versions AS av WHERE av.id = NEW.app_version_id;
  IF v_app_id IS NULL OR NEW.s3_path IS NULL OR NEW.file_name IS NULL OR NEW.file_hash IS NULL THEN
    RETURN NULL;
  END IF;
  v_entry_key := public.delta_entry_key(NEW.s3_path, NEW.file_name, NEW.file_hash);
  INSERT INTO public.delta_files AS df (app_id, s3_path, file_name, file_hash, file_size, path_key, entry_key)
  VALUES (v_app_id, NEW.s3_path, NEW.file_name, NEW.file_hash, COALESCE(NEW.file_size, 0), public.delta_path_key(NEW.s3_path), v_entry_key)
  ON CONFLICT (entry_key) DO UPDATE
  SET file_size = EXCLUDED.file_size
  WHERE df.file_size = 0 AND EXCLUDED.file_size > 0
  RETURNING df.id INTO v_id;
  IF v_id IS NULL THEN
    SELECT df.id INTO v_id FROM public.delta_files AS df WHERE df.entry_key = v_entry_key;
  END IF;
  INSERT INTO public.version_files AS vf (app_version_id, file_ids)
  VALUES (NEW.app_version_id, ARRAY[v_id])
  ON CONFLICT (app_version_id) DO UPDATE SET file_ids = vf.file_ids || EXCLUDED.file_ids;
  -- The previous workers queue lookups for legacy ids, which are skipped now.
  -- Delayed so the replacing workers, which know delta_files, process it.
  PERFORM pgmq.send('on_manifest_create', pg_catalog.jsonb_build_object(
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
  WHERE df.id = v_id AND df.file_size = 0;
  NEW.id := v_id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.manifest_compat_insert() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.manifest_compat_insert() FROM PUBLIC;

-- Size updates through the view are ignored: a lookup queued before the
-- cutover carries a legacy manifest id, which may now match an unrelated
-- delta_files id. Sizes come from delta_files lookups (see the insert trigger).
CREATE FUNCTION public.manifest_compat_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.manifest_compat_update() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.manifest_compat_update() FROM PUBLIC;

-- Legacy cleanup deletes are ignored: deleted versions keep their files for
-- 7 days and delta storage GC reclaims them.
CREATE FUNCTION public.manifest_compat_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.manifest_compat_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.manifest_compat_delete() FROM PUBLIC;

CREATE TRIGGER manifest_compat_insert INSTEAD OF INSERT ON public.manifest
FOR EACH ROW EXECUTE FUNCTION public.manifest_compat_insert();
CREATE TRIGGER manifest_compat_update INSTEAD OF UPDATE ON public.manifest
FOR EACH ROW EXECUTE FUNCTION public.manifest_compat_update();
CREATE TRIGGER manifest_compat_delete INSTEAD OF DELETE ON public.manifest
FOR EACH ROW EXECUTE FUNCTION public.manifest_compat_delete();


COMMIT;

RESET lock_timeout;
