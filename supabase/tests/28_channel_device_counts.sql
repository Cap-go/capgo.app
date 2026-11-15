BEGIN;


SELECT plan(9);

-- seed.sql enqueues channel_device_counts deltas. pg_cron usually drains
-- them before this file runs, but not when tests start right after the
-- seed, and then the processor calls below pick up seed messages too.
-- Drain first; the ROLLBACK at the end undoes it.
DO $$
BEGIN
    PERFORM public.process_channel_device_counts_queue(1000);
END
$$;

CREATE TEMP TABLE tmp_channel_device_counts AS
SELECT channel_device_count AS base_count
FROM
    public.apps
WHERE
    app_id = 'com.demo.app';

SELECT
    is(
        (
            SELECT count(*)
            FROM
                tmp_channel_device_counts
        ),
        1::bigint,
        'Seed app count captured'
    );

SELECT
    is(
        (
            SELECT base_count
            FROM
                tmp_channel_device_counts
        ),
        (
            SELECT count(*)::bigint
            FROM
                public.channel_devices
            WHERE
                app_id = 'com.demo.app'
        ),
        'Base counter matches existing channel_devices rows'
    );

INSERT INTO
public.channel_devices (channel_id, app_id, device_id, owner_org)
SELECT
    id,
    app_id,
    'queue-test-device',
    owner_org
FROM
    public.channels
WHERE
    app_id = 'com.demo.app'
LIMIT
    1;

SELECT
    is(
        (
            SELECT channel_device_count
            FROM
                public.apps
            WHERE
                app_id = 'com.demo.app'
        ),
        (
            SELECT base_count
            FROM
                tmp_channel_device_counts
        ),
        'Counter unchanged before queue processing'
    );

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM
                pgmq.q_channel_device_counts
            WHERE
                message ->> 'device_id' = 'queue-test-device'
                AND (message ->> 'delta')::integer = 1
        ),
        'Insert enqueues +1 delta'
    );

SELECT
    is(
        public.process_channel_device_counts_queue(10),
        1::bigint,
        'Queue processor applies +1 delta'
    );

SELECT
    is(
        (
            SELECT channel_device_count
            FROM
                public.apps
            WHERE
                app_id = 'com.demo.app'
        ),
        (
            SELECT base_count + 1
            FROM
                tmp_channel_device_counts
        ),
        'Counter increments after processing'
    );

DELETE FROM public.channel_devices
WHERE
    app_id = 'com.demo.app'
    AND device_id = 'queue-test-device';

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM
                pgmq.q_channel_device_counts
            WHERE
                message ->> 'device_id' = 'queue-test-device'
                AND (message ->> 'delta')::integer = -1
        ),
        'Delete enqueues -1 delta'
    );

SELECT
    is(
        public.process_channel_device_counts_queue(10),
        1::bigint,
        'Queue processor applies -1 delta'
    );

SELECT
    is(
        (
            SELECT channel_device_count
            FROM
                public.apps
            WHERE
                app_id = 'com.demo.app'
        ),
        (
            SELECT base_count
            FROM
                tmp_channel_device_counts
        ),
        'Counter returns to base value'
    );

SELECT finish();

ROLLBACK;
