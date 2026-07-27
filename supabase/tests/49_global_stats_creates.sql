BEGIN;

SELECT plan(10);

SELECT tests.authenticate_as_service_role();

CREATE TEMP TABLE tmp_global_stats_creates AS
SELECT
  COALESCE((
    SELECT apps_created
    FROM public.global_stats
    WHERE date_id = ((now() AT TIME ZONE 'UTC')::date)::text
  ), 0) AS apps_base,
  COALESCE((
    SELECT versions_created
    FROM public.global_stats
    WHERE date_id = ((now() AT TIME ZONE 'UTC')::date)::text
  ), 0) AS versions_base;

SELECT is(
  (SELECT count(*) FROM tmp_global_stats_creates),
  1::bigint,
  'Baseline counters captured'
);

INSERT INTO public.apps (
  app_id,
  name,
  icon_url,
  owner_org,
  user_id
)
VALUES (
  'com.test.global.stats.creates',
  'Global Stats Creates App',
  '',
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  '6aa76066-55ef-4238-ade6-0b32334a4097'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pgmq.q_global_stats_creates
    WHERE message ->> 'metric' = 'apps_created'
      AND message ->> 'date_id' = ((now() AT TIME ZONE 'UTC')::date)::text
      AND (message ->> 'delta')::integer = 1
  ),
  'App insert enqueues apps_created +1'
);

SELECT is(
  public.process_global_stats_creates_queue(100),
  1::bigint,
  'Queue processor applies apps_created delta'
);

SELECT is(
  (
    SELECT apps_created
    FROM public.global_stats
    WHERE date_id = ((now() AT TIME ZONE 'UTC')::date)::text
  ),
  (SELECT apps_base + 1 FROM tmp_global_stats_creates),
  'apps_created increments after queue processing'
);

INSERT INTO public.app_versions (
  app_id,
  name,
  owner_org,
  user_id,
  storage_provider
)
VALUES (
  'com.test.global.stats.creates',
  '1.0.0-global-stats-creates',
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  '6aa76066-55ef-4238-ade6-0b32334a4097',
  'r2'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pgmq.q_global_stats_creates
    WHERE message ->> 'metric' = 'versions_created'
      AND message ->> 'date_id' = ((now() AT TIME ZONE 'UTC')::date)::text
      AND (message ->> 'delta')::integer = 1
  ),
  'Version insert enqueues versions_created +1'
);

SELECT is(
  public.process_global_stats_creates_queue(100),
  1::bigint,
  'Queue processor applies versions_created delta'
);

SELECT is(
  (
    SELECT versions_created
    FROM public.global_stats
    WHERE date_id = ((now() AT TIME ZONE 'UTC')::date)::text
  ),
  (SELECT versions_base + 1 FROM tmp_global_stats_creates),
  'versions_created increments after queue processing'
);

INSERT INTO public.app_versions (
  app_id,
  name,
  owner_org,
  user_id,
  storage_provider
)
VALUES (
  'com.test.global.stats.creates',
  'builtin',
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  '6aa76066-55ef-4238-ade6-0b32334a4097',
  'r2'
);

SELECT is(
  (
    SELECT count(*)
    FROM pgmq.q_global_stats_creates
    WHERE message ->> 'metric' = 'versions_created'
      AND message ->> 'date_id' = ((now() AT TIME ZONE 'UTC')::date)::text
  ),
  0::bigint,
  'Internal builtin version does not enqueue create counter'
);

DELETE FROM public.apps
WHERE app_id = 'com.test.global.stats.creates';

SELECT is(
  (
    SELECT apps_created
    FROM public.global_stats
    WHERE date_id = ((now() AT TIME ZONE 'UTC')::date)::text
  ),
  (SELECT apps_base + 1 FROM tmp_global_stats_creates),
  'apps_created remains after app delete'
);

SELECT is(
  (
    SELECT versions_created
    FROM public.global_stats
    WHERE date_id = ((now() AT TIME ZONE 'UTC')::date)::text
  ),
  (SELECT versions_base + 1 FROM tmp_global_stats_creates),
  'versions_created remains after app delete'
);

SELECT finish();

ROLLBACK;
