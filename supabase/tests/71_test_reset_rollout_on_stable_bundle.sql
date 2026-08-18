-- Setting a new stable channel bundle drops leftover progressive rollout.
BEGIN;

SELECT plan(9);

SELECT tests.authenticate_as_service_role();
SELECT tests.create_supabase_user(
  'reset_rollout_owner',
  'reset_rollout_owner@test.local'
);

INSERT INTO public.users (id, email, created_at, updated_at)
VALUES (
  tests.get_supabase_uid('reset_rollout_owner'),
  'reset_rollout_owner@test.local',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.orgs (id, created_by, name, management_email)
VALUES (
  '71000000-0000-4000-8000-000000000071',
  tests.get_supabase_uid('reset_rollout_owner'),
  'Reset rollout org',
  'reset-rollout@test.local'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.apps (app_id, icon_url, user_id, name, owner_org)
VALUES (
  'com.test.reset.rollout.stable',
  '',
  tests.get_supabase_uid('reset_rollout_owner'),
  'Reset rollout app',
  '71000000-0000-4000-8000-000000000071'
)
ON CONFLICT (app_id) DO NOTHING;

INSERT INTO public.app_versions (
  id,
  app_id,
  name,
  owner_org,
  user_id,
  storage_provider,
  deleted
)
VALUES
  (
    7100701,
    'com.test.reset.rollout.stable',
    '1.0.0-stable',
    '71000000-0000-4000-8000-000000000071'::uuid,
    tests.get_supabase_uid('reset_rollout_owner'),
    'r2',
    false
  ),
  (
    7100702,
    'com.test.reset.rollout.stable',
    '1.0.1-rollout',
    '71000000-0000-4000-8000-000000000071'::uuid,
    tests.get_supabase_uid('reset_rollout_owner'),
    'r2',
    false
  ),
  (
    7100703,
    'com.test.reset.rollout.stable',
    '1.0.2-next-stable',
    '71000000-0000-4000-8000-000000000071'::uuid,
    tests.get_supabase_uid('reset_rollout_owner'),
    'r2',
    false
  ),
  (
    7100704,
    'com.test.reset.rollout.stable',
    '1.0.3-next-rollout',
    '71000000-0000-4000-8000-000000000071'::uuid,
    tests.get_supabase_uid('reset_rollout_owner'),
    'r2',
    false
  )
ON CONFLICT (id) DO UPDATE
SET deleted = false;

INSERT INTO public.channels (
  id,
  name,
  app_id,
  version,
  rollout_version,
  rollout_enabled,
  rollout_percentage_bps,
  owner_org,
  created_by
)
VALUES (
  7100401,
  'production',
  'com.test.reset.rollout.stable',
  7100701,
  7100702,
  true,
  10000,
  '71000000-0000-4000-8000-000000000071'::uuid,
  tests.get_supabase_uid('reset_rollout_owner')
)
ON CONFLICT (id) DO UPDATE
SET
  version = EXCLUDED.version,
  rollout_version = EXCLUDED.rollout_version,
  rollout_enabled = EXCLUDED.rollout_enabled,
  rollout_percentage_bps = EXCLUDED.rollout_percentage_bps;

CREATE TEMP TABLE reset_rollout_before AS
SELECT rollout_id
FROM public.channels
WHERE id = 7100401;

SELECT is(
  (SELECT rollout_channel_count FROM public.apps WHERE app_id = 'com.test.reset.rollout.stable'),
  1::bigint,
  'app rollup counts the leftover rollout before reset'
);

UPDATE public.channels
SET version = 7100703
WHERE id = 7100401;

SELECT is(
  (SELECT version FROM public.channels WHERE id = 7100401),
  7100703::bigint,
  'stable bundle is updated'
);

SELECT is(
  (SELECT rollout_version FROM public.channels WHERE id = 7100401),
  NULL,
  'leftover rollout target is cleared'
);

SELECT is(
  (SELECT rollout_enabled FROM public.channels WHERE id = 7100401),
  false,
  'leftover rollout is disabled'
);

SELECT isnt(
  (SELECT rollout_id FROM public.channels WHERE id = 7100401),
  (SELECT rollout_id FROM reset_rollout_before),
  'rollout_id rotates so sticky device assignments miss'
);

SELECT is(
  (SELECT rollout_percentage_bps FROM public.channels WHERE id = 7100401),
  0,
  'leftover rollout percentage is cleared'
);

SELECT is(
  (SELECT rollout_channel_count FROM public.apps WHERE app_id = 'com.test.reset.rollout.stable'),
  0::bigint,
  'app rollup drops the leftover rollout after a stable-only update'
);

UPDATE public.channels
SET
  rollout_version = 7100702,
  rollout_enabled = true
WHERE id = 7100401;

UPDATE public.channels
SET version = 7100703
WHERE id = 7100401;

SELECT is(
  (SELECT rollout_version FROM public.channels WHERE id = 7100401),
  7100702::bigint,
  'rewriting the same stable bundle keeps the current rollout'
);

UPDATE public.channels
SET
  version = 7100701,
  rollout_version = 7100704,
  rollout_enabled = true
WHERE id = 7100401;

SELECT is(
  (SELECT rollout_version FROM public.channels WHERE id = 7100401),
  7100704::bigint,
  'an explicit new rollout target is kept when the stable bundle also changes'
);

SELECT * FROM finish(); -- noqa: AM04

ROLLBACK;
