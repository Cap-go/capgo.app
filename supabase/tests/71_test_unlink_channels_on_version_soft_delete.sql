BEGIN;

SELECT plan(3);

CREATE OR REPLACE FUNCTION my_tests() RETURNS SETOF TEXT AS $$
DECLARE
  test_app_id text := 'com.test.unlink.deleted.channel';
  version_id bigint;
  channel_id bigint;
  rollout_version_id bigint;
BEGIN
  DELETE FROM public.channels WHERE app_id = test_app_id;
  DELETE FROM public.app_versions WHERE app_id = test_app_id;
  DELETE FROM public.apps WHERE app_id = test_app_id;

  INSERT INTO public.apps (app_id, name, icon_url, owner_org)
  VALUES (
    test_app_id,
    'Unlink deleted channel test',
    'https://example.com/icon.png',
    (SELECT owner_org FROM public.apps LIMIT 1)
  );

  INSERT INTO public.app_versions (app_id, name, storage_provider, owner_org, user_id)
  VALUES (
    test_app_id,
    '1.0.0',
    'r2',
    (SELECT owner_org FROM public.apps WHERE app_id = test_app_id),
    (SELECT id FROM auth.users LIMIT 1)
  )
  RETURNING id INTO version_id;

  INSERT INTO public.app_versions (app_id, name, storage_provider, owner_org, user_id)
  VALUES (
    test_app_id,
    '1.0.1',
    'r2',
    (SELECT owner_org FROM public.apps WHERE app_id = test_app_id),
    (SELECT id FROM auth.users LIMIT 1)
  )
  RETURNING id INTO rollout_version_id;

  PERFORM set_config('capgo.seed_channel_targets', 'true', true);

  INSERT INTO public.channels (
    created_at,
    name,
    app_id,
    version,
    rollout_version,
    updated_at,
    public,
    disable_auto_update_under_native,
    disable_auto_update,
    ios,
    android,
    allow_device_self_set,
    allow_emulator,
    allow_device,
    allow_dev,
    allow_prod,
    created_by,
    owner_org
  )
  VALUES (
    pg_catalog.now(),
    'production',
    test_app_id,
    version_id,
    rollout_version_id,
    pg_catalog.now(),
    true,
    true,
    'none'::public.disable_update,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    (SELECT id FROM auth.users LIMIT 1),
    (SELECT owner_org FROM public.apps WHERE app_id = test_app_id)
  )
  RETURNING id INTO channel_id;

  UPDATE public.app_versions
  SET deleted = true
  WHERE id = version_id;

  RETURN NEXT IS (
    (SELECT version FROM public.channels WHERE id = channel_id),
    NULL::bigint,
    'soft-delete clears channels.version'
  );

  RETURN NEXT IS (
    (SELECT rollout_version FROM public.channels WHERE id = channel_id),
    rollout_version_id,
    'soft-delete keeps unrelated rollout_version'
  );

  UPDATE public.app_versions
  SET deleted = true
  WHERE id = rollout_version_id;

  RETURN NEXT IS (
    (SELECT rollout_version FROM public.channels WHERE id = channel_id),
    NULL::bigint,
    'soft-delete clears channels.rollout_version'
  );

  UPDATE public.app_versions
  SET deleted_at = pg_catalog.now()
  WHERE id = version_id;

  RETURN NEXT ok(
    (SELECT version FROM public.channels WHERE id = channel_id) IS NULL,
    'deleted_at-only touch keeps channel.version cleared'
  );
END;
$$ LANGUAGE plpgsql;

SELECT * FROM my_tests();

SELECT * FROM finish();

ROLLBACK;
