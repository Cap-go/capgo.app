BEGIN;
SELECT plan(25);
INSERT INTO private.settings(name, value) VALUES ('CAPGO_UPDATES_CACHE_PURGE_ENABLED', 'true')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;
-- Suppress HTTP wakes in this transaction; assert the durable pending rows.
SELECT pg_catalog.set_config('capgo.updates_cache_wake_sent', 'on', true);
SELECT pg_catalog.set_config('capgo.plugin_state_wake_sent', 'on', true);
SELECT is((SELECT serving_region_mode FROM public.apps WHERE app_id = 'com.demo.app'), 'route', 'existing apps default to route');
SELECT is((SELECT cardinality(serving_regions) FROM public.apps WHERE app_id = 'com.demo.app'), 9, 'existing apps default to all nine regions');

INSERT INTO public.apps (app_id, icon_url, owner_org, name)
SELECT 'com.example.serving.sql', icon_url, owner_org, 'Serving regions SQL fixture'
FROM public.apps WHERE app_id = 'com.demo.app';
SELECT is((SELECT cardinality(serving_regions) FROM public.apps WHERE app_id = 'com.example.serving.sql'), 9, 'new apps default to all nine');
SELECT lives_ok($$UPDATE public.apps SET serving_regions = ARRAY['EU','NA','SA','OC','AS_INDIA','AS_JAPAN','HK','AF','ME'] WHERE app_id = 'com.example.serving.sql'$$, 'accepts all supported regions');
SELECT lives_ok($$UPDATE public.apps SET serving_regions = ARRAY['NA','HK'], serving_region_mode = 'block' WHERE app_id = 'com.example.serving.sql'$$, 'accepts valid subset and block');
SELECT throws_ok($$UPDATE public.apps SET serving_regions = ARRAY[]::text[] WHERE app_id = 'com.example.serving.sql'$$, '23514', NULL, 'rejects empty regions');
SELECT throws_ok($$UPDATE public.apps SET serving_regions = ARRAY['EU','EU'] WHERE app_id = 'com.example.serving.sql'$$, '23514', NULL, 'rejects duplicates');
SELECT throws_ok(format($$UPDATE public.apps SET serving_regions = ARRAY[%L,%L] WHERE app_id = 'com.example.serving.sql'$$, region, region), '23514', NULL, 'rejects duplicate ' || region)
FROM unnest(ARRAY['NA','SA','OC','AS_INDIA','AS_JAPAN','HK','AF','ME']) AS regions(region);
SELECT throws_ok($$UPDATE public.apps SET serving_regions = ARRAY[['EU'],['NA']] WHERE app_id = 'com.example.serving.sql'$$, '23514', NULL, 'rejects multidimensional regions before array search');
SELECT throws_ok($$UPDATE public.apps SET serving_regions = ARRAY['INVALID'] WHERE app_id = 'com.example.serving.sql'$$, '23514', NULL, 'rejects unsupported region');
SELECT throws_ok($$UPDATE public.apps SET serving_regions = ARRAY['EU',NULL] WHERE app_id = 'com.example.serving.sql'$$, '23514', NULL, 'rejects null entries');
SELECT throws_ok($$UPDATE public.apps SET serving_region_mode = 'other' WHERE app_id = 'com.example.serving.sql'$$, '23514', NULL, 'rejects invalid mode');
SELECT throws_ok($$UPDATE public.apps SET serving_regions = NULL WHERE app_id = 'com.example.serving.sql'$$, '23502', NULL, 'rejects null list');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_depend d ON d.classid='pg_constraint'::regclass AND d.objid=c.oid AND d.refclassid='pg_proc'::regclass
  JOIN pg_proc p ON p.oid=d.refobjid
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE c.conrelid='public.apps'::regclass AND c.conname='apps_serving_regions_valid' AND n.nspname <> 'pg_catalog'
),'serving policy constraint installs on subscribers without custom SQL helpers');
DELETE FROM public.plugin_state_sync_pending WHERE app_id = 'com.example.serving.sql';
DELETE FROM public.serving_policy_sync_pending WHERE app_id = 'com.example.serving.sql';
DELETE FROM public.updates_cache_purge_pending WHERE app_id = 'com.example.serving.sql';
UPDATE public.apps SET serving_regions = ARRAY['NA','HK'], serving_region_mode = 'block' WHERE app_id = 'com.example.serving.sql';
SELECT is((SELECT count(*)::integer FROM public.plugin_state_sync_pending WHERE app_id = 'com.example.serving.sql'), 0, 'unchanged policy does not enqueue state sync');
SELECT is((SELECT count(*)::integer FROM public.updates_cache_purge_pending WHERE app_id = 'com.example.serving.sql'), 0, 'unchanged policy does not invalidate edge cache');
UPDATE public.apps SET serving_regions = ARRAY['NA'], serving_region_mode = 'route' WHERE app_id = 'com.example.serving.sql';
SELECT ok(EXISTS(SELECT 1 FROM public.serving_policy_sync_pending WHERE app_id = 'com.example.serving.sql'), 'policy change enqueues independent policy sync');
SELECT ok(EXISTS(SELECT 1 FROM public.updates_cache_purge_pending WHERE app_id = 'com.example.serving.sql'), 'policy change invalidates edge cache');
SELECT * FROM finish();
ROLLBACK;
