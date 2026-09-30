-- cleanup_old_channel_devices only expires overrides a device assigned to
-- itself through /channel_self; console/API overrides are never deleted.
BEGIN;

SELECT plan(10);

SELECT
    has_column(
        'public',
        'channel_devices',
        'is_self_set',
        'channel_devices has is_self_set'
    );

SELECT
    col_default_is(
        'public',
        'channel_devices',
        'is_self_set',
        'false',
        'is_self_set defaults to false (keep) for existing and admin rows'
    );

-- Fixtures on the seeded demo app (private channel 2 accepts overrides).
INSERT INTO public.channel_devices (
    channel_id,
    app_id,
    device_id,
    owner_org,
    is_self_set,
    created_at,
    updated_at
)
SELECT
    2 AS channel_id,
    'com.demo.app' AS app_id,
    fixture.device_id,
    apps.owner_org,
    fixture.is_self_set,
    now() - fixture.age AS created_at,
    now() - fixture.age AS updated_at
FROM public.apps
CROSS JOIN (
    VALUES
    ('self-set-stale-device', true, interval '91 days'),
    ('self-set-fresh-device', true, interval '10 days'),
    ('admin-stale-device', false, interval '400 days'),
    ('admin-fresh-device', false, interval '1 day')
) AS fixture (device_id, is_self_set, age)
WHERE apps.app_id = 'com.demo.app';

INSERT INTO public.channel_devices (channel_id, app_id, device_id, owner_org)
SELECT
    2 AS channel_id,
    'com.demo.app' AS app_id,
    'default-origin-device' AS device_id,
    owner_org
FROM public.apps
WHERE app_id = 'com.demo.app';

SELECT
    is(
        (
            SELECT is_self_set
            FROM public.channel_devices
            WHERE
                app_id = 'com.demo.app' AND device_id = 'default-origin-device'
        ),
        false,
        'rows inserted without is_self_set are admin overrides'
    );

SELECT lives_ok(
    'SELECT public.cleanup_old_channel_devices()',
    'cleanup_old_channel_devices runs'
);

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM public.channel_devices
            WHERE
                app_id = 'com.demo.app' AND device_id = 'self-set-stale-device'
        ),
        'stale self-set override is expired'
    );

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM public.channel_devices
            WHERE
                app_id = 'com.demo.app' AND device_id = 'self-set-fresh-device'
        ),
        'recently refreshed self-set override is kept'
    );

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM public.channel_devices
            WHERE app_id = 'com.demo.app' AND device_id = 'admin-stale-device'
        ),
        'old console/API override is never expired'
    );

SELECT
    is(
        (
            SELECT channel_device_count
            FROM public.apps
            WHERE app_id = 'com.demo.app'
        ),
        (
            SELECT count(*)::bigint
            FROM public.channel_devices
            WHERE app_id = 'com.demo.app'
        ),
        'channel_device_count is recalculated after cleanup'
    );

-- A console/API write through PostgREST (authenticated role) turns a self-set
-- override into an admin override, even if the payload asks for self-set.
SELECT tests.authenticate_as('test_user');

UPDATE public.channel_devices
SET is_self_set = true
WHERE app_id = 'com.demo.app' AND device_id = 'self-set-fresh-device';

SELECT tests.clear_authentication();
RESET ROLE;

SELECT
    is(
        (
            SELECT is_self_set
            FROM public.channel_devices
            WHERE
                app_id = 'com.demo.app' AND device_id = 'self-set-fresh-device'
        ),
        false,
        'authenticated writes always store an admin override'
    );

-- Age the row past the retention window (moddatetime would reset updated_at).
ALTER TABLE public.channel_devices DISABLE TRIGGER handle_updated_at;
UPDATE public.channel_devices
SET updated_at = now() - interval '200 days'
WHERE app_id = 'com.demo.app' AND device_id = 'self-set-fresh-device';
ALTER TABLE public.channel_devices ENABLE TRIGGER handle_updated_at;

SELECT public.cleanup_old_channel_devices();

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM public.channel_devices
            WHERE
                app_id = 'com.demo.app' AND device_id = 'self-set-fresh-device'
        ),
        'override taken over by the console is no longer expired'
    );

SELECT * FROM finish();

ROLLBACK;
