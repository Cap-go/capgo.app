BEGIN;

SELECT plan(15);

CREATE TEMP TABLE slim_app ON COMMIT DROP AS
SELECT app_id, owner_org FROM public.apps ORDER BY app_id LIMIT 1;

CREATE TEMP TABLE slim_expected (
  label text PRIMARY KEY,
  s3_path text NOT NULL,
  file_name text NOT NULL,
  file_hash text NOT NULL,
  path_compacts boolean NOT NULL,
  hash_compacts boolean NOT NULL
) ON COMMIT DROP;

-- Every shape seen in production, plus near misses that must keep their text.
INSERT INTO slim_expected
SELECT v.label,
  pg_catalog.replace(pg_catalog.replace(v.s3_path, '<org>', a.owner_org::text), '<app>', a.app_id),
  v.file_name, v.file_hash, v.path_compacts, v.hash_compacts
FROM slim_app AS a
CROSS JOIN (VALUES
  ('session', 'orgs/<org>/apps/<app>/delta/54764a39523d3d3a4e72/' || pg_catalog.repeat('9c', 32) || '_suite/4707.2ef8.js.br',
    'suite/4707.2ef8.js.br', pg_catalog.repeat('34fc', 128), true, true),
  ('no_session', 'orgs/<org>/apps/<app>/delta/' || pg_catalog.repeat('e7', 32) || '_assets/Merged_Pdf-D6.js',
    'assets/Merged_Pdf-D6.js', pg_catalog.repeat('9e', 32), true, true),
  ('former_org', 'orgs/11111111-2222-4333-8444-555555555555/apps/<app>/delta/' || pg_catalog.repeat('ab', 32) || '_index.html',
    'index.html', pg_catalog.repeat('01', 32), true, true),
  ('legacy_version_path', 'orgs/<org>/apps/<app>/1.7.1/svg/rainy.svg',
    'svg/rainy.svg', pg_catalog.repeat('cd', 32), false, true),
  ('base64_hash', 'orgs/<org>/apps/<app>/delta/' || pg_catalog.repeat('ef', 32) || '_main.js',
    'main.js', 'uhAeBLCAyfufPwn6Gi2ieSP8BAk80IUDuYOo4VmaXrgnQBUGPMoNJV0u34wPQpMryUhi+jQECpdSExTMqKpwM2vW3A==', true, false),
  ('upper_hex', 'orgs/<org>/apps/<app>/delta/' || pg_catalog.repeat('EF', 32) || '_upper.js',
    'upper.js', pg_catalog.repeat('AB', 32), false, false),
  ('odd_session', 'orgs/<org>/apps/<app>/delta/abc/' || pg_catalog.repeat('12', 32) || '_odd.js',
    'odd.js', pg_catalog.repeat('12', 32), false, true),
  ('other_app', 'orgs/<org>/apps/other.app/delta/' || pg_catalog.repeat('34', 32) || '_other.js',
    'other.js', pg_catalog.repeat('34', 32), false, true),
  ('name_mismatch', 'orgs/<org>/apps/<app>/delta/' || pg_catalog.repeat('56', 32) || '_a.js',
    'b.js', pg_catalog.repeat('56', 32), false, true),
  ('demo', 'demo/<app>/1.0.0/main.js', 'main.js', 'demo-hash', false, false),
  ('upper_org', 'orgs/11111111-2222-4333-8444-55555555555A/apps/<app>/delta/' || pg_catalog.repeat('78', 32) || '_x.js',
    'x.js', pg_catalog.repeat('78', 32), false, true)
) AS v (label, s3_path, file_name, file_hash, path_compacts, hash_compacts);

INSERT INTO public.delta_files (app_id, s3_path, file_name, file_hash, file_size, path_key, entry_key, created_at)
SELECT a.app_id, e.s3_path, e.file_name, e.file_hash, 1,
  public.delta_path_key(e.s3_path), public.delta_entry_key(e.s3_path, e.file_name, e.file_hash), now() - interval '1 hour'
FROM slim_expected AS e
CROSS JOIN slim_app AS a
ORDER BY e.label;

-- A young row stops the batch: rows with a higher id wait for it.
INSERT INTO public.delta_files (app_id, s3_path, file_name, file_hash, file_size, path_key, entry_key)
SELECT a.app_id, 'orgs/' || a.owner_org || '/apps/' || a.app_id || '/delta/' || pg_catalog.repeat('aa', 32) || '_young.js',
  'young.js', pg_catalog.repeat('aa', 32), 1, '\x01'::bytea, '\x01'::bytea
FROM slim_app AS a;
INSERT INTO public.delta_files (app_id, s3_path, file_name, file_hash, file_size, path_key, entry_key, created_at)
SELECT a.app_id, 'orgs/' || a.owner_org || '/apps/' || a.app_id || '/delta/' || pg_catalog.repeat('bb', 32) || '_after.js',
  'after.js', pg_catalog.repeat('bb', 32), 1, '\x02'::bytea, '\x02'::bytea, now() - interval '1 hour'
FROM slim_app AS a;

INSERT INTO public.app_versions (id, app_id, name, owner_org, storage_provider)
SELECT -9600001, app_id, 'pgtap-slim-delta-files', owner_org, 'r2'
FROM slim_app;
INSERT INTO public.version_files (app_version_id, file_ids)
SELECT -9600001, pg_catalog.array_agg(df.id ORDER BY df.id)
FROM public.delta_files AS df
INNER JOIN slim_expected AS e ON e.s3_path = df.s3_path;

SELECT is(public.delta_files_compact(100), 0, 'nothing is compacted while CAPGO_DELTA_FILES_COMPACT_ENABLED is unset');
SELECT ok(
  pg_catalog.to_regprocedure('public.delta_files_compact_all(integer,integer)') IS NULL,
  'the obsolete transaction-controlling catch-up procedure is removed'
);

SELECT vault.create_secret('true', 'CAPGO_DELTA_FILES_COMPACT_ENABLED');
-- Earlier rows (seed) are not part of this test.
INSERT INTO public.backfill_progress (job_name, scope_key, cutover_at, last_processed_id)
SELECT 'delta_files_compact', 'all', now(), pg_catalog.min(df.id) - 1
FROM public.delta_files AS df
INNER JOIN slim_expected AS e ON e.s3_path = df.s3_path
ON CONFLICT (job_name, scope_key) DO UPDATE SET last_processed_id = EXCLUDED.last_processed_id;

SELECT is(public.delta_files_compact(100), 9, 'every row with a compactable path or hash is rewritten');

SELECT is(
  (SELECT pg_catalog.count(*)::integer FROM public.delta_files AS df
   INNER JOIN slim_expected AS e ON e.label = 'demo' AND e.s3_path = df.s3_path
   WHERE df.path_sha IS NULL AND df.file_hash_bin IS NULL),
  1,
  'a row with no compactable part is left untouched'
);

SELECT results_eq(
  $$SELECT e.label FROM slim_expected AS e
    INNER JOIN public.delta_files AS df ON df.app_id = (SELECT app_id FROM slim_app) AND df.entry_key = public.delta_entry_key(e.s3_path, e.file_name, e.file_hash)
    WHERE (df.path_sha IS NOT NULL) = e.path_compacts AND (df.s3_path = '') = e.path_compacts
    ORDER BY e.label$$,
  $$SELECT label FROM slim_expected ORDER BY label$$,
  'only paths in the delta shape are stored as parts'
);

SELECT results_eq(
  $$SELECT e.label FROM slim_expected AS e
    INNER JOIN public.delta_files AS df ON df.app_id = (SELECT app_id FROM slim_app) AND df.entry_key = public.delta_entry_key(e.s3_path, e.file_name, e.file_hash)
    WHERE (df.file_hash_bin IS NOT NULL) = e.hash_compacts AND (df.file_hash = '') = e.hash_compacts
    ORDER BY e.label$$,
  $$SELECT label FROM slim_expected ORDER BY label$$,
  'only lower-case hex hashes are stored as bytes'
);

SELECT results_eq(
  $$SELECT e.label, e.s3_path, e.file_hash FROM slim_expected AS e
    INNER JOIN public.delta_files AS df ON df.app_id = (SELECT app_id FROM slim_app) AND df.entry_key = public.delta_entry_key(e.s3_path, e.file_name, e.file_hash)
    ORDER BY e.label$$,
  $$SELECT e.label,
      public.delta_file_s3_path(df.s3_path, df.app_id, df.file_name, df.path_org, df.path_session, df.path_sha),
      public.delta_file_hash(df.file_hash, df.file_hash_bin)
    FROM slim_expected AS e
    INNER JOIN public.delta_files AS df ON df.app_id = (SELECT app_id FROM slim_app) AND df.entry_key = public.delta_entry_key(e.s3_path, e.file_name, e.file_hash)
    ORDER BY e.label$$,
  'every row rebuilds its original path and hash'
);

SELECT results_eq(
  $$SELECT s3_path::text, file_hash::text FROM public.version_manifest WHERE app_version_id = -9600001 ORDER BY s3_path$$,
  $$SELECT s3_path, file_hash FROM slim_expected ORDER BY s3_path$$,
  'version_manifest serves the original values'
);

SELECT results_eq(
  $$SELECT s3_path::text, file_hash::text FROM public.manifest WHERE app_version_id = -9600001 ORDER BY s3_path$$,
  $$SELECT s3_path, file_hash FROM slim_expected ORDER BY s3_path$$,
  'the compatibility manifest view serves the original values'
);

SELECT ok(
  (SELECT pg_catalog.bool_and(public.delta_version_has_entry(-9600001, e.s3_path, e.file_hash)) FROM slim_expected AS e),
  'delta_version_has_entry matches compacted rows by their original values'
);

SELECT is(
  (SELECT pg_catalog.count(*)::integer FROM public.delta_files
   WHERE file_name IN ('young.js', 'after.js') AND path_sha IS NULL AND file_hash_bin IS NULL),
  2,
  'a row younger than 10 minutes and every later row wait'
);

SELECT is(public.delta_files_compact(100), 0, 'the next run waits for the young row');

UPDATE public.delta_files SET created_at = now() - interval '1 hour' WHERE file_name = 'young.js';
SELECT is(public.delta_files_compact(100), 2, 'once old enough, the waiting rows are compacted');

SELECT is(
  (SELECT pg_catalog.count(*)::integer FROM public.delta_files
   WHERE file_name IN ('young.js', 'after.js') AND s3_path = '' AND file_hash = ''),
  2,
  'the waiting rows are stored as parts'
);

-- GC lists every prefix the app's files live under, compacted or not.
SELECT vault.create_secret('true', 'CAPGO_DELTA_STORAGE_GC_ENABLED');
UPDATE public.app_versions SET manifest = NULL WHERE app_id = (SELECT app_id FROM slim_app);
INSERT INTO public.delta_gc_state (app_id, next_run_at)
SELECT app_id, now() - interval '1 minute' FROM slim_app
ON CONFLICT (app_id) DO UPDATE SET next_run_at = EXCLUDED.next_run_at, list_org = NULL, pending_orgs = '{}', known_orgs = '{}';
SELECT public.delta_gc_claim(1000);

SELECT ok(
  (SELECT s.known_orgs @> ARRAY['11111111-2222-4333-8444-555555555555', a.owner_org::text]
   FROM public.delta_gc_state AS s INNER JOIN slim_app AS a ON a.app_id = s.app_id),
  'GC lists the former owner prefix of a compacted row'
);

SELECT * FROM finish();
ROLLBACK;
