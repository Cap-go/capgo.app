BEGIN;

SELECT plan(5);

SELECT is(
  (SELECT bundle_incompatible_alert FROM public.apps WHERE app_id = 'com.demo.app'),
  'default',
  'an existing app alerts only on the default upload channel'
);

SELECT is(
  (SELECT count(*)::integer FROM public.apps WHERE bundle_incompatible_alert IS DISTINCT FROM 'default'),
  0,
  'every existing app defaults to the default upload channel'
);

INSERT INTO public.apps (app_id, icon_url, owner_org, name)
SELECT 'com.bundlealert.new', icon_url, owner_org, 'Bundle alert new app'
FROM public.apps
WHERE app_id = 'com.demo.app';

SELECT is(
  (SELECT bundle_incompatible_alert FROM public.apps WHERE app_id = 'com.bundlealert.new'),
  'default',
  'a new app defaults to the default upload channel'
);

SELECT lives_ok(
  $$
    UPDATE public.apps
    SET bundle_incompatible_alert = 'all'
    WHERE app_id = 'com.bundlealert.new'
  $$,
  'all is a valid incompatible-bundle alert scope'
);

SELECT throws_ok(
  $$
    UPDATE public.apps
    SET bundle_incompatible_alert = 'staging'
    WHERE app_id = 'com.bundlealert.new'
  $$,
  '23514',
  'new row for relation "apps" violates check constraint "apps_bundle_incompatible_alert_check"',
  'rejects an alert scope other than default or all'
);

SELECT * FROM finish();

ROLLBACK;
