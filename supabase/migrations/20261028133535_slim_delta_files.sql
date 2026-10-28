-- Slim delta_files: about 70% of a row was two hex strings. s3_path repeats
-- the org, the app id, an upload session (hex, up to ~470 characters) and the
-- file name; file_hash is hex text (64 or ~512 characters). A row in the
-- usual shape stores the path as parts and the hash as bytes:
--
--   s3_path = 'orgs/<path_org>/apps/<app_id>/delta/[<path_session hex>/]<path_sha hex>_<file_name>'
--   file_hash = encode(file_hash_bin, 'hex')
--
-- Compacted rows keep '' in s3_path / file_hash (the columns stay NOT NULL, so
-- the read replica schema needs no nullability change). Any other shape
-- (legacy 'orgs/<org>/apps/<app>/<version>/<file>' paths, demo/ paths,
-- base64 or upper-case hashes) keeps its text. A row is only compacted when
-- the rebuilt value equals the stored one.
--
-- Rollout: this migration only adds the columns, the readers and a compaction
-- task that does nothing until CAPGO_DELTA_FILES_COMPACT_ENABLED is set, after
-- every worker reading delta_files runs this release (the previous workers,
-- and their plugin reads on the replicas, read s3_path / file_hash directly).
-- Writers keep inserting text; the task compacts rows older than 10 minutes.

SET lock_timeout = '5s';

ALTER TABLE public.delta_files
  ADD COLUMN path_org uuid,
  ADD COLUMN path_session bytea,
  ADD COLUMN path_sha bytea,
  ADD COLUMN file_hash_bin bytea;

COMMENT ON COLUMN public.delta_files.s3_path IS
  'Stored path, or '''' when path_sha is set: read it with delta_file_s3_path().';
COMMENT ON COLUMN public.delta_files.file_hash IS
  'Stored hash, or '''' when file_hash_bin is set: read it with delta_file_hash().';

-- Plugin reads run on the replicas, which have no functions: they inline the
-- same expressions (utils/version_manifest_sql.ts).
CREATE FUNCTION public.delta_file_s3_path(
  p_s3_path text,
  p_app_id text,
  p_file_name text,
  p_path_org uuid,
  p_path_session bytea,
  p_path_sha bytea
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_path_sha IS NULL THEN p_s3_path
    ELSE 'orgs/' || p_path_org::text || '/apps/' || p_app_id || '/delta/'
      || COALESCE(pg_catalog.encode(p_path_session, 'hex') || '/', '')
      || pg_catalog.encode(p_path_sha, 'hex') || '_' || p_file_name
  END
$$;
ALTER FUNCTION public.delta_file_s3_path(text, text, text, uuid, bytea, bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_file_s3_path(text, text, text, uuid, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_file_s3_path(text, text, text, uuid, bytea, bytea) TO anon, authenticated, service_role;

CREATE FUNCTION public.delta_file_hash(p_file_hash text, p_file_hash_bin bytea)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_file_hash_bin IS NULL THEN p_file_hash ELSE pg_catalog.encode(p_file_hash_bin, 'hex') END
$$;
ALTER FUNCTION public.delta_file_hash(text, bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_file_hash(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_file_hash(text, bytea) TO anon, authenticated, service_role;

-- Compacts the next batch of rows, in id order. The cursor lives in
-- backfill_progress; rows younger than 10 minutes wait, so a row committed
-- late with a lower id is not skipped. Returns the number of rows rewritten.
CREATE FUNCTION public.delta_files_compact(p_batch_size integer DEFAULT 2000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cursor bigint;
  v_ids bigint[];
  v_updated integer := 0;
BEGIN
  IF NOT public.delta_storage_setting('CAPGO_DELTA_FILES_COMPACT_ENABLED', false) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.backfill_progress (job_name, scope_key, cutover_at, last_processed_id)
  VALUES ('delta_files_compact', 'all', now(), 0)
  ON CONFLICT (job_name, scope_key) DO NOTHING;

  -- One run at a time.
  SELECT bp.last_processed_id INTO v_cursor
  FROM public.backfill_progress AS bp
  WHERE bp.job_name = 'delta_files_compact' AND bp.scope_key = 'all'
  FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT df.id, df.created_at
    FROM public.delta_files AS df
    WHERE df.id > COALESCE(v_cursor, 0)
    ORDER BY df.id
    LIMIT GREATEST(COALESCE(p_batch_size, 2000), 1)
  )
  SELECT pg_catalog.array_agg(c.id ORDER BY c.id) INTO v_ids
  FROM candidates AS c
  WHERE c.id < COALESCE(
    (SELECT pg_catalog.min(young.id) FROM candidates AS young WHERE young.created_at > now() - interval '10 minutes'),
    9223372036854775807
  );
  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;

  WITH prefixed AS (
    SELECT
      df.id,
      df.s3_path,
      df.file_hash,
      df.app_id,
      df.file_name,
      pg_catalog.substr(df.s3_path, 6, 36) AS org_text,
      'orgs/' || pg_catalog.substr(df.s3_path, 6, 36) || '/apps/' || df.app_id || '/delta/' AS prefix
    FROM public.delta_files AS df
    WHERE df.id = ANY (v_ids)
      AND (df.path_sha IS NULL OR df.file_hash_bin IS NULL)
  ),
  -- '<prefix>[<session>/]<sha>_<file_name>': the head before '_<file_name>'
  -- must be an optional hex session and a 64-character hex sha.
  split AS (
    SELECT
      prefixed.*,
      head.m[1] AS session_hex,
      head.m[2] AS sha_hex
    FROM prefixed
    LEFT JOIN LATERAL (
      SELECT pg_catalog.regexp_match(
        pg_catalog.left(rest.value, pg_catalog.length(rest.value) - pg_catalog.length(prefixed.file_name) - 1),
        '^(?:((?:[0-9a-f]{2})+)/)?([0-9a-f]{64})$'
      ) AS m
      FROM (SELECT pg_catalog.substr(prefixed.s3_path, pg_catalog.length(prefixed.prefix) + 1) AS value) AS rest
      WHERE prefixed.org_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND pg_catalog.starts_with(prefixed.s3_path, prefixed.prefix)
        AND pg_catalog.length(rest.value) > pg_catalog.length(prefixed.file_name) + 1
        AND pg_catalog.right(rest.value, pg_catalog.length(prefixed.file_name) + 1) = '_' || prefixed.file_name
    ) AS head ON true
  ),
  compact AS (
    SELECT
      s.id,
      parts.path_org,
      parts.path_session,
      parts.path_sha,
      parts.path_sha IS NOT NULL
        AND public.delta_file_s3_path('', s.app_id, s.file_name, parts.path_org, parts.path_session, parts.path_sha) = s.s3_path
        AS path_ok,
      hash.bin AS file_hash_bin,
      hash.bin IS NOT NULL AND pg_catalog.encode(hash.bin, 'hex') = s.file_hash AS hash_ok
    FROM split AS s
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN s.sha_hex IS NOT NULL THEN s.org_text::uuid END AS path_org,
        CASE WHEN s.sha_hex IS NOT NULL THEN pg_catalog.decode(s.session_hex, 'hex') END AS path_session,
        CASE WHEN s.sha_hex IS NOT NULL THEN pg_catalog.decode(s.sha_hex, 'hex') END AS path_sha
    ) AS parts
    CROSS JOIN LATERAL (
      SELECT CASE WHEN s.file_hash ~ '^(?:[0-9a-f]{2})+$' THEN pg_catalog.decode(s.file_hash, 'hex') END AS bin
    ) AS hash
  )
  UPDATE public.delta_files AS df
  SET
    s3_path = CASE WHEN compact.path_ok THEN '' ELSE df.s3_path END,
    path_org = CASE WHEN compact.path_ok THEN compact.path_org ELSE df.path_org END,
    path_session = CASE WHEN compact.path_ok THEN compact.path_session ELSE df.path_session END,
    path_sha = CASE WHEN compact.path_ok THEN compact.path_sha ELSE df.path_sha END,
    file_hash = CASE WHEN compact.hash_ok THEN '' ELSE df.file_hash END,
    file_hash_bin = CASE WHEN compact.hash_ok THEN compact.file_hash_bin ELSE df.file_hash_bin END
  FROM compact
  WHERE df.id = compact.id
    AND ((compact.path_ok AND df.path_sha IS NULL) OR (compact.hash_ok AND df.file_hash_bin IS NULL));
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  UPDATE public.backfill_progress
  SET last_processed_id = v_ids[pg_catalog.cardinality(v_ids)], updated_at = now()
  WHERE job_name = 'delta_files_compact' AND scope_key = 'all';

  RETURN v_updated;
END;
$$;
ALTER FUNCTION public.delta_files_compact(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_files_compact(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_files_compact(integer) TO service_role;

-- Every 10 seconds: about 12,000 rows a minute once enabled.
INSERT INTO public.cron_tasks (name, description, task_type, target, second_interval, minute_interval, enabled)
VALUES ('delta_files_compact', 'Compact delta_files paths and hashes (CAPGO_DELTA_FILES_COMPACT_ENABLED)', 'function', 'public.delta_files_compact(2000)', 10, NULL, true)
ON CONFLICT (name) DO NOTHING;

-- Readers of the stored columns read the rebuilt values. The views keep their
-- column types (character varying).
CREATE OR REPLACE VIEW public.version_manifest WITH (security_invoker = true) AS
SELECT
  vf.app_version_id,
  entry.ord AS id,
  df.file_name,
  public.delta_file_s3_path(df.s3_path, df.app_id, df.file_name, df.path_org, df.path_session, df.path_sha)::character varying AS s3_path,
  public.delta_file_hash(df.file_hash, df.file_hash_bin)::character varying AS file_hash,
  df.file_size
FROM public.version_files AS vf
CROSS JOIN LATERAL pg_catalog.unnest(vf.file_ids) WITH ORDINALITY AS entry (file_id, ord)
INNER JOIN public.delta_files AS df ON df.id = entry.file_id;

CREATE OR REPLACE VIEW public.manifest WITH (security_invoker = true) AS
SELECT
  df.id,
  vf.app_version_id,
  df.file_name,
  public.delta_file_s3_path(df.s3_path, df.app_id, df.file_name, df.path_org, df.path_session, df.path_sha)::character varying AS s3_path,
  public.delta_file_hash(df.file_hash, df.file_hash_bin)::character varying AS file_hash,
  df.file_size
FROM public.version_files AS vf
CROSS JOIN LATERAL pg_catalog.unnest(vf.file_ids) WITH ORDINALITY AS entry (file_id, ord)
INNER JOIN public.delta_files AS df ON df.id = entry.file_id;

CREATE OR REPLACE FUNCTION public.delta_version_has_entry(p_version_id bigint, p_s3_path text, p_file_hash text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.delta_files AS df
    INNER JOIN public.version_files AS vf
      ON vf.app_version_id = p_version_id
     AND vf.file_ids @> ARRAY[df.id]
    WHERE df.path_key = public.delta_path_key(p_s3_path)
      AND public.delta_file_s3_path(df.s3_path, df.app_id, df.file_name, df.path_org, df.path_session, df.path_sha) = p_s3_path
      AND public.delta_file_hash(df.file_hash, df.file_hash_bin) = p_file_hash
  )
$$;

CREATE OR REPLACE FUNCTION public.delta_gc_claim(p_limit integer DEFAULT 5)
RETURNS TABLE (app_id character varying, list_org text, list_cursor text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.delta_storage_gc_enabled() THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT s.app_id
    FROM public.delta_gc_state AS s
    WHERE s.next_run_at <= now()
    ORDER BY s.next_run_at
    LIMIT GREATEST(COALESCE(p_limit, 5), 1)
    FOR UPDATE SKIP LOCKED
  ),
  checked AS MATERIALIZED (
    SELECT due.app_id, public.delta_app_has_unconverted_references(due.app_id) AS has_legacy_rows
    FROM due
  ),
  -- Organizations to list, computed once at the start of each pass.
  pass_orgs AS MATERIALIZED (
    SELECT checked.app_id, ARRAY(
      SELECT org FROM (
        SELECT apps.owner_org::text AS org
        FROM public.apps WHERE apps.app_id = checked.app_id
        UNION
        SELECT pg_catalog.unnest(s.known_orgs)
        UNION
        SELECT pg_catalog.split_part(df.s3_path, '/', 2)
        FROM public.delta_files AS df
        WHERE df.app_id = checked.app_id AND df.s3_path LIKE 'orgs/%'
        UNION
        SELECT df.path_org::text
        FROM public.delta_files AS df
        WHERE df.app_id = checked.app_id AND df.path_org IS NOT NULL
      ) AS orgs
      WHERE org <> ''
      ORDER BY org
    ) AS orgs
    FROM checked
    INNER JOIN public.delta_gc_state AS s ON s.app_id = checked.app_id
    WHERE NOT checked.has_legacy_rows AND s.list_org IS NULL
  ),
  claimed AS (
    UPDATE public.delta_gc_state AS s
    -- A crashed run is retried after 15 minutes; legacy apps wait for the converter.
    SET next_run_at = now() + CASE WHEN checked.has_legacy_rows THEN interval '1 day' ELSE interval '15 minutes' END,
        list_org = CASE WHEN pass_orgs.app_id IS NULL THEN s.list_org ELSE pass_orgs.orgs[1] END,
        pending_orgs = CASE WHEN pass_orgs.app_id IS NULL THEN s.pending_orgs ELSE pass_orgs.orgs[2:] END,
        known_orgs = CASE WHEN pass_orgs.app_id IS NULL THEN s.known_orgs ELSE pass_orgs.orgs END
    FROM checked
    LEFT JOIN pass_orgs ON pass_orgs.app_id = checked.app_id
    WHERE s.app_id = checked.app_id
    RETURNING s.app_id, s.list_org, s.list_cursor, checked.has_legacy_rows
  )
  SELECT claimed.app_id, claimed.list_org, claimed.list_cursor
  FROM claimed
  WHERE NOT claimed.has_legacy_rows AND claimed.list_org IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.delta_gc_record_orphan_prefixes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- The app's delete lease moves to its orphan rows: deleting the app cascades
  -- its delta_gc_state, and an app id recreated before the lease ends must
  -- still wait for deletes GC already authorized under these prefixes.
  INSERT INTO public.delta_gc_orphan_prefixes (prefix, app_id, org, lease_until)
  SELECT DISTINCT 'orgs/' || orgs.org || '/apps/' || OLD.app_id || '/', OLD.app_id, orgs.org,
    (SELECT state.lease_until FROM public.delta_gc_state AS state
     WHERE state.app_id = OLD.app_id AND state.lease_until > pg_catalog.clock_timestamp())
  FROM (
    SELECT pg_catalog.split_part(df.s3_path, '/', 2) AS org
    FROM public.delta_files AS df
    WHERE df.app_id = OLD.app_id AND df.s3_path LIKE 'orgs/%'
    UNION
    SELECT df.path_org::text
    FROM public.delta_files AS df
    WHERE df.app_id = OLD.app_id AND df.path_org IS NOT NULL
    UNION
    SELECT pg_catalog.unnest(state.known_orgs)
    FROM public.delta_gc_state AS state
    WHERE state.app_id = OLD.app_id
    UNION
    -- Inline manifests not moved yet also point at old prefixes.
    SELECT pg_catalog.split_part(entry.s3_path, '/', 2)
    FROM public.app_versions AS av
    CROSS JOIN LATERAL pg_catalog.unnest(av.manifest) AS entry (file_name, s3_path, file_hash)
    WHERE av.app_id = OLD.app_id AND av.manifest IS NOT NULL AND entry.s3_path LIKE 'orgs/%'
  ) AS orgs
  WHERE orgs.org <> '' AND orgs.org <> OLD.owner_org::text
  ON CONFLICT (prefix) DO UPDATE
  SET lease_until = GREATEST(public.delta_gc_orphan_prefixes.lease_until, EXCLUDED.lease_until);
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.delta_restore_version_manifest_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  SELECT pg_catalog.cardinality(vf.file_ids) INTO v_count
  FROM public.version_files AS vf
  WHERE vf.app_version_id = NEW.id;
  IF COALESCE(v_count, 0) > 0 AND COALESCE(NEW.manifest_count, 0) = 0 THEN
    NEW.manifest_count := v_count;
    UPDATE public.apps
    SET manifest_bundle_count = manifest_bundle_count + 1, updated_at = now()
    WHERE app_id = NEW.app_id;
  END IF;
  -- Deleted versions queue no size lookups when converted: a restored one
  -- queues them for its files that are still unsized.
  PERFORM pgmq.send('on_manifest_create', pg_catalog.jsonb_build_object(
    'function_name', 'on_manifest_create',
    'function_type', 'cloudflare',
    'payload', pg_catalog.jsonb_build_object(
      'old_record', NULL,
      'record', pg_catalog.jsonb_build_object('id', df.id, 'app_id', df.app_id,
        's3_path', public.delta_file_s3_path(df.s3_path, df.app_id, df.file_name, df.path_org, df.path_session, df.path_sha),
        'file_size', df.file_size, 'entry_key', pg_catalog.encode(df.entry_key, 'hex')),
      'type', 'INSERT',
      'table', 'delta_files',
      'schema', 'public'
    )
  ))
  FROM public.delta_files AS df
  WHERE df.file_size = 0
    AND df.id IN (
      SELECT pg_catalog.unnest(vf.file_ids)
      FROM public.version_files AS vf
      WHERE vf.app_version_id = NEW.id
    );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.manifest_compat_insert()
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
      'record', pg_catalog.jsonb_build_object('id', df.id, 'app_id', df.app_id,
        's3_path', public.delta_file_s3_path(df.s3_path, df.app_id, df.file_name, df.path_org, df.path_session, df.path_sha),
        'file_size', df.file_size, 'entry_key', pg_catalog.encode(df.entry_key, 'hex')),
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

RESET lock_timeout;
