BEGIN;

SELECT plan(2);

DELETE FROM public.daily_version
WHERE app_id = 'com.test.getweeklystatswindow.app';

-- Inside the 7-day inclusive window: today and 6 days ago.
INSERT INTO public.daily_version (
    date,
    app_id,
    version_name,
    get,
    fail,
    install,
    uninstall
)
VALUES
    (
        CURRENT_DATE,
        'com.test.getweeklystatswindow.app',
        '1.0.0',
        0,
        1,
        10,
        0
    ),
    (
        CURRENT_DATE - 6,
        'com.test.getweeklystatswindow.app',
        '1.0.0',
        0,
        2,
        20,
        0
    ),
    -- Outside the window: 7 days ago must be excluded.
    (
        CURRENT_DATE - 7,
        'com.test.getweeklystatswindow.app',
        '1.0.0',
        0,
        99,
        999,
        0
    );

SELECT is(
    (
        SELECT all_updates
        FROM public.get_weekly_stats(
            'com.test.getweeklystatswindow.app'
        )
    ),
    30::bigint,
    'get_weekly_stats sums installs for today and previous 6 days only'
);

SELECT is(
    (
        SELECT failed_updates
        FROM public.get_weekly_stats(
            'com.test.getweeklystatswindow.app'
        )
    ),
    3::bigint,
    'get_weekly_stats excludes fails from 7 days ago'
);

SELECT * FROM finish();

ROLLBACK;
