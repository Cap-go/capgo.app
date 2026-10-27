-- Delta storage v2: one row per unique delta file, one row per version.
--
-- Before: public.manifest stored one row per file per version (about 14 GB,
-- REPLICA IDENTITY FULL, four indexes, replicated to Google EU2 and every
-- regional standby). Every upload re-inserted every unchanged file.
--
-- After:
--   delta_files    one row per unique (s3_path, file_name, file_hash) entry.
--   version_files  one row per version: the ordered array of delta_files ids.
--
-- R2 objects are deleted by delta storage GC (triggers/cron_delta_storage_gc):
-- it lists an app's delta prefix, copies unreferenced objects to the
-- deleted-after-7-days/ trash prefix (purged by the R2 lifecycle rule) and
-- deletes them only inside a short per-app lease. Versions deleted less than
-- 7 days ago keep their files, so a deleted version can be restored by
-- clearing its deleted flag.
--
-- Concurrency contract (all CLI generations create the app_versions row
-- before any file existence check or upload):
--   * GC never deletes while the app has an in-progress (r2-direct) version.
--   * delta_gc_begin_delete takes an exclusive per-app transaction advisory
--     lock; the app_versions BEFORE INSERT trigger takes the shared one, then
--     waits out an active lease. An upload therefore either makes GC skip the
--     app or starts after the delete batch finished.
--
-- Step 2 (step 1, delta_storage_backfill, created the tables and copied
-- every legacy row): policies, GC, triggers and functions. Step 3
-- (delta_storage_cutover) replaces the public.manifest table by a
-- compatibility view; steps 4-5 add and validate the foreign keys. Each step
-- is its own short transaction, so no slow work runs while app_versions or
-- apps are locked.
--
-- Vault switch (absent or unreadable -> safe default):
--   CAPGO_DELTA_STORAGE_GC_ENABLED (default false): enables R2 delta object GC.

-- The new triggers on app_versions and apps wait for running writes: fail the
-- release fast instead of queueing bundle traffic behind a long transaction.
-- Session-level so it applies whether or not migrations run in a transaction.
SET lock_timeout = '5s';

-- One explicit transaction: the cutover below locks public.manifest.
BEGIN;

-- Retire the PlanetScale replication of the old R2 inventory. Its worker
-- deletes delta objects that have no public.manifest row and only runs while
-- this publication and slot are healthy, so dropping both stops it before any
-- legacy row is converted. The slot is dropped too: once its subscriber is
-- gone, a leftover slot would keep WAL on the primary forever.
-- The walsender runs as this role; it is terminated so the slot is free. The
-- PlanetScale subscriber only retries and fails until it is decommissioned.
DO $do$
DECLARE
  v_pid integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'capgo_planetscale_r2_pub') THEN
    DROP PUBLICATION capgo_planetscale_r2_pub;
  END IF;

  FOR i IN 1..50 LOOP
    SELECT active_pid INTO v_pid
    FROM pg_catalog.pg_replication_slots
    WHERE slot_name = 'capgo_planetscale_r2_slot';
    EXIT WHEN NOT FOUND;
    IF v_pid IS NOT NULL THEN
      PERFORM pg_catalog.pg_terminate_backend(v_pid, 5000);
    END IF;
    BEGIN
      PERFORM pg_catalog.pg_drop_replication_slot('capgo_planetscale_r2_slot');
    EXCEPTION WHEN object_in_use THEN
      -- The subscriber reconnected first; terminate it again.
      PERFORM pg_catalog.pg_sleep(0.1);
    END;
  END LOOP;

  -- Fail the release rather than leave a slot that retains WAL.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_replication_slots WHERE slot_name = 'capgo_planetscale_r2_slot') THEN
    RAISE EXCEPTION 'could not drop replication slot capgo_planetscale_r2_slot';
  END IF;
END;
$do$;

CREATE FUNCTION public.delta_storage_setting(p_name text, p_default boolean)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_setting text;
BEGIN
  SELECT pg_catalog.lower(pg_catalog.btrim(decrypted_secret))
  INTO v_setting
  FROM vault.decrypted_secrets
  WHERE name = p_name
  LIMIT 1;

  IF v_setting IN ('true', 'on', '1') THEN
    RETURN true;
  ELSIF v_setting IN ('false', 'off', '0') THEN
    RETURN false;
  END IF;
  RETURN p_default;
EXCEPTION WHEN OTHERS THEN
  RETURN p_default;
END;
$$;
ALTER FUNCTION public.delta_storage_setting(text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_storage_setting(text, boolean) FROM PUBLIC;

CREATE FUNCTION public.delta_storage_gc_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.delta_storage_setting('CAPGO_DELTA_STORAGE_GC_ENABLED', false)
$$;
ALTER FUNCTION public.delta_storage_gc_enabled() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_storage_gc_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_storage_gc_enabled() TO service_role;

ALTER TABLE public.delta_files OWNER TO postgres;
ALTER TABLE public.version_files OWNER TO postgres;
ALTER TABLE public.delta_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.version_files ENABLE ROW LEVEL SECURITY;

-- The foreign keys are added by delta_storage_keys and validated by
-- delta_storage_validate, outside this transaction's locks.

REVOKE ALL ON TABLE public.delta_files FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.version_files FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.delta_files TO anon, authenticated;
GRANT SELECT ON TABLE public.version_files TO anon, authenticated;
GRANT ALL ON TABLE public.delta_files TO service_role;
GRANT ALL ON TABLE public.version_files TO service_role;

CREATE POLICY "Allow select for auth, api keys (read+)" ON public.version_files
  FOR SELECT TO anon, authenticated
  USING (app_version_id = ANY (COALESCE((SELECT public.readable_app_version_ids()), '{}'::bigint[])));
CREATE POLICY "Allow select for auth, api keys (read+)" ON public.delta_files
  FOR SELECT TO anon, authenticated
  USING (app_id = ANY (COALESCE((SELECT public.app_versions_readable_app_ids()), '{}'::character varying[])));
CREATE POLICY "Prevent users from inserting delta files" ON public.delta_files AS RESTRICTIVE
  FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY "Prevent users from updating delta files" ON public.delta_files AS RESTRICTIVE
  FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "Prevent users from deleting delta files" ON public.delta_files AS RESTRICTIVE
  FOR DELETE TO anon, authenticated USING (false);
CREATE POLICY "Prevent users from inserting version files" ON public.version_files AS RESTRICTIVE
  FOR INSERT TO anon, authenticated WITH CHECK (false);
CREATE POLICY "Prevent users from updating version files" ON public.version_files AS RESTRICTIVE
  FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "Prevent users from deleting version files" ON public.version_files AS RESTRICTIVE
  FOR DELETE TO anon, authenticated USING (false);


-- Console, CLI and download links read one version manifest through RLS.
CREATE VIEW public.version_manifest WITH (security_invoker = true) AS
SELECT
  vf.app_version_id,
  entry.ord AS id,
  df.file_name,
  df.s3_path,
  df.file_hash,
  df.file_size
FROM public.version_files AS vf
CROSS JOIN LATERAL pg_catalog.unnest(vf.file_ids) WITH ORDINALITY AS entry (file_id, ord)
INNER JOIN public.delta_files AS df ON df.id = entry.file_id;
ALTER VIEW public.version_manifest OWNER TO postgres;
REVOKE ALL ON TABLE public.version_manifest FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.version_manifest TO anon, authenticated, service_role;
COMMENT ON VIEW public.version_manifest IS
  'Per-version manifest entries from version_files/delta_files.';

-- Plugin reads run on read replicas: publish the new tables to the Google
-- subscriber. Rows only flow after the subscriber refreshes its subscription.
DO $$
DECLARE
  publication_name text;
  table_name text;
BEGIN
  FOR publication_name IN
    SELECT pubname
    FROM pg_catalog.pg_publication
    WHERE pubname IN ('capgo_google_eu_2_pub', 'capgo_google_replicate')
  LOOP
    FOREACH table_name IN ARRAY ARRAY['delta_files', 'version_files'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_publication_tables
        WHERE pubname = publication_name
          AND schemaname = 'public'
          AND tablename = table_name
      ) THEN
        EXECUTE pg_catalog.format('ALTER PUBLICATION %I ADD TABLE public.%I', publication_name, table_name);
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- Per-app GC schedule and delete lease. Primary only.
CREATE TABLE public.delta_gc_state (
  app_id character varying PRIMARY KEY REFERENCES public.apps (app_id) ON DELETE CASCADE,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  -- Organization prefix being listed. Transferred apps keep files under every
  -- former owner's prefix (transfer_app does not move objects), so one pass
  -- walks the current owner plus each organization found in delta_files.
  list_org text,
  pending_orgs text[],
  -- Every organization prefix seen so far: kept after its delta_files rows
  -- are gone so leftover objects stay reachable.
  known_orgs text[] NOT NULL DEFAULT '{}',
  list_cursor text,
  last_run_at timestamptz,
  last_error text
);
CREATE INDEX delta_gc_state_next_run_at_idx ON public.delta_gc_state (next_run_at);
ALTER TABLE public.delta_gc_state OWNER TO postgres;
ALTER TABLE public.delta_gc_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.delta_gc_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.delta_gc_state TO service_role;
CREATE POLICY "Deny all direct access" ON public.delta_gc_state AS RESTRICTIVE USING (false) WITH CHECK (false);

-- Spread the first pass over existing apps across a week.
INSERT INTO public.delta_gc_state (app_id, next_run_at)
SELECT apps.app_id, now() + (random() * interval '7 days')
FROM public.apps
ON CONFLICT (app_id) DO NOTHING;

CREATE FUNCTION public.delta_gc_lock_key(p_app_id text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.hashtext('delta_gc:' || p_app_id)
$$;
ALTER FUNCTION public.delta_gc_lock_key(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_lock_key(text) FROM PUBLIC;

-- Runs for every CLI generation: the published CLIs upsert app_versions
-- through PostgREST, newer ones through bundle/upsert.
CREATE FUNCTION public.delta_gc_wait_for_lease()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lease_until timestamptz;
BEGIN
  -- Waits while delta_gc_begin_delete decides; then a lease, if any, is visible.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtext('delta_gc'),
    public.delta_gc_lock_key(NEW.app_id)
  );
  SELECT GREATEST(
    (SELECT state.lease_until FROM public.delta_gc_state AS state WHERE state.app_id = NEW.app_id),
    (SELECT pg_catalog.max(o.lease_until) FROM public.delta_gc_orphan_prefixes AS o WHERE o.app_id = NEW.app_id)
  ) INTO v_lease_until;
  IF v_lease_until IS NOT NULL AND v_lease_until > pg_catalog.clock_timestamp() THEN
    -- Leases last at most 2 seconds, well under the 3-second anon statement
    -- timeout that published CLIs hit through PostgREST.
    PERFORM pg_catalog.pg_sleep(LEAST(
      EXTRACT(EPOCH FROM (v_lease_until - pg_catalog.clock_timestamp())),
      2
    ));
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.delta_gc_wait_for_lease() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_wait_for_lease() FROM PUBLIC;

CREATE TRIGGER delta_gc_wait_for_lease
BEFORE INSERT ON public.app_versions
FOR EACH ROW EXECUTE FUNCTION public.delta_gc_wait_for_lease();

-- A resumed upload upserts its existing r2-direct row (an UPDATE) before it
-- checks which files exist: it waits out a delete batch the same way.
CREATE TRIGGER delta_gc_wait_for_lease_on_update
BEFORE UPDATE ON public.app_versions
FOR EACH ROW
WHEN (NEW.storage_provider = 'r2-direct')
EXECUTE FUNCTION public.delta_gc_wait_for_lease();

-- Restoring a deleted version inside the 7-day window: its version_files row
-- and R2 objects are still there; give back the counters /updates and the
-- preview read before loading a manifest.
CREATE FUNCTION public.delta_restore_version_manifest_count()
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
      'record', pg_catalog.jsonb_build_object('id', df.id, 'app_id', df.app_id, 's3_path', df.s3_path, 'file_size', df.file_size, 'entry_key', pg_catalog.encode(df.entry_key, 'hex')),
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
ALTER FUNCTION public.delta_restore_version_manifest_count() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_restore_version_manifest_count() FROM PUBLIC;

CREATE TRIGGER delta_restore_version_manifest_count
BEFORE UPDATE OF deleted ON public.app_versions
FOR EACH ROW
WHEN (OLD.deleted AND NOT NEW.deleted)
EXECUTE FUNCTION public.delta_restore_version_manifest_count();

-- Deleted versions keep their files for 7 days; schedule a pass after that.
CREATE FUNCTION public.delta_gc_schedule_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.delta_gc_state AS state (app_id, next_run_at)
  VALUES (NEW.app_id, now() + interval '7 days 1 hour')
  ON CONFLICT (app_id) DO UPDATE
  SET next_run_at = LEAST(state.next_run_at, EXCLUDED.next_run_at);
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.delta_gc_schedule_after_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_schedule_after_delete() FROM PUBLIC;

-- Row level and gated on the deleted flag: other app_versions updates pay
-- nothing (no transition-table scan).
CREATE TRIGGER delta_gc_schedule_after_delete
AFTER UPDATE OF deleted ON public.app_versions
FOR EACH ROW
WHEN (NEW.deleted AND NOT OLD.deleted)
EXECUTE FUNCTION public.delta_gc_schedule_after_delete();

CREATE FUNCTION public.delta_gc_schedule_new_app()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.delta_gc_state (app_id, next_run_at)
  VALUES (NEW.app_id, now() + interval '7 days')
  ON CONFLICT (app_id) DO NOTHING;
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.delta_gc_schedule_new_app() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_schedule_new_app() FROM PUBLIC;

CREATE TRIGGER delta_gc_schedule_new_app
AFTER INSERT ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.delta_gc_schedule_new_app();

-- A version still owns its files while live, during the 7-day restore window
-- after deletion, and while its upload is in progress.
CREATE FUNCTION public.delta_version_keeps_files(p_deleted boolean, p_deleted_at timestamptz, p_updated_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NOT p_deleted
    OR COALESCE(p_deleted_at, p_updated_at, '-infinity'::timestamptz) > now() - interval '7 days'
$$;
ALTER FUNCTION public.delta_version_keeps_files(boolean, timestamptz, timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_version_keeps_files(boolean, timestamptz, timestamptz) FROM PUBLIC;

CREATE FUNCTION public.delta_app_has_upload_in_progress(p_app_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_versions AS av
    WHERE av.app_id = p_app_id
      AND av.storage_provider = 'r2-direct'
      AND av.deleted = false
      AND GREATEST(av.created_at, av.updated_at) > now() - interval '1 day'
  )
$$;
ALTER FUNCTION public.delta_app_has_upload_in_progress(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_app_has_upload_in_progress(text) FROM PUBLIC;

-- Paths from p_paths that no kept version references.
CREATE FUNCTION public.delta_gc_unreferenced_paths(p_paths text[])
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT p.path), '{}'::text[])
  FROM pg_catalog.unnest(p_paths) AS p (path)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.delta_files AS df
    INNER JOIN public.version_files AS vf ON vf.file_ids @> ARRAY[df.id]
    INNER JOIN public.app_versions AS av ON av.id = vf.app_version_id
    WHERE df.path_key = public.delta_path_key(p.path)
      AND public.delta_version_keeps_files(av.deleted, av.deleted_at, av.updated_at)
  )
$$;
ALTER FUNCTION public.delta_gc_unreferenced_paths(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_unreferenced_paths(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_unreferenced_paths(text[]) TO service_role;

-- References GC cannot see by path: an inline app_versions.manifest of a
-- version that keeps its files and has no version_files row yet (the upload
-- flow moves it into the new tables).
CREATE FUNCTION public.delta_app_has_unconverted_references(p_app_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.app_versions AS av
    WHERE av.app_id = p_app_id
      AND av.manifest IS NOT NULL
      AND public.delta_version_keeps_files(av.deleted, av.deleted_at, av.updated_at)
      AND NOT EXISTS (SELECT 1 FROM public.version_files AS vf WHERE vf.app_version_id = av.id)
  )
$$;
ALTER FUNCTION public.delta_app_has_unconverted_references(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_app_has_unconverted_references(text) FROM PUBLIC;

CREATE FUNCTION public.delta_gc_claim(p_limit integer DEFAULT 5)
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
ALTER FUNCTION public.delta_gc_claim(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_claim(integer) TO service_role;

-- The only step that permits R2 deletes. Returns the paths the caller may
-- delete before the returned lease expires, an empty array, or NULL when an
-- earlier lease is still active (retry the page later).
CREATE FUNCTION public.delta_gc_begin_delete(p_app_id text, p_paths text[], p_lease_ms integer DEFAULT 2000)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_paths text[];
BEGIN
  IF NOT public.delta_storage_gc_enabled() THEN
    RETURN '{}'::text[];
  END IF;

  -- Waits for app_versions inserts already running for this app.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('delta_gc'),
    public.delta_gc_lock_key(p_app_id)
  );

  IF public.delta_app_has_upload_in_progress(p_app_id)
    OR public.delta_app_has_unconverted_references(p_app_id) THEN
    RETURN '{}'::text[];
  END IF;
  -- An earlier batch's lease still covers deletes that may be in flight
  -- (overlapping runs): NULL asks the caller to list the page again later,
  -- so this batch can neither release that lease nor clear its records.
  IF EXISTS (
    SELECT 1 FROM public.delta_gc_state
    WHERE app_id = p_app_id AND lease_until > pg_catalog.clock_timestamp()
  ) THEN
    RETURN NULL;
  END IF;

  v_paths := public.delta_gc_unreferenced_paths(p_paths);
  -- A path with an unsettled earlier delete waits for the repair check
  -- (confirming a new delete would erase that record): retry the page later.
  IF EXISTS (SELECT 1 FROM public.delta_gc_unsettled_deletes AS u WHERE u.path = ANY (v_paths)) THEN
    RETURN NULL;
  END IF;
  IF COALESCE(pg_catalog.array_length(v_paths, 1), 0) = 0 THEN
    RETURN '{}'::text[];
  END IF;
  -- Rows of every spelling of a deleted object go with it (same path_key).
  DELETE FROM public.delta_files AS df
  WHERE df.path_key = ANY (ARRAY(SELECT public.delta_path_key(p) FROM pg_catalog.unnest(v_paths) AS p))
    AND NOT EXISTS (
      SELECT 1
      FROM public.version_files AS vf
      INNER JOIN public.app_versions AS av ON av.id = vf.app_version_id
      WHERE vf.file_ids @> ARRAY[df.id]
        AND public.delta_version_keeps_files(av.deleted, av.deleted_at, av.updated_at)
    );

  -- Delete intent is durable before any request is sent: a path is only
  -- forgotten once R2 confirmed its delete (delta_gc_confirm_deleted), so a
  -- crash or an unanswered request is re-checked (delta_gc_claim_unsettled).
  INSERT INTO public.delta_gc_unsettled_deletes (path, app_id)
  SELECT DISTINCT p.path, p_app_id FROM pg_catalog.unnest(v_paths) AS p (path)
  ON CONFLICT (path) DO UPDATE SET app_id = EXCLUDED.app_id, recorded_at = now(), checks = 0;

  UPDATE public.delta_gc_state
  SET lease_until = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_ms, 2000), 500), 2000) / 1000.0)
  WHERE app_id = p_app_id;

  RETURN v_paths;
END;
$$;
ALTER FUNCTION public.delta_gc_begin_delete(text, text[], integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_begin_delete(text, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_begin_delete(text, text[], integer) TO service_role;

-- Releases the lease once every delete of the batch settled.
CREATE FUNCTION public.delta_gc_end_delete(p_app_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.delta_gc_state SET lease_until = NULL WHERE app_id = p_app_id
$$;
ALTER FUNCTION public.delta_gc_end_delete(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_end_delete(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_end_delete(text) TO service_role;

-- p_page_done = false: the run budget ended inside the page; list it again
-- from p_list_cursor (null = first page) without advancing the pass.
CREATE FUNCTION public.delta_gc_finish(p_app_id text, p_list_cursor text, p_error text DEFAULT NULL, p_page_done boolean DEFAULT true)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.delta_gc_state
  SET list_cursor = CASE WHEN p_error IS NULL THEN p_list_cursor END,
      -- Next page, then next organization prefix; a finished pass rescans
      -- weekly for aborted uploads; an error restarts the pass later.
      list_org = CASE
        WHEN p_error IS NOT NULL THEN NULL
        WHEN NOT p_page_done OR p_list_cursor IS NOT NULL THEN list_org
        ELSE pending_orgs[1]
      END,
      pending_orgs = CASE
        WHEN p_error IS NOT NULL THEN NULL
        WHEN NOT p_page_done OR p_list_cursor IS NOT NULL THEN pending_orgs
        WHEN COALESCE(pg_catalog.cardinality(pending_orgs), 0) > 1 THEN pending_orgs[2:]
        ELSE NULL
      END,
      next_run_at = CASE
        WHEN p_error IS NOT NULL THEN now() + interval '1 hour'
        WHEN NOT p_page_done OR p_list_cursor IS NOT NULL THEN now()
        WHEN COALESCE(pg_catalog.cardinality(pending_orgs), 0) > 0 THEN now()
        ELSE now() + interval '7 days'
      END,
      -- lease_until is left alone: an unconfirmed delete keeps it until it
      -- expires; only delta_gc_end_delete releases it early.
      last_run_at = now(),
      last_error = p_error
  WHERE app_id = p_app_id
$$;
ALTER FUNCTION public.delta_gc_finish(text, text, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_finish(text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_finish(text, text, text, boolean) TO service_role;

-- R2 does not bound when an aborted DELETE completes, so a delete with an
-- unknown outcome may land after the lease, when an upload may already
-- reference the key again. Such paths are recorded; a later GC run restores
-- the object from the trash copy if it is referenced and missing.
CREATE TABLE public.delta_gc_unsettled_deletes (
  path text PRIMARY KEY,
  app_id character varying NOT NULL,
  -- Checks that found the object present; settled after the third
  -- (about 1 minute, 1 hour and 1 day after the delete, inside the 7-day
  -- trash retention), so a very late DELETE is still repaired.
  checks integer NOT NULL DEFAULT 0,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.delta_gc_unsettled_deletes OWNER TO postgres;
ALTER TABLE public.delta_gc_unsettled_deletes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.delta_gc_unsettled_deletes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.delta_gc_unsettled_deletes TO service_role;
CREATE POLICY "Deny all direct access" ON public.delta_gc_unsettled_deletes AS RESTRICTIVE USING (false) WITH CHECK (false);

-- R2 confirmed these deletes: nothing is left to repair.
CREATE FUNCTION public.delta_gc_confirm_deleted(p_paths text[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.delta_gc_unsettled_deletes WHERE path = ANY (p_paths)
$$;
ALTER FUNCTION public.delta_gc_confirm_deleted(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_confirm_deleted(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_confirm_deleted(text[]) TO service_role;

-- Claims settled-enough paths (older than a minute, far past any in-flight
-- request) and says whether a kept version or an in-progress upload of the
-- app may reference them again.
CREATE FUNCTION public.delta_gc_claim_unsettled(p_limit integer DEFAULT 20)
RETURNS TABLE (path text, referenced boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT u.path
    FROM public.delta_gc_unsettled_deletes AS u
    WHERE u.recorded_at < now() - CASE u.checks
      WHEN 0 THEN interval '1 minute'
      WHEN 1 THEN interval '1 hour'
      ELSE interval '1 day'
    END
    ORDER BY u.recorded_at
    LIMIT GREATEST(COALESCE(p_limit, 20), 1)
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    -- Re-checked by a later run if this one does not settle it.
    UPDATE public.delta_gc_unsettled_deletes AS u
    SET recorded_at = now()
    FROM due
    WHERE u.path = due.path
    RETURNING u.path, u.app_id
  )
  -- An in-progress upload may already have skipped re-sending the object
  -- while its version_files row does not exist yet: treat it as referenced.
  -- A kept version's bundle zip at that key counts too.
  SELECT claimed.path,
    public.delta_app_has_upload_in_progress(claimed.app_id)
    OR NOT (claimed.path = ANY (public.delta_gc_unreferenced_paths(ARRAY[claimed.path])))
    OR EXISTS (
      SELECT 1 FROM public.app_versions AS av
      WHERE av.app_id = claimed.app_id
        AND av.r2_path = claimed.path
        AND public.delta_version_keeps_files(av.deleted, av.deleted_at, av.updated_at)
    )
  FROM claimed;
END;
$$;
ALTER FUNCTION public.delta_gc_claim_unsettled(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_claim_unsettled(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_claim_unsettled(integer) TO service_role;

-- p_referenced: the object is referenced again and was present (or restored). It is re-checked twice
-- more before the record goes; an unreferenced path is dropped at once.
CREATE FUNCTION public.delta_gc_settle(p_path text, p_referenced boolean DEFAULT false)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.delta_gc_unsettled_deletes
  WHERE path = p_path AND (NOT p_referenced OR checks >= 2);
  UPDATE public.delta_gc_unsettled_deletes
  SET checks = checks + 1, recorded_at = now()
  WHERE path = p_path AND p_referenced;
$$;
ALTER FUNCTION public.delta_gc_settle(text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_settle(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_settle(text, boolean) TO service_role;

-- App deletion only removes the current owner's prefix (on_app_delete), and
-- the cascade drops delta_files, which is how GC finds former owners'
-- prefixes. Record those prefixes first; GC drains them afterwards.
CREATE TABLE public.delta_gc_orphan_prefixes (
  prefix text PRIMARY KEY,
  app_id character varying NOT NULL,
  org text NOT NULL,
  list_cursor text,
  claimed_until timestamptz,
  -- Same role as delta_gc_state.lease_until for an app id recreated later.
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.delta_gc_orphan_prefixes OWNER TO postgres;
ALTER TABLE public.delta_gc_orphan_prefixes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.delta_gc_orphan_prefixes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.delta_gc_orphan_prefixes TO service_role;
CREATE POLICY "Deny all direct access" ON public.delta_gc_orphan_prefixes AS RESTRICTIVE USING (false) WITH CHECK (false);
-- Read by every app_versions insert (delta_gc_wait_for_lease).
CREATE INDEX delta_gc_orphan_prefixes_app_id_idx ON public.delta_gc_orphan_prefixes (app_id);

CREATE FUNCTION public.delta_gc_record_orphan_prefixes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.delta_gc_orphan_prefixes (prefix, app_id, org)
  SELECT DISTINCT 'orgs/' || orgs.org || '/apps/' || OLD.app_id || '/', OLD.app_id, orgs.org
  FROM (
    SELECT pg_catalog.split_part(df.s3_path, '/', 2) AS org
    FROM public.delta_files AS df
    WHERE df.app_id = OLD.app_id AND df.s3_path LIKE 'orgs/%'
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
  ON CONFLICT (prefix) DO NOTHING;
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.delta_gc_record_orphan_prefixes() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_record_orphan_prefixes() FROM PUBLIC;

CREATE TRIGGER delta_gc_record_orphan_prefixes
BEFORE DELETE ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.delta_gc_record_orphan_prefixes();

-- An app id created in, or transferred into, an organization owns that
-- prefix again: its stale cleanup task is retired.
CREATE FUNCTION public.delta_gc_retire_orphan_prefixes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- A row whose delete lease is active stays until the lease ends: its
  -- lease is what makes this app's first uploads wait for those deletes.
  DELETE FROM public.delta_gc_orphan_prefixes
  WHERE app_id = NEW.app_id AND org = NEW.owner_org::text
    AND (lease_until IS NULL OR lease_until <= pg_catalog.clock_timestamp());
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.delta_gc_retire_orphan_prefixes() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_retire_orphan_prefixes() FROM PUBLIC;

CREATE TRIGGER delta_gc_retire_orphan_prefixes
AFTER INSERT OR UPDATE OF owner_org ON public.apps
FOR EACH ROW EXECUTE FUNCTION public.delta_gc_retire_orphan_prefixes();

-- Claims former-owner prefixes of deleted apps. A prefix whose app id exists
-- again under that organization is dropped: its objects belong to that app.
CREATE FUNCTION public.delta_gc_claim_orphan_prefixes(p_limit integer DEFAULT 2)
RETURNS TABLE (prefix text, list_cursor text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.delta_storage_gc_enabled() THEN
    RETURN;
  END IF;

  DELETE FROM public.delta_gc_orphan_prefixes AS o
  WHERE EXISTS (
    SELECT 1 FROM public.apps AS a
    WHERE a.app_id = o.app_id AND a.owner_org::text = o.org
  )
    AND (o.lease_until IS NULL OR o.lease_until <= pg_catalog.clock_timestamp());

  RETURN QUERY
  WITH due AS (
    SELECT o.prefix
    FROM public.delta_gc_orphan_prefixes AS o
    WHERE o.claimed_until IS NULL OR o.claimed_until < now()
    ORDER BY o.created_at
    LIMIT GREATEST(COALESCE(p_limit, 2), 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.delta_gc_orphan_prefixes AS o
  SET claimed_until = now() + interval '15 minutes'
  FROM due
  WHERE o.prefix = due.prefix
  RETURNING o.prefix, o.list_cursor;
END;
$$;
ALTER FUNCTION public.delta_gc_claim_orphan_prefixes(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_claim_orphan_prefixes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_claim_orphan_prefixes(integer) TO service_role;

-- Orphan objects go through the same trash, lock and lease as app objects:
-- the app id may be recreated, and its first app_versions insert waits on
-- this lease (delta_gc_wait_for_lease). Returns the paths that may be
-- deleted, or NULL when the prefix cannot be drained now.
CREATE FUNCTION public.delta_gc_begin_orphan_delete(p_prefix text, p_paths text[], p_lease_ms integer DEFAULT 2000)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_orphan public.delta_gc_orphan_prefixes%ROWTYPE;
  v_paths text[];
BEGIN
  IF NOT public.delta_storage_gc_enabled() THEN
    RETURN '{}'::text[];
  END IF;
  SELECT * INTO v_orphan FROM public.delta_gc_orphan_prefixes WHERE prefix = p_prefix;
  IF NOT FOUND THEN
    RETURN '{}'::text[];
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('delta_gc'),
    public.delta_gc_lock_key(v_orphan.app_id)
  );

  -- Recreated under that organization: the objects belong to that app now.
  IF EXISTS (
    SELECT 1 FROM public.apps AS a
    WHERE a.app_id = v_orphan.app_id AND a.owner_org::text = v_orphan.org
  ) THEN
    DELETE FROM public.delta_gc_orphan_prefixes
    WHERE prefix = p_prefix AND (lease_until IS NULL OR lease_until <= pg_catalog.clock_timestamp());
    RETURN NULL;
  END IF;
  -- NULL: refused for now; the page is listed again instead of skipped.
  IF public.delta_app_has_upload_in_progress(v_orphan.app_id) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.delta_gc_orphan_prefixes
    WHERE prefix = p_prefix AND lease_until > pg_catalog.clock_timestamp()
  ) THEN
    RETURN NULL;
  END IF;

  -- The prefix also holds bundle zips: a kept version of a recreated (and
  -- maybe transferred) app with this id may still point at one.
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT p.path), '{}'::text[]) INTO v_paths
  FROM pg_catalog.unnest(public.delta_gc_unreferenced_paths(p_paths)) AS p (path)
  WHERE pg_catalog.starts_with(p.path, p_prefix)
    AND NOT EXISTS (
      SELECT 1 FROM public.app_versions AS av
      WHERE av.app_id = v_orphan.app_id
        AND av.r2_path = p.path
        AND public.delta_version_keeps_files(av.deleted, av.deleted_at, av.updated_at)
    );
  -- Retry the page once earlier unsettled deletes are repaired: the task is
  -- dropped after its last page, so nothing may be skipped here.
  IF EXISTS (SELECT 1 FROM public.delta_gc_unsettled_deletes AS u WHERE u.path = ANY (v_paths)) THEN
    RETURN NULL;
  END IF;
  IF COALESCE(pg_catalog.array_length(v_paths, 1), 0) = 0 THEN
    RETURN '{}'::text[];
  END IF;

  INSERT INTO public.delta_gc_unsettled_deletes (path, app_id)
  SELECT p.path, v_orphan.app_id FROM pg_catalog.unnest(v_paths) AS p (path)
  ON CONFLICT (path) DO UPDATE SET app_id = EXCLUDED.app_id, recorded_at = now(), checks = 0;

  UPDATE public.delta_gc_orphan_prefixes
  SET lease_until = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_ms, 2000), 500), 2000) / 1000.0)
  WHERE prefix = p_prefix;
  RETURN v_paths;
END;
$$;
ALTER FUNCTION public.delta_gc_begin_orphan_delete(text, text[], integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_begin_orphan_delete(text, text[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_begin_orphan_delete(text, text[], integer) TO service_role;

CREATE FUNCTION public.delta_gc_end_orphan_delete(p_prefix text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.delta_gc_orphan_prefixes SET lease_until = NULL WHERE prefix = p_prefix
$$;
ALTER FUNCTION public.delta_gc_end_orphan_delete(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_end_orphan_delete(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_end_orphan_delete(text) TO service_role;

-- The task is removed only after the last page was fully processed.
CREATE FUNCTION public.delta_gc_finish_orphan_prefix(p_prefix text, p_list_cursor text, p_page_done boolean DEFAULT true)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.delta_gc_orphan_prefixes
  WHERE prefix = p_prefix AND p_page_done AND p_list_cursor IS NULL
    AND (lease_until IS NULL OR lease_until <= pg_catalog.clock_timestamp());
  UPDATE public.delta_gc_orphan_prefixes
  SET list_cursor = p_list_cursor, claimed_until = NULL
  WHERE prefix = p_prefix;
$$;
ALTER FUNCTION public.delta_gc_finish_orphan_prefix(text, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_gc_finish_orphan_prefix(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_gc_finish_orphan_prefix(text, text, boolean) TO service_role;

-- Legacy checks that a version contains an entry read the new tables.
CREATE FUNCTION public.delta_version_has_entry(p_version_id bigint, p_s3_path text, p_file_hash text)
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
      AND df.s3_path = p_s3_path
      AND df.file_hash = p_file_hash
  )
$$;
ALTER FUNCTION public.delta_version_has_entry(bigint, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delta_version_has_entry(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delta_version_has_entry(bigint, text, text) TO service_role;

-- Delta-only channels accept bundles whose files live in version_files.
CREATE OR REPLACE FUNCTION "public"."channel_update_package_mismatch"("p_update_package" "public"."channel_update_package", "p_version_id" bigint, "p_channel_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_name text;
  v_storage_provider text;
  v_r2_path text;
  v_external_url text;
  v_legacy_manifest public.manifest_entry[];
  v_has_zip boolean;
  v_has_delta boolean;
BEGIN
  IF p_version_id IS NULL OR p_update_package IS NULL OR p_update_package = 'all' THEN
    RETURN NULL;
  END IF;

  SELECT
    app_version.name,
    app_version.storage_provider,
    app_version.r2_path,
    app_version.external_url,
    app_version.manifest
  INTO
    v_name,
    v_storage_provider,
    v_r2_path,
    v_external_url,
    v_legacy_manifest
  FROM public.app_versions AS app_version
  WHERE app_version.id = p_version_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_name IN ('builtin', 'unknown') THEN
    RETURN NULL;
  END IF;

  v_has_zip := (
    (v_storage_provider = 'external' AND NULLIF(BTRIM(COALESCE(v_external_url, '')), '') IS NOT NULL)
    OR (
      v_storage_provider IS DISTINCT FROM 'r2-direct'
      AND NULLIF(BTRIM(COALESCE(v_r2_path, '')), '') IS NOT NULL
    )
  );

  v_has_delta := COALESCE(pg_catalog.array_length(v_legacy_manifest, 1), 0) > 0
    OR EXISTS (
      SELECT 1
      FROM public.version_files AS version_file
      WHERE version_file.app_version_id = p_version_id
    );

  IF p_update_package IN ('zip', 'zip_from_builtin') AND NOT v_has_zip THEN
    RETURN format(
      'CHANNEL_ZIP_REQUIRED: Channel "%s" requires a zip package, but bundle "%s" has no zip. Upload a full zip (omit --delta-only) or set the channel to delta only / zip and delta.',
      p_channel_name,
      v_name
    );
  END IF;

  IF p_update_package IN ('delta', 'delta_from_builtin') AND NOT v_has_delta THEN
    RETURN format(
      'CHANNEL_DELTA_REQUIRED: Channel "%s" requires a delta package, but bundle "%s" has no delta files. Upload with delta enabled (`npx @capgo/cli@latest bundle upload --delta`) or set the channel to zip only / zip and delta.',
      p_channel_name,
      v_name
    );
  END IF;

  RETURN NULL;
END;
$$;

-- Clearing app_versions.manifest jsonb stays allowed once entries are converted.
CREATE OR REPLACE FUNCTION "public"."app_version_manifest_jsonb_unmigrated"("p_version_id" bigint, "p_manifest" "public"."manifest_entry"[]) RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_manifest) AS entry(file_name, s3_path, file_hash)
    WHERE NOT public.delta_version_has_entry(p_version_id, entry.s3_path, entry.file_hash)
  );
$$;

-- Production carries the 3-argument variant, fresh databases the 0-argument
-- one from 20260722082019. Patch whichever exists; never add an overload.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.null_migrated_app_version_manifests()') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION "public"."null_migrated_app_version_manifests"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  batch_size integer := 200;
  max_batches integer := 50;
  batch_no integer := 0;
  updated_batch integer;
  updated_total bigint := 0;
BEGIN
  LOOP
    batch_no := batch_no + 1;
    EXIT WHEN batch_no > max_batches;

    WITH doomed AS (
      SELECT av.id
      FROM public.app_versions AS av
      WHERE av.manifest IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(av.manifest) AS entry(file_name, s3_path, file_hash)
          WHERE NOT public.delta_version_has_entry(av.id, entry.s3_path, entry.file_hash)
        )
      ORDER BY av.id
      LIMIT batch_size
    )
    UPDATE public.app_versions AS av
    SET manifest = NULL
    FROM doomed
    WHERE av.id = doomed.id;

    GET DIAGNOSTICS updated_batch = ROW_COUNT;
    updated_total := updated_total + updated_batch;
    EXIT WHEN updated_batch = 0;
  END LOOP;

  RAISE NOTICE
    'null_migrated_app_version_manifests: updated=% max_batches=%',
    updated_total,
    max_batches;
END;
$$;
$fn$;
  END IF;
  IF pg_catalog.to_regprocedure('public.null_migrated_app_version_manifests(integer, integer, integer)') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION "public"."null_migrated_app_version_manifests"("max_batches" integer DEFAULT 1000000, "batch_size" integer DEFAULT 50, "max_runtime_ms" integer DEFAULT 60000) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  batch_no integer := 0;
  updated_batch integer;
  scanned_batch integer;
  updated_total bigint := 0;
  scanned_total bigint := 0;
  last_id bigint := 0;
  v_max_batches integer := GREATEST(1, COALESCE(max_batches, 1000000));
  v_batch_size integer := GREATEST(1, COALESCE(batch_size, 50));
  v_max_runtime_ms integer := GREATEST(1000, COALESCE(max_runtime_ms, 60000));
  started_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('statement_timeout', '0', true);
  PERFORM pg_catalog.set_config('capgo.reclaim_manifest_null', 'on', true);

  LOOP
    batch_no := batch_no + 1;
    EXIT WHEN batch_no > v_max_batches;
    EXIT WHEN (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000) >= v_max_runtime_ms;

    WITH candidates AS (
      SELECT av.id
      FROM public.app_versions AS av
      WHERE av.manifest IS NOT NULL
        AND av.id > last_id
      ORDER BY av.id
      LIMIT v_batch_size
    ),
    doomed AS (
      SELECT c.id
      FROM candidates AS c
      JOIN public.app_versions AS av ON av.id = c.id
      WHERE NOT EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(av.manifest) AS entry(file_name, s3_path, file_hash)
        WHERE NOT public.delta_version_has_entry(av.id, entry.s3_path, entry.file_hash)
      )
    ),
    updated AS (
      UPDATE public.app_versions AS av
      SET manifest = NULL
      FROM doomed
      WHERE av.id = doomed.id
      RETURNING av.id
    )
    SELECT
      (SELECT count(*)::integer FROM candidates),
      (SELECT count(*)::integer FROM updated),
      COALESCE((SELECT max(id) FROM candidates), last_id)
    INTO scanned_batch, updated_batch, last_id;

    scanned_total := scanned_total + scanned_batch;
    updated_total := updated_total + updated_batch;
    EXIT WHEN scanned_batch = 0;
  END LOOP;

  PERFORM pg_catalog.set_config('capgo.reclaim_manifest_null', 'off', true);

  RAISE NOTICE
    'null_migrated_app_version_manifests: updated=% scanned=% batches=%/% batch_size=% runtime_ms=% budget_ms=%',
    updated_total,
    scanned_total,
    LEAST(batch_no, v_max_batches),
    v_max_batches,
    v_batch_size,
    (EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - started_at)) * 1000)::bigint,
    v_max_runtime_ms;
END;
$$;
$fn$;
  END IF;
END;
$do$;

SELECT pgmq.create('cron_delta_storage_gc');

INSERT INTO public.cron_tasks (name, description, task_type, target, second_interval, minute_interval, enabled)
VALUES
  ('delta_storage_gc', 'Queue delta storage R2 garbage collection', 'queue', 'cron_delta_storage_gc', NULL, 1, true),
  ('delta_storage_gc_queue', 'Process delta storage R2 garbage collection', 'function_queue', '["cron_delta_storage_gc"]', NULL, 1, true)
ON CONFLICT (name) DO NOTHING;


-- Remove the R2 inventory system. Its authoritative copy lived in a separate
-- PlanetScale database; the Supabase copies and receipt summaries are unused.
DROP FUNCTION IF EXISTS public.expire_r2_manifest_placeholders(text, integer);
DROP TABLE IF EXISTS public.r2_inventory_checkpoints;
DROP TABLE IF EXISTS public.r2_objects;
DROP FUNCTION IF EXISTS public.r2_objects_before_write();
DROP FUNCTION IF EXISTS public.r2_inventory_checkpoints_before_write();
DROP TYPE IF EXISTS public.r2_object_state;
-- public.manifest_per_version stays until the previous API workers are
-- replaced: they still write receipt summaries to it during the deploy.

-- Onboarding demo seeding writes demo file entries into the new tables.
CREATE OR REPLACE FUNCTION public.reset_onboarding_demo_app_data(p_app_uuid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_app_id text;
  v_owner_org uuid;
BEGIN
  SELECT "app_id", "owner_org"
  INTO v_app_id, v_owner_org
  FROM "public"."apps"
  WHERE "id" = p_app_uuid;

  IF v_app_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM "public"."claim_legacy_onboarding_demo_data"(p_app_uuid);

  -- unknown/builtin are system placeholders maintained by app creation. They
  -- are allowed in demo-shaped legacy apps, but must never be demo-owned rows.
  DELETE FROM "public"."onboarding_demo_data" odd
  USING "public"."app_versions" av
  WHERE odd."app_id" = v_app_id
    AND odd."relation_name" IN ('app_versions', 'app_versions_meta')
    AND odd."row_key" = av."id"::text
    AND av."app_id" = v_app_id
    AND av."name" IN ('unknown', 'builtin');

  -- Refuse to delete tracked parents when any untracked child row points at
  -- them. Without these guards, ON DELETE CASCADE could remove real data that
  -- a user attached to a demo-created version or channel.
  IF EXISTS (
    WITH tracked_versions AS (
      SELECT "row_key"::bigint AS "id"
      FROM "public"."onboarding_demo_data"
      WHERE "app_id" = v_app_id
        AND "relation_name" = 'app_versions'
    )
    SELECT 1
    FROM "public"."channels" c
    INNER JOIN tracked_versions tv ON tv."id" = c."version"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "public"."onboarding_demo_data" odd
      WHERE odd."app_id" = v_app_id
        AND odd."relation_name" = 'channels'
        AND odd."row_key" = c."id"::text
    )
  ) THEN
    RAISE EXCEPTION 'reset_onboarding_demo_app_data: refusing to cascade from demo versions into untracked channels for app %', v_app_id;
  END IF;

  IF EXISTS (
    WITH tracked_versions AS (
      SELECT "row_key"::bigint AS "id"
      FROM "public"."onboarding_demo_data"
      WHERE "app_id" = v_app_id
        AND "relation_name" = 'app_versions'
    )
    SELECT 1
    FROM "public"."deploy_history" dh
    INNER JOIN tracked_versions tv ON tv."id" = dh."version_id"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "public"."onboarding_demo_data" odd
      WHERE odd."app_id" = v_app_id
        AND odd."relation_name" = 'deploy_history'
        AND odd."row_key" = dh."id"::text
    )
  ) THEN
    RAISE EXCEPTION 'reset_onboarding_demo_app_data: refusing to cascade from demo versions into untracked deploy history for app %', v_app_id;
  END IF;

  -- A demo-tracked version that carries real (non-demo) files is not demo data.
  IF EXISTS (
    WITH tracked_versions AS (
      SELECT "row_key"::bigint AS "id"
      FROM "public"."onboarding_demo_data"
      WHERE "app_id" = v_app_id
        AND "relation_name" = 'app_versions'
    )
    SELECT 1
    FROM "public"."version_files" vf
    INNER JOIN tracked_versions tv ON tv."id" = vf."app_version_id"
    CROSS JOIN LATERAL pg_catalog.unnest(vf."file_ids") AS entry ("file_id")
    INNER JOIN "public"."delta_files" df ON df."id" = entry."file_id"
    WHERE df."s3_path" NOT LIKE ('demo/' || v_app_id || '/%')
  ) THEN
    RAISE EXCEPTION 'reset_onboarding_demo_app_data: refusing to cascade from demo versions into untracked manifest rows for app %', v_app_id;
  END IF;

  IF EXISTS (
    WITH tracked_versions AS (
      SELECT "row_key"::bigint AS "id"
      FROM "public"."onboarding_demo_data"
      WHERE "app_id" = v_app_id
        AND "relation_name" = 'app_versions'
    )
    SELECT 1
    FROM "public"."app_versions_meta" avm
    INNER JOIN tracked_versions tv ON tv."id" = avm."id"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "public"."onboarding_demo_data" odd
      WHERE odd."app_id" = v_app_id
        AND odd."relation_name" = 'app_versions_meta'
        AND odd."row_key" = avm."id"::text
    )
  ) THEN
    RAISE EXCEPTION 'reset_onboarding_demo_app_data: refusing to cascade from demo versions into untracked version metadata for app %', v_app_id;
  END IF;

  IF EXISTS (
    WITH tracked_versions AS (
      SELECT "row_key"::bigint AS "id"
      FROM "public"."onboarding_demo_data"
      WHERE "app_id" = v_app_id
        AND "relation_name" = 'app_versions'
    )
    SELECT 1
    FROM "public"."permissions" p
    INNER JOIN tracked_versions tv ON tv."id" = p."bundle_id"
  ) OR EXISTS (
    WITH tracked_versions AS (
      SELECT "row_key"::bigint AS "id"
      FROM "public"."onboarding_demo_data"
      WHERE "app_id" = v_app_id
        AND "relation_name" = 'app_versions'
    )
    SELECT 1
    FROM "public"."role_bindings" rb
    INNER JOIN tracked_versions tv ON tv."id" = rb."bundle_id"
  ) THEN
    RAISE EXCEPTION 'reset_onboarding_demo_app_data: refusing to cascade from demo versions into RBAC rows for app %', v_app_id;
  END IF;

  IF EXISTS (
    WITH tracked_versions AS (
      SELECT "row_key"::bigint AS "id"
      FROM "public"."onboarding_demo_data"
      WHERE "app_id" = v_app_id
        AND "relation_name" = 'app_versions'
    )
    SELECT 1
    FROM "public"."version_meta" vm
    INNER JOIN tracked_versions tv ON tv."id" = vm."version_id"
    WHERE vm."app_id" = v_app_id
  ) THEN
    RAISE EXCEPTION 'reset_onboarding_demo_app_data: refusing to delete demo versions with non-nullable version metrics for app %', v_app_id;
  END IF;

  IF EXISTS (
    WITH tracked_channels AS (
      SELECT "row_key"::bigint AS "id"
      FROM "public"."onboarding_demo_data"
      WHERE "app_id" = v_app_id
        AND "relation_name" = 'channels'
    )
    SELECT 1
    FROM "public"."deploy_history" dh
    INNER JOIN tracked_channels tc ON tc."id" = dh."channel_id"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "public"."onboarding_demo_data" odd
      WHERE odd."app_id" = v_app_id
        AND odd."relation_name" = 'deploy_history'
        AND odd."row_key" = dh."id"::text
    )
  ) THEN
    RAISE EXCEPTION 'reset_onboarding_demo_app_data: refusing to cascade from demo channels into untracked deploy history for app %', v_app_id;
  END IF;

  IF EXISTS (
    WITH tracked_channels AS (
      SELECT "row_key"::bigint AS "id"
      FROM "public"."onboarding_demo_data"
      WHERE "app_id" = v_app_id
        AND "relation_name" = 'channels'
    )
    SELECT 1
    FROM "public"."channel_devices" cd
    INNER JOIN tracked_channels tc ON tc."id" = cd."channel_id"
    WHERE NOT EXISTS (
      SELECT 1
      FROM "public"."onboarding_demo_data" odd
      WHERE odd."app_id" = v_app_id
        AND odd."relation_name" = 'channel_devices'
        AND odd."row_key" = cd."id"::text
    )
  ) THEN
    RAISE EXCEPTION 'reset_onboarding_demo_app_data: refusing to delete demo channels with untracked channel devices for app %', v_app_id;
  END IF;

  IF EXISTS (
    WITH tracked_channels AS (
      SELECT c."id", c."rbac_id"
      FROM "public"."channels" c
      INNER JOIN "public"."onboarding_demo_data" odd
        ON odd."app_id" = v_app_id
        AND odd."relation_name" = 'channels'
        AND odd."row_key" = c."id"::text
    )
    SELECT 1
    FROM "public"."channel_permission_overrides" cpo
    INNER JOIN tracked_channels tc ON tc."id" = cpo."channel_id"
  ) OR EXISTS (
    WITH tracked_channels AS (
      SELECT c."id", c."rbac_id"
      FROM "public"."channels" c
      INNER JOIN "public"."onboarding_demo_data" odd
        ON odd."app_id" = v_app_id
        AND odd."relation_name" = 'channels'
        AND odd."row_key" = c."id"::text
    )
    SELECT 1
    FROM "public"."org_users" ou
    INNER JOIN tracked_channels tc ON tc."id" = ou."channel_id"
  ) OR EXISTS (
    WITH tracked_channels AS (
      SELECT c."id", c."rbac_id"
      FROM "public"."channels" c
      INNER JOIN "public"."onboarding_demo_data" odd
        ON odd."app_id" = v_app_id
        AND odd."relation_name" = 'channels'
        AND odd."row_key" = c."id"::text
    )
    SELECT 1
    FROM "public"."role_bindings" rb
    INNER JOIN tracked_channels tc ON tc."rbac_id" = rb."channel_id"
  ) THEN
    RAISE EXCEPTION 'reset_onboarding_demo_app_data: refusing to cascade from demo channels into access-control rows for app %', v_app_id;
  END IF;

  DELETE FROM "public"."channel_devices" cd
  USING "public"."onboarding_demo_data" odd
  WHERE odd."app_id" = v_app_id
    AND odd."relation_name" = 'channel_devices'
    AND odd."row_key" = cd."id"::text;

  DELETE FROM "public"."deploy_history" dh
  USING "public"."onboarding_demo_data" odd
  WHERE odd."app_id" = v_app_id
    AND odd."relation_name" = 'deploy_history'
    AND odd."row_key" = dh."id"::text;

  -- Demo file entries live outside the delta prefix; their version_files rows
  -- go with the demo versions below.
  DELETE FROM "public"."delta_files" df
  WHERE df."app_id" = v_app_id
    AND df."s3_path" LIKE ('demo/' || v_app_id || '/%');

  DELETE FROM "public"."build_requests" br
  USING "public"."onboarding_demo_data" odd
  WHERE odd."app_id" = v_app_id
    AND odd."relation_name" = 'build_requests'
    AND odd."row_key" = br."id"::text;

  DELETE FROM "public"."devices" d
  USING "public"."onboarding_demo_data" odd
  WHERE odd."app_id" = v_app_id
    AND odd."relation_name" = 'devices'
    AND odd."row_key" = d."id"::text;

  DELETE FROM "public"."channels" c
  USING "public"."onboarding_demo_data" odd
  WHERE odd."app_id" = v_app_id
    AND odd."relation_name" = 'channels'
    AND odd."row_key" = c."id"::text;

  DELETE FROM "public"."app_versions_meta" avm
  USING "public"."onboarding_demo_data" odd
  WHERE odd."app_id" = v_app_id
    AND odd."relation_name" = 'app_versions_meta'
    AND odd."row_key" = avm."id"::text;

  UPDATE "public"."devices" d
  SET "version" = NULL
  WHERE d."app_id" = v_app_id
    AND EXISTS (
      SELECT 1
      FROM "public"."onboarding_demo_data" odd
      WHERE odd."app_id" = v_app_id
        AND odd."relation_name" = 'app_versions'
        AND odd."row_key" = d."version"::text
    );

  UPDATE "public"."daily_version" dv
  SET "version_id" = NULL
  WHERE dv."app_id" = v_app_id
    AND EXISTS (
      SELECT 1
      FROM "public"."onboarding_demo_data" odd
      WHERE odd."app_id" = v_app_id
        AND odd."relation_name" = 'app_versions'
        AND odd."row_key" = dv."version_id"::text
    );

  UPDATE "public"."version_usage" vu
  SET "version_id" = NULL
  WHERE vu."app_id" = v_app_id
    AND EXISTS (
      SELECT 1
      FROM "public"."onboarding_demo_data" odd
      WHERE odd."app_id" = v_app_id
        AND odd."relation_name" = 'app_versions'
        AND odd."row_key" = vu."version_id"::text
    );

  DELETE FROM "public"."app_versions" av
  USING "public"."onboarding_demo_data" odd
  WHERE odd."app_id" = v_app_id
    AND odd."relation_name" = 'app_versions'
    AND odd."row_key" = av."id"::text;

  DELETE FROM "public"."onboarding_demo_data"
  WHERE "app_id" = v_app_id;

  PERFORM "public"."refresh_app_rollups_after_demo_reset"(p_app_uuid, v_app_id, v_owner_org);
END;
$function$;

-- Tracked ids of legacy demo manifest rows no longer point at anything.
DELETE FROM public.onboarding_demo_data WHERE relation_name = 'manifest';

COMMIT;

RESET lock_timeout;
