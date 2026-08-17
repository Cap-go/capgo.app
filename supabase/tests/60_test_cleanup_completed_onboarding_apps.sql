BEGIN;

SELECT plan(19);

SELECT tests.authenticate_as_service_role();

-- Fixtures (all need_onboarding=true). Org/user come from the seed.
--   real.old     -> upload-ready r2 bundle, 20d            => auto-complete
--   real.recent  -> upload-ready r2 bundle, 2d             => too young, pending
--   noreal.old   -> live 'builtin' placeholder, upload-ready => excluded by NAME, pending
--   demo.old     -> upload-ready but demo-tracked + demo/   => seeded demo, pending
--   noupload.old -> non-placeholder version, NO artifact    => not upload-ready, pending
--   external.old -> external bundle w/ external_url, 20d    => auto-complete (external branch)
--   r2direct.old -> 'r2-direct' provider w/ r2_path, 20d    => NOT upload-ready, pending
--   raises.old   -> real bundle (eligible) + a demo-tracked
--                   version with an UNTRACKED manifest      => provenance reset RAISEs,
--                                                              app is skipped, data preserved
INSERT INTO public.apps (id, owner_org, app_id, icon_url, name, user_id, need_onboarding, created_at)
VALUES
  ('60000000-0000-0000-0000-000000000001', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.onb.real.old', '', 'Real Old', '6aa76066-55ef-4238-ade6-0b32334a4097', true, now() - interval '20 days'),
  ('60000000-0000-0000-0000-000000000002', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.onb.real.recent', '', 'Real Recent', '6aa76066-55ef-4238-ade6-0b32334a4097', true, now() - interval '2 days'),
  ('60000000-0000-0000-0000-000000000003', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.onb.noreal.old', '', 'No Real Old', '6aa76066-55ef-4238-ade6-0b32334a4097', true, now() - interval '20 days'),
  ('60000000-0000-0000-0000-000000000004', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.onb.demo.old', '', 'Demo Old', '6aa76066-55ef-4238-ade6-0b32334a4097', true, now() - interval '20 days'),
  ('60000000-0000-0000-0000-000000000005', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.onb.noupload.old', '', 'No Upload Old', '6aa76066-55ef-4238-ade6-0b32334a4097', true, now() - interval '20 days'),
  ('60000000-0000-0000-0000-000000000006', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.onb.external.old', '', 'External Old', '6aa76066-55ef-4238-ade6-0b32334a4097', true, now() - interval '20 days'),
  ('60000000-0000-0000-0000-000000000007', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.onb.r2direct.old', '', 'R2 Direct Old', '6aa76066-55ef-4238-ade6-0b32334a4097', true, now() - interval '20 days'),
  ('60000000-0000-0000-0000-000000000008', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'com.test.onb.raises.old', '', 'Raises Old', '6aa76066-55ef-4238-ade6-0b32334a4097', true, now() - interval '20 days');

-- storage_provider is NOT NULL; every row supplies a value.
-- noreal.old (960003): a LIVE builtin placeholder that is otherwise upload-ready,
--   so it is rejected ONLY by the name filter (exercises that branch).
-- raises.old has two versions: 960008 (real, makes it eligible) and 960009
--   (demo-tracked, with a non-demo manifest that is left untracked).
INSERT INTO public.app_versions (
  id,
  owner_org,
  created_at,
  app_id,
  name,
  user_id,
  deleted,
  storage_provider,
  r2_path,
  external_url
)
VALUES
  (
    960001,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - interval '20 days',
    'com.test.onb.real.old',
    '1.0.0',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    false,
    'r2',
    'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.test.onb.real.old/1.0.0.zip',
    null
  ),
  (
    960002,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - interval '2 days',
    'com.test.onb.real.recent',
    '1.0.0',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    false,
    'r2',
    'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.test.onb.real.recent/1.0.0.zip',
    null
  ),
  (
    960003,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - interval '20 days',
    'com.test.onb.noreal.old',
    'builtin',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    false,
    'r2',
    'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.test.onb.noreal.old/builtin.zip',
    null
  ),
  (
    960004,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - interval '20 days',
    'com.test.onb.demo.old',
    '1.0.0',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    false,
    'r2',
    'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.test.onb.demo.old/1.0.0.zip',
    null
  ),
  (
    960005,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - interval '20 days',
    'com.test.onb.noupload.old',
    '1.0.0',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    false,
    'r2',
    null,
    null
  ),
  (
    960006,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - interval '20 days',
    'com.test.onb.external.old',
    '1.0.0',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    false,
    'external',
    null,
    'https://cdn.example.com/external/1.0.0.zip'
  ),
  (
    960007,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - interval '20 days',
    'com.test.onb.r2direct.old',
    '1.0.0',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    false,
    'r2-direct',
    'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.test.onb.r2direct.old/1.0.0.zip',
    null
  ),
  (
    960008,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - interval '20 days',
    'com.test.onb.raises.old',
    '2.0.0',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    false,
    'r2',
    'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.test.onb.raises.old/2.0.0.zip',
    null
  ),
  (
    960009,
    '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
    now() - interval '20 days',
    'com.test.onb.raises.old',
    '1.0.0',
    '6aa76066-55ef-4238-ade6-0b32334a4097',
    false,
    'r2',
    'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.test.onb.raises.old/1.0.0.zip',
    null
  );

-- demo.old carries a demo/ manifest (so has_seeded_demo_data is true).
-- raises.old's demo-tracked version 960009 carries a NON-demo manifest that is
-- deliberately NOT tracked in onboarding_demo_data, so the provenance reset's
-- "untracked manifest on a demo version" guard fires (RAISE) on flip.
INSERT INTO public.manifest (app_version_id, file_name, s3_path, file_hash, file_size)
VALUES
  (960004, 'main.js', 'demo/com.test.onb.demo.old/1.0.0/main.js', repeat('c', 64), 123),
  (960009, 'main.js', 'orgs/046a36ac/apps/com.test.onb.raises.old/1.0.0/main.js', repeat('d', 64), 123);

-- Provenance: demo.old version and raises.old's 960009 are demo-seeded.
INSERT INTO public.onboarding_demo_data (app_id, owner_org, relation_name, row_key, seed_id)
VALUES
  ('com.test.onb.demo.old', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'app_versions', '960004', '70000000-0000-0000-0000-000000000001'),
  ('com.test.onb.raises.old', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'app_versions', '960009', '70000000-0000-0000-0000-000000000002');

-- app_has_real_bundle: true only for upload-ready, non-placeholder, non-demo bundles.
SELECT ok(public.app_has_real_bundle('com.test.onb.real.old'), 'true for an upload-ready stored (r2) bundle');
SELECT ok(public.app_has_real_bundle('com.test.onb.external.old'), 'true for an upload-ready external bundle');
SELECT ok(public.app_has_real_bundle('com.test.onb.raises.old'), 'true when a real bundle coexists with a demo-tracked version');
SELECT ok(NOT public.app_has_real_bundle('com.test.onb.noreal.old'), 'false for a live builtin placeholder (name filter)');
SELECT ok(NOT public.app_has_real_bundle('com.test.onb.noupload.old'), 'false for a non-upload-ready (metadata-only) version');
SELECT ok(NOT public.app_has_real_bundle('com.test.onb.r2direct.old'), 'false for an r2-direct (in-progress) version');
SELECT ok(NOT public.app_has_real_bundle('com.test.onb.demo.old'), 'false for a demo-tracked version (provenance)');

SELECT ok(public.has_seeded_demo_data('com.test.onb.demo.old'), 'has_seeded_demo_data true for the seeded demo app');

-- Run the job.
SELECT public.cleanup_completed_onboarding_apps();

SELECT is((SELECT need_onboarding FROM public.apps WHERE app_id = 'com.test.onb.real.old'), false, 'real (r2) app is auto-completed');
SELECT is((SELECT need_onboarding FROM public.apps WHERE app_id = 'com.test.onb.external.old'), false, 'real (external) app is auto-completed');
SELECT is((SELECT need_onboarding FROM public.apps WHERE app_id = 'com.test.onb.real.recent'), true, 'recent app stays pending');
SELECT is((SELECT need_onboarding FROM public.apps WHERE app_id = 'com.test.onb.noreal.old'), true, 'builtin-placeholder app stays pending');
SELECT is((SELECT need_onboarding FROM public.apps WHERE app_id = 'com.test.onb.demo.old'), true, 'seeded demo app stays pending');
SELECT is((SELECT need_onboarding FROM public.apps WHERE app_id = 'com.test.onb.noupload.old'), true, 'metadata-only app stays pending');
SELECT is((SELECT need_onboarding FROM public.apps WHERE app_id = 'com.test.onb.r2direct.old'), true, 'r2-direct app stays pending');

-- The provenance reset RAISEs for raises.old; the per-app exception block leaves
-- it pending WITHOUT aborting the batch (real.old/external.old completed above)
-- and WITHOUT deleting any of its data (the flip is rolled back).
SELECT is((SELECT need_onboarding FROM public.apps WHERE app_id = 'com.test.onb.raises.old'), true, 'app whose cleanup raises is skipped, left pending');
SELECT is(
  (SELECT count(*)::integer FROM public.app_versions WHERE app_id = 'com.test.onb.raises.old' AND deleted = false),
  2,
  'a raising apps data is fully preserved (flip rolled back, nothing deleted)'
);

SELECT is(
  (SELECT count(*)::integer FROM public.app_versions
   WHERE app_id = 'com.test.onb.real.old' AND name = '1.0.0' AND deleted = false),
  1,
  'completed app keeps its real bundle (no demo provenance to clear)'
);

SELECT ok(
  (
    SELECT count(*)::int
    FROM public.cron_tasks
    WHERE name = 'cleanup_completed_onboarding_apps'
      AND enabled = TRUE
      AND task_type = 'function'::public.cron_task_type
      AND target = 'public.cleanup_completed_onboarding_apps()'
      AND hour_interval IS NULL
      AND run_at_hour = 4
      AND run_at_minute = 0
  ) = 1,
  'cron_tasks registers the daily onboarding auto-complete job'
);

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
