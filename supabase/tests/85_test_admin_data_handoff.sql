BEGIN;
SELECT plan(9);

SELECT has_table(
    'public',
    'daily_revenue_metrics',
    'Revenue history remains available until reconciliation is verified'
);
SELECT hasnt_table(
    'public',
    'trial_extension_events',
    'Trial extension history is owned by the admin dashboard'
);
SELECT hasnt_table(
    'public',
    'stripe_refunds',
    'Refund history is owned by the admin dashboard'
);
SELECT hasnt_table(
    'public',
    'builder_capacity_events',
    'Builder capacity history is owned by the admin dashboard'
);
SELECT hasnt_table(
    'public',
    'cli_usage',
    'CLI usage no longer falls back to Postgres'
);
SELECT hasnt_function(
    'public',
    'record_trial_extension_event',
    ARRAY[]::text[],
    'The trial history trigger function is removed'
);
SELECT ok(
    NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE
            tgrelid = 'public.stripe_info'::regclass
            AND tgname = 'record_trial_extension_event_on_stripe_info'
    ),
    'Stripe updates no longer run the admin history trigger'
);
SELECT has_table(
    'public',
    'stripe_info',
    'Stripe business state remains available'
);
SELECT has_table(
    'public',
    'processed_stripe_events',
    'Stripe webhook deduplication remains available'
);

SELECT finish();
ROLLBACK;
