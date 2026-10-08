-- We create a test queue to test the queue consumer
SELECT
  pgmq.create ('test_queue_consumer');

-- Create secrets
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'admin_users') THEN
        PERFORM vault.create_secret('["c591b04e-cf29-4945-b9a0-776d0672061a"]', 'admin_users', 'admins user id');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'db_url') THEN
        -- Used by DB-side cron jobs to call edge functions. `kong:8000` is stable inside the local Docker network
        -- (unlike host-mapped ports which may differ per git worktree).
        PERFORM vault.create_secret('http://kong:8000', 'db_url', 'db url');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'CAPGO_MFA_EMAIL_OTP_ENFORCED_AT') THEN
        -- RFC3339 cutoff string. Empty means no enforcement cutoff by default.
        PERFORM vault.create_secret('', 'CAPGO_MFA_EMAIL_OTP_ENFORCED_AT', 'mfa email otp enforcement cutoff');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'apikey') THEN
        PERFORM vault.create_secret('testsecret', 'apikey', 'admin user id');
    END IF;

END $$;

-- We cannot use SET search_path = 'public, extensions' because the digest function is not available in the public schema
CREATE OR REPLACE FUNCTION "public"."reset_and_seed_data" () RETURNS "void" LANGUAGE "plpgsql"
SET
  search_path = '' SECURITY DEFINER AS $_$
DECLARE
    admin_manual_grant_id uuid;
    admin_top_up_grant_id uuid;
    demo_top_up_grant_id uuid;
    admin_bandwidth_overage_id uuid;
    demo_mau_overage_id uuid;
BEGIN
    -- Tinbase evaluates seed statements as anon. This service-role-only seed
    -- helper marks its trusted channel targets for the promotion trigger.
    PERFORM pg_catalog.set_config('capgo.seed_channel_targets', 'true', true);
    -- Suppress cascade notices during truncation
    SET LOCAL client_min_messages = WARNING;

    -- Truncate main parent tables - CASCADE will handle dependencies
    TRUNCATE TABLE "auth"."users" CASCADE;
    TRUNCATE TABLE "storage"."buckets" CASCADE;
    TRUNCATE TABLE "public"."stripe_info" CASCADE;
    TRUNCATE TABLE "public"."plans" CASCADE;
    TRUNCATE TABLE "public"."capgo_credits_steps" CASCADE;
    TRUNCATE TABLE "public"."usage_credit_grants" CASCADE;
    TRUNCATE TABLE "public"."usage_credit_transactions" CASCADE;
    TRUNCATE TABLE "public"."usage_credit_consumptions" CASCADE;
    TRUNCATE TABLE "public"."usage_overage_events" CASCADE;
    TRUNCATE TABLE "public"."org_id_tombstones";
    -- RBAC tables: must truncate in order to respect foreign keys
    TRUNCATE TABLE "public"."role_bindings" RESTART IDENTITY CASCADE;
    TRUNCATE TABLE "public"."group_members" RESTART IDENTITY CASCADE;
    TRUNCATE TABLE "public"."groups" RESTART IDENTITY CASCADE;
    -- Insert seed data
    -- (Include all your INSERT statements here)

    -- Seed data
    INSERT INTO "auth"."users" ("instance_id", "id", "aud", "role", "email", "encrypted_password", "email_confirmed_at", "invited_at", "confirmation_token", "confirmation_sent_at", "recovery_token", "recovery_sent_at", "email_change_token_new", "email_change", "email_change_sent_at", "last_sign_in_at", "raw_app_meta_data", "raw_user_meta_data", "is_super_admin", "created_at", "updated_at", "phone", "phone_confirmed_at", "phone_change", "phone_change_token", "phone_change_sent_at", "email_change_token_current", "email_change_confirm_status", "banned_until", "reauthentication_token", "reauthentication_sent_at") VALUES
    ('00000000-0000-0000-0000-000000000000', 'c591b04e-cf29-4945-b9a0-776d0672061a', 'authenticated', 'authenticated', 'admin@capgo.app', '$2a$10$I4wgil64s1Kku/7aUnCOVuc1W5nCAeeKvHMiSKk10jo1J5fSVkK1S', NOW(), NOW(), 'oljikwwipqrkwilfsyto', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_admin"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', '6aa76066-55ef-4238-ade6-0b32334a4097', 'authenticated', 'authenticated', 'test@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsyty', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_user"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', 'authenticated', 'authenticated', 'test2@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsytt', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_user2"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', '11111111-1111-4111-8111-111111111110', 'authenticated', 'authenticated', 'nonmember@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsytn', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_nonmember"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d', 'authenticated', 'authenticated', 'stats@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsyts', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_stats"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', 'authenticated', 'authenticated', 'rls@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsytr', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_rls"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a81', 'authenticated', 'authenticated', 'cli_hashed@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsytc', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_cli_hashed"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708193', 'authenticated', 'authenticated', 'encrypted@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsyte', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_encrypted"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', '9f1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5061', 'authenticated', 'authenticated', 'emailprefs@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsytp', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_email_prefs"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', 'af1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5062', 'authenticated', 'authenticated', 'apikey-expiration@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsytq', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_apikey_expiration"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', 'd0f1a2b3-c4d5-4e6f-8a90-b1c2d3e4f506', 'authenticated', 'authenticated', 'apikey-management@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsytm', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_apikey_management"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', 'b7a1d9f4-7b8f-4e3c-8f2b-1a2b3c4d5e6f', 'authenticated', 'authenticated', 'delete-user-stale@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsyu1', NOW(), '', NULL, '', '', NULL, NOW() - interval '10 minutes', '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_delete_user_stale"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', 'c8b2e0f5-8c90-4f4d-9f3c-2b3c4d5e6f70', 'authenticated', 'authenticated', 'delete-user-fresh@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsyu2', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "test_delete_user_fresh"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', 'f8e7d6c5-b4a3-4291-8f7e-6d5c4b3a2910', 'authenticated', 'authenticated', 'jwt-mfa-edge-apikey@capgo.app', '$2a$10$0CErXxryZPucjJWq3O7qXeTJgN.tnNU5XCZy9pXKDWRi/aS9W7UFi', NOW(), NOW(), 'oljikwwipqrkwilfsyu3', NOW(), '', NULL, '', '', NULL, NOW(), '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "jwt_mfa_edge_apikey"}', 'f', NOW(), NOW(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL);

    INSERT INTO "public"."deleted_account" ("created_at", "email", "id") VALUES
    (NOW(), encode(extensions.digest('deleted@capgo.app'::bytea, 'sha256'::text)::bytea, 'hex'::text), '00000000-0000-0000-0000-000000000001');

    INSERT INTO "public"."plans" ("created_at", "updated_at", "name", "description", "price_m", "price_y", "stripe_id", "credit_id", "id", "price_m_id", "price_y_id", "storage", "bandwidth", "mau", "market_desc", "build_time_unit", "native_build_concurrency") VALUES
    (NOW(), NOW(), 'Maker', 'plan.maker.desc', 39, 396, 'prod_LQIs1Yucml9ChU', 'prod_TJRd2hFHZsBIPK', '440cfd69-0cfd-486e-b59b-cb99f7ae76a0', 'price_1KjSGyGH46eYKnWwL4h14DsK', 'price_1KjSKIGH46eYKnWwFG9u4tNi', 3221225472, 268435456000, 10000, 'Best for small business owners', 7200, 3),
    (NOW(), NOW(), 'Enterprise', 'plan.payasyougo.desc', 249, 2490, 'prod_MH5Jh6ajC9e7ZH', 'prod_TJRd2hFHZsBIPK', '745d7ab3-6cd6-4d65-b257-de6782d5ba50', 'price_1LYX8yGH46eYKnWwzeBjISvW', 'price_1LYX8yGH46eYKnWwzeBjISvW', 12884901888, 3221225472000, 1000000, 'Best for scalling enterprises', 1200000, 6),
    (NOW(), NOW(), 'Solo', 'plan.solo.desc', 14, 146, 'prod_LQIregjtNduh4q', 'prod_TJRd2hFHZsBIPK', '526e11d8-3c51-4581-ac92-4770c602f47c', 'price_1LVvuZGH46eYKnWwuGKOf4DK', 'price_1LVvuIGH46eYKnWwHMDCrxcH', 1073741824, 13958643712, 2000, 'Best for independent developers', 3600, 2),
    (NOW(), NOW(), 'Team', 'plan.team.desc', 99, 998, 'prod_LQIugvJcPrxhda', 'prod_TJRd2hFHZsBIPK', 'abd76414-8f90-49a5-b3a4-8ff4d2e12c77', 'price_1KjSIUGH46eYKnWwWHvg8XYs', 'price_1KjSLlGH46eYKnWwAwMW2wiW', 6442450944, 536870912000, 100000, 'Best for medium enterprises', 36000, 4);

    INSERT INTO
      "public"."capgo_credits_steps" (
        type,
        step_min,
        step_max,
        price_per_unit,
        unit_factor,
        org_id
      )
    VALUES
      ('mau', 0, 1000000, 0.003, 1, NULL),
      ('mau', 1000000, 3000000, 0.0003, 1, NULL),
      ('mau', 3000000, 6000000, 0.00025, 1, NULL),
      ('mau', 6000000, 10000000, 0.0002, 1, NULL),
      ('mau', 10000000, 25000000, 0.00018, 1, NULL),
      ('mau', 25000000, 100000000, 0.00015, 1, NULL),
      ('mau', 100000000, 9223372036854775807, 0.0001, 1, NULL),
      ('bandwidth', 0, 1099511627776, 0.06, 1073741824, NULL), -- 0–1 TB
      (
        'bandwidth',
        1099511627776,
        2199023255552,
        0.05,
        1073741824,
        NULL
      ), -- 1–2 TB
      (
        'bandwidth',
        2199023255552,
        6597069766656,
        0.0425,
        1073741824,
        NULL
      ), -- 2–6 TB
      (
        'bandwidth',
        6597069766656,
        13194139533312,
        0.035,
        1073741824,
        NULL
      ), -- 6–12 TB
      (
        'bandwidth',
        13194139533312,
        27487790694400,
        0.0275,
        1073741824,
        NULL
      ), -- 12–25 TB
      (
        'bandwidth',
        27487790694400,
        69269232549888,
        0.02,
        1073741824,
        NULL
      ), -- 25–63 TB
      (
        'bandwidth',
        69269232549888,
        109951162777600,
        0.015,
        1073741824,
        NULL
      ), -- 63–100 TB
      (
        'bandwidth',
        109951162777600,
        274877906944000,
        0.008,
        1073741824,
        NULL
      ), -- 100–250 TB
      (
        'bandwidth',
        274877906944000,
        549755813888000,
        0.006,
        1073741824,
        NULL
      ), -- 250–500 TB
      (
        'bandwidth',
        549755813888000,
        1125899906842624,
        0.005,
        1073741824,
        NULL
      ), -- 500 TB–1 PB
      (
        'bandwidth',
        1125899906842624,
        9223372036854775807,
        0.004,
        1073741824,
        NULL
      ), -- 1+ PB
      ('storage', 0, 1073741824, 0.09, 1073741824, NULL), -- 0–1 GiB
      (
        'storage',
        1073741824,
        6442450944,
        0.08,
        1073741824,
        NULL
      ), -- 1–6 GiB
      (
        'storage',
        6442450944,
        26843545600,
        0.065,
        1073741824,
        NULL
      ), -- 6–25 GiB
      (
        'storage',
        26843545600,
        67645734912,
        0.05,
        1073741824,
        NULL
      ), -- 25–63 GiB
      (
        'storage',
        67645734912,
        268435456000,
        0.04,
        1073741824,
        NULL
      ), -- 63–250 GiB
      (
        'storage',
        268435456000,
        687194767360,
        0.03,
        1073741824,
        NULL
      ), -- 250–640 GiB
      (
        'storage',
        687194767360,
        1374389534720,
        0.025,
        1073741824,
        NULL
      ), -- 640–1280 GiB
      (
        'storage',
        1374389534720,
        9223372036854775807,
        0.021,
        1073741824,
        NULL
      ), -- 1280+ GiB
      ('build_time', 0, 6000, 0.08, 60, NULL), -- 0-100 minutes (in seconds, displayed as minutes)
      ('build_time', 6000, 30000, 0.07, 60, NULL), -- 100-500 minutes (in seconds, displayed as minutes)
      ('build_time', 30000, 60000, 0.06, 60, NULL), -- 500-1000 minutes (in seconds, displayed as minutes)
      ('build_time', 60000, 300000, 0.05, 60, NULL), -- 1000-5000 minutes (in seconds, displayed as minutes)
      ('build_time', 300000, 600000, 0.045, 60, NULL), -- 5000-10000 minutes (in seconds, displayed as minutes)
      ('build_time', 600000, 9223372036854775807, 0.04, 60, NULL); -- 10000+ minutes (in seconds, displayed as minutes)

    INSERT INTO "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public") VALUES
    ('capgo', 'capgo', NULL, NOW(), NOW(), 't'),
    ('apps', 'apps', NULL, NOW(), NOW(), 'f'),
    ('images', 'images', NULL, NOW(), NOW(), 'f');

    INSERT INTO "public"."stripe_info" (
      "created_at",
      "updated_at",
      "subscription_id",
      "customer_id",
      "status",
      "product_id",
      "trial_at",
      "price_id",
      "is_good_plan",
      "plan_usage",
      "subscription_anchor_start",
      "subscription_anchor_end",
      "mau_exceeded",
      "bandwidth_exceeded",
      "storage_exceeded",
      "build_time_exceeded"
    ) VALUES
    (NOW(), NOW(), 'sub_1', 'cus_Pa0k8TO6HVln6A', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_2', 'cus_Q38uE91NP8Ufqc', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_3', 'cus_Pa0f3M6UCQ8g5Q', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_4', 'cus_NonOwner', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_5', 'cus_StatsTest', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_rls', 'cus_RLSTest', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_2fa_rls', 'cus_2fa_rls_test_123', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_cli_hashed', 'cus_cli_hashed_test_123', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_encrypted', 'cus_encrypted_test_123', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_email_prefs', 'cus_email_prefs_test_123', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_cron_app', 'cus_cron_app_test_123', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_cron_integration', 'cus_cron_integration_test_123', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_cron_queue', 'cus_cron_queue_test_123', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_overage', 'cus_overage_test_123', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false),
    (NOW(), NOW(), 'sub_apikey_management', 'cus_apikey_management_test_123', 'succeeded', 'prod_LQIregjtNduh4q', CURRENT_DATE + interval '15 days', NULL, 't', 2, NOW() - interval '15 days', NOW() + interval '15 days', false, false, false, false);

    INSERT INTO "public"."users" ("created_at", "image_url", "first_name", "last_name", "country", "email", "id", "updated_at", "enable_notifications", "opt_for_newsletters") VALUES
    ('2022-06-03 05:54:15+00', '', 'admin', 'Capgo', NULL, 'admin@capgo.app', 'c591b04e-cf29-4945-b9a0-776d0672061a', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'test', 'Capgo', NULL, 'test@capgo.app', '6aa76066-55ef-4238-ade6-0b32334a4097', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'test2', 'Capgo', NULL, 'test2@capgo.app', '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'nonmember', 'Capgo', NULL, 'nonmember@capgo.app', '11111111-1111-4111-8111-111111111110', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'stats', 'Capgo', NULL, 'stats@capgo.app', '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'rls', 'Capgo', NULL, 'rls@capgo.app', '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'cli_hashed', 'Capgo', NULL, 'cli_hashed@capgo.app', 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a81', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'encrypted', 'Capgo', NULL, 'encrypted@capgo.app', 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708193', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'emailprefs', 'Capgo', NULL, 'emailprefs@capgo.app', '9f1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5061', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'apikey', 'expiration', NULL, 'apikey-expiration@capgo.app', 'af1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5062', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'apikey', 'management', NULL, 'apikey-management@capgo.app', 'd0f1a2b3-c4d5-4e6f-8a90-b1c2d3e4f506', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'delete', 'stale', NULL, 'delete-user-stale@capgo.app', 'b7a1d9f4-7b8f-4e3c-8f2b-1a2b3c4d5e6f', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'delete', 'fresh', NULL, 'delete-user-fresh@capgo.app', 'c8b2e0f5-8c90-4f4d-9f3c-2b3c4d5e6f70', NOW(), 't', 't'),
    ('2022-06-03 05:54:15+00', '', 'jwt', 'mfa-edge', NULL, 'jwt-mfa-edge-apikey@capgo.app', 'f8e7d6c5-b4a3-4291-8f7e-6d5c4b3a2910', NOW(), 't', 't');

    ALTER TABLE public.orgs DISABLE TRIGGER generate_org_user_stripe_info_on_org_create;
    INSERT INTO "public"."orgs" ("id", "created_by", "created_at", "updated_at", "logo", "name", "management_email", "customer_id") VALUES
    ('22dbad8a-b885-4309-9b3b-a09f8460fb6d', 'c591b04e-cf29-4945-b9a0-776d0672061a', NOW(), NOW(), '', 'Admin org', 'admin@capgo.app', 'cus_Pa0k8TO6HVln6A'),
    ('046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', NOW(), NOW(), '', 'Demo org', 'test@capgo.app', 'cus_Q38uE91NP8Ufqc'),
    ('34a8c55d-2d0f-4652-a43f-684c7a9403ac', '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', NOW(), NOW(), '', 'Test2 org', 'test2@capgo.app', 'cus_Pa0f3M6UCQ8g5Q'),
    ('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', NOW(), NOW(), '', 'Non-Owner Org', 'test2@capgo.app', 'cus_NonOwner'),
    ('b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d', NOW(), NOW(), '', 'Stats Test Org', 'stats@capgo.app', 'cus_StatsTest'),
    ('c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', NOW(), NOW(), '', 'RLS Test Org', 'rls@capgo.app', 'cus_RLSTest'),
    ('d5e6f7a8-b9c0-4d1e-8f2a-3b4c5d6e7f80', '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', NOW(), NOW(), '', 'RLS 2FA Test Org', 'rls@capgo.app', 'cus_2fa_rls_test_123'),
    ('f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b92', 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a81', NOW(), NOW(), '', 'CLI Hashed Test Org', 'cli_hashed@capgo.app', 'cus_cli_hashed_test_123'),
    ('a7b8c9d0-e1f2-4a3b-9c4d-5e6f7a8b9ca4', 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708193', NOW(), NOW(), '', 'Encrypted Test Org', 'encrypted@capgo.app', 'cus_encrypted_test_123'),
    ('aa1b2c3d-4e5f-4a60-9b7c-1d2e3f4a5061', '9f1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5061', NOW(), NOW(), '', 'Email Prefs Test Org', 'emailprefs@capgo.app', 'cus_email_prefs_test_123'),
    ('b1c2d3e4-f5a6-4b70-8c9d-0e1f2a3b4c5d', '6aa76066-55ef-4238-ade6-0b32334a4097', NOW(), NOW(), '', 'Cron App Test Org', 'test@capgo.app', 'cus_cron_app_test_123'),
    ('c2d3e4f5-a6b7-4c80-9d0e-1f2a3b4c5d6e', '6aa76066-55ef-4238-ade6-0b32334a4097', NOW(), NOW(), '', 'Cron Integration Test Org', 'test@capgo.app', 'cus_cron_integration_test_123'),
    ('d3e4f5a6-b7c8-4d90-8e1f-2a3b4c5d6e7f', '6aa76066-55ef-4238-ade6-0b32334a4097', NOW(), NOW(), '', 'Cron Queue Test Org', 'test@capgo.app', 'cus_cron_queue_test_123'),
    ('e4f5a6b7-c8d9-4ea0-9f1a-2b3c4d5e6f70', '6aa76066-55ef-4238-ade6-0b32334a4097', NOW(), NOW(), '', 'Overage Test Org', 'test@capgo.app', 'cus_overage_test_123'),
    ('e5f6a7b8-c9d0-4e1f-9a2b-3c4d5e6f7a82', '6aa76066-55ef-4238-ade6-0b32334a4097', NOW(), NOW(), '', 'Private Error Test Org', 'test@capgo.app', NULL),
    ('f1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a50', 'd0f1a2b3-c4d5-4e6f-8a90-b1c2d3e4f506', NOW(), NOW(), '', 'API Key Management Test Org', 'apikey-management@capgo.app', 'cus_apikey_management_test_123'),
    ('a9b8c7d6-e5f4-4321-9876-543210fedcba', 'f8e7d6c5-b4a3-4291-8f7e-6d5c4b3a2910', NOW(), NOW(), '', 'JWT MFA Edge Test Org', 'jwt-mfa-edge-apikey@capgo.app', NULL),
    ('b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0dc7', '6aa76066-55ef-4238-ade6-0b32334a4097', NOW(), NOW(), '', 'Credit Auto Top-Up Test Org', 'test@capgo.app', NULL);
    ALTER TABLE public.orgs ENABLE TRIGGER generate_org_user_stripe_info_on_org_create;

    INSERT INTO public.usage_credit_grants (
      org_id,
      credits_total,
      credits_consumed,
      granted_at,
      expires_at,
      source,
      source_ref,
      notes
    )
    VALUES
      (
        '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
        1000,
        275,
        NOW() - interval '45 days',
        NOW() + interval '6 months',
        'manual',
        '{}'::jsonb,
        'Seed usage credits for admin org'
      )
    RETURNING id INTO admin_manual_grant_id;

    INSERT INTO public.usage_credit_grants (
      org_id,
      credits_total,
      credits_consumed,
      granted_at,
      expires_at,
      source,
      source_ref,
      notes
    )
    VALUES (
      '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
      250,
      0,
      NOW() - interval '14 days',
      NOW() + interval '8 months',
      'stripe_top_up',
      jsonb_build_object('paymentIntentId', 'pi_seed_top_up_admin'),
      'Stripe top-up seed for admin org'
    )
    RETURNING id INTO admin_top_up_grant_id;

    INSERT INTO public.usage_credit_grants (
      org_id,
      credits_total,
      credits_consumed,
      granted_at,
      expires_at,
      source,
      source_ref,
      notes
    )
    VALUES (
      '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
      500,
      120,
      NOW() - interval '10 days',
      NOW() + interval '3 months',
      'stripe_top_up',
      jsonb_build_object('paymentIntentId', 'pi_seed_top_up_demo'),
      'Seed usage credits for demo org'
    )
    RETURNING id INTO demo_top_up_grant_id;

    -- Seed realistic credit transactions so the Credits view has ledger data
    INSERT INTO public.usage_overage_events (
      org_id,
      metric,
      overage_amount,
      credits_estimated,
      credits_debited,
      billing_cycle_start,
      billing_cycle_end,
      details
    )
    VALUES
      (
        '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
        'bandwidth',
        2684354560,
        275,
        275,
        date_trunc('month', NOW()) - interval '1 month',
        date_trunc('month', NOW()),
        jsonb_build_object('note', 'Bandwidth spike from heavy release week')
      )
    RETURNING id INTO admin_bandwidth_overage_id;

    INSERT INTO public.usage_overage_events (
      org_id,
      metric,
      overage_amount,
      credits_estimated,
      credits_debited,
      billing_cycle_start,
      billing_cycle_end,
      details
    )
    VALUES
      (
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
        'mau',
        185000,
        555,
        120,
        date_trunc('month', NOW()),
        date_trunc('month', NOW()) + interval '1 month',
        jsonb_build_object('note', 'Promo traffic pushed MAU above plan')
      )
    RETURNING id INTO demo_mau_overage_id;

    INSERT INTO public.usage_credit_consumptions (
      grant_id,
      org_id,
      overage_event_id,
      metric,
      credits_used,
      applied_at
    )
    VALUES
      (
        admin_manual_grant_id,
        '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
        admin_bandwidth_overage_id,
        'bandwidth',
        275,
        NOW() - interval '5 days'
      ),
      (
        demo_top_up_grant_id,
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
        demo_mau_overage_id,
        'mau',
        120,
        NOW() - interval '1 day'
      );

    INSERT INTO public.usage_credit_transactions (
      org_id,
      grant_id,
      transaction_type,
      amount,
      balance_after,
      occurred_at,
      description,
      source_ref
    )
    VALUES
      (
        '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
        admin_manual_grant_id,
        'manual_grant',
        1000,
        1000,
        NOW() - interval '45 days',
        'Manual starter credits from support',
        jsonb_build_object('notes', 'Initial seed allocation')
      ),
      (
        '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
        admin_top_up_grant_id,
        'purchase',
        250,
        1250,
        NOW() - interval '14 days',
        'Stripe top-up: 250 credits',
        jsonb_build_object('paymentIntentId', 'pi_seed_top_up_admin', 'sessionId', 'cs_test_seed_admin')
      ),
      (
        '22dbad8a-b885-4309-9b3b-a09f8460fb6d',
        admin_manual_grant_id,
        'deduction',
        -275,
        975,
        NOW() - interval '5 days',
        'Overage deduction for bandwidth usage',
        jsonb_build_object('overage_event_id', admin_bandwidth_overage_id, 'metric', 'bandwidth')
      ),
      (
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
        demo_top_up_grant_id,
        'purchase',
        500,
        500,
        NOW() - interval '10 days',
        'Stripe top-up: 500 credits',
        jsonb_build_object('paymentIntentId', 'pi_seed_top_up_demo', 'sessionId', 'cs_test_seed_demo')
      ),
      (
        '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
        demo_top_up_grant_id,
        'deduction',
        -120,
        380,
        NOW() - interval '1 day',
        'Overage deduction for MAU spike',
        jsonb_build_object('overage_event_id', demo_mau_overage_id, 'metric', 'mau')
      );

    INSERT INTO "public"."org_users" ("org_id", "user_id", "rbac_role_name", "app_id", "channel_id", "is_invite") VALUES
    ('22dbad8a-b885-4309-9b3b-a09f8460fb6d', 'c591b04e-cf29-4945-b9a0-776d0672061a', public.rbac_role_org_super_admin(), null, null, false),
    ('046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', public.rbac_role_org_super_admin(), null, null, false),
    ('34a8c55d-2d0f-4652-a43f-684c7a9403ac', '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', public.rbac_role_org_super_admin(), null, null, false),
    ('046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', public.rbac_role_org_member(), null, null, false),
    ('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', '6aa76066-55ef-4238-ade6-0b32334a4097', public.rbac_role_org_member(), null, null, false),
    ('b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d', public.rbac_role_org_super_admin(), null, null, false),
    ('c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', public.rbac_role_org_super_admin(), null, null, false),
    ('d5e6f7a8-b9c0-4d1e-8f2a-3b4c5d6e7f80', '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', public.rbac_role_org_super_admin(), null, null, false),
    ('f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b92', 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a81', public.rbac_role_org_super_admin(), null, null, false),
    ('046a36ac-e03c-4590-9257-bd6c9dba9ee8', 'c591b04e-cf29-4945-b9a0-776d0672061a', public.rbac_role_org_admin(), null, null, false),
    ('34a8c55d-2d0f-4652-a43f-684c7a9403ac', '6aa76066-55ef-4238-ade6-0b32334a4097', public.rbac_role_org_member(), null, null, false),
    ('a7b8c9d0-e1f2-4a3b-9c4d-5e6f7a8b9ca4', 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708193', public.rbac_role_org_super_admin(), null, null, false),
    ('aa1b2c3d-4e5f-4a60-9b7c-1d2e3f4a5061', '9f1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5061', public.rbac_role_org_super_admin(), null, null, false),
    ('b1c2d3e4-f5a6-4b70-8c9d-0e1f2a3b4c5d', '6aa76066-55ef-4238-ade6-0b32334a4097', public.rbac_role_org_super_admin(), null, null, false),
    ('c2d3e4f5-a6b7-4c80-9d0e-1f2a3b4c5d6e', '6aa76066-55ef-4238-ade6-0b32334a4097', public.rbac_role_org_super_admin(), null, null, false),
    ('d3e4f5a6-b7c8-4d90-8e1f-2a3b4c5d6e7f', '6aa76066-55ef-4238-ade6-0b32334a4097', public.rbac_role_org_super_admin(), null, null, false),
    ('e4f5a6b7-c8d9-4ea0-9f1a-2b3c4d5e6f70', '6aa76066-55ef-4238-ade6-0b32334a4097', public.rbac_role_org_super_admin(), null, null, false),
    ('e5f6a7b8-c9d0-4e1f-9a2b-3c4d5e6f7a82', '6aa76066-55ef-4238-ade6-0b32334a4097', public.rbac_role_org_super_admin(), null, null, false),
    ('f1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a50', 'd0f1a2b3-c4d5-4e6f-8a90-b1c2d3e4f506', public.rbac_role_org_super_admin(), null, null, false),
    ('a9b8c7d6-e5f4-4321-9876-543210fedcba', 'f8e7d6c5-b4a3-4291-8f7e-6d5c4b3a2910', public.rbac_role_org_super_admin(), null, null, false),
    ('b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0dc7', '6aa76066-55ef-4238-ade6-0b32334a4097', public.rbac_role_org_super_admin(), null, null, false);

    INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      granted_by,
      reason,
      is_direct
    )
    SELECT
      public.rbac_principal_user(),
      ou.user_id,
      roles.id,
      public.rbac_scope_org(),
      ou.org_id,
      ou.user_id,
      'Seeded user RBAC binding',
      true
    FROM public.org_users ou
    JOIN public.roles roles
      ON roles.name = ou.rbac_role_name
      AND roles.scope_type = public.rbac_scope_org()
    WHERE ou.is_invite IS NOT TRUE
      AND ou.app_id IS NULL
      AND ou.channel_id IS NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO public.user_security (user_id, email_otp_verified_at, created_at, updated_at)
    VALUES ('f8e7d6c5-b4a3-4291-8f7e-6d5c4b3a2910', NOW(), NOW(), NOW());

    INSERT INTO "public"."apikeys" ("id", "created_at", "user_id", "key", "updated_at", "name") VALUES
    (1, NOW(), 'c591b04e-cf29-4945-b9a0-776d0672061a', 'c591b04e-cf29-4945-b9a0-776d0672061e', NOW(), 'admin app uploader'),
    (2, NOW(), 'c591b04e-cf29-4945-b9a0-776d0672061a', '67eeaff4-ae4c-49a6-8eb1-0875f5369de1', NOW(), 'admin app reader'),
    (3, NOW(), 'c591b04e-cf29-4945-b9a0-776d0672061a', 'ae6e7458-c46d-4c00-aa3b-153b0b8520eb', NOW(), 'admin org super admin'),
    (4, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', 'c591b04e-cf29-4945-b9a0-776d0672061b', NOW(), 'test app uploader'),
    (5, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', '67eeaff4-ae4c-49a6-8eb1-0875f5369de0', NOW(), 'test app reader'),
    (6, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', 'ae6e7458-c46d-4c00-aa3b-153b0b8520ea', NOW(), 'test org super admin'),
    (7, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', '985640ce-4031-4cfd-8095-d1d1066b6b3b', NOW(), 'test app developer'),
    (8, NOW(), '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', 'ab4d9a98-ec25-4af8-933c-2aae4aa52b85', NOW(), 'test2 app uploader'),
    (9, NOW(), '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', 'ac4d9a98-ec25-4af8-933c-2aae4aa52b85', NOW(), 'test2 org super admin'),
    -- Dedicated test keys for apikeys.test.ts to avoid interference with other tests
    (10, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', '8b2c3d4e-5f6a-4c7b-8d9e-0f1a2b3c4d5f', NOW(), 'apikey test get by id'),
    (11, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', '8b2c3d4e-5f6a-4c7b-8d9e-0f1a2b3c4d5g', NOW(), 'apikey test update name'),
    (12, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', '8b2c3d4e-5f6a-4c7b-8d9e-0f1a2b3c4d5a', NOW(), 'apikey test update org super admin'),
    (13, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', '8b2c3d4e-5f6a-4c7b-8d9e-0f1a2b3c4d5d', NOW(), 'apikey test update apps'),
    -- Dedicated user and API key for statistics tests
    (14, NOW(), '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d', '8b2c3d4e-5f6a-4c7b-8d9e-0f1a2b3c4d5e', NOW(), 'stats test org super admin'),
    -- Dedicated user and API key for RLS hashed apikey tests (isolated to prevent interference)
    (15, NOW(), '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', '9c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', NOW(), 'rls test org super admin'),
    -- Dedicated user and API key for CLI hashed apikey tests (isolated to prevent interference)
    (110, NOW(), 'e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7a81', 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c03', NOW(), 'cli hashed test org super admin'),
    -- Dedicated user and API key for encrypted bundles tests (isolated to prevent interference)
    (111, NOW(), 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708193', 'b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0d14', NOW(), 'encrypted test org super admin');

    PERFORM set_config('capgo.skip_apikey_trigger', 'true', true);

    INSERT INTO "public"."apikeys" ("id", "created_at", "user_id", "key", "updated_at", "name") VALUES
    -- Dedicated user and API keys for apikeys.test.ts API-key compatibility management
    (112, NOW(), 'd0f1a2b3-c4d5-4e6f-8a90-b1c2d3e4f506', 'c9d0e1f2-a3b4-4c5d-8e6f-7a8b9c0d1e25', NOW(), 'apikey management test org super admin'),
    (113, NOW(), 'd0f1a2b3-c4d5-4e6f-8a90-b1c2d3e4f506', 'd1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6', NOW(), 'apikey management test apikey_manager');

    PERFORM set_config('capgo.skip_apikey_trigger', 'false', true);

    -- Hashed API key for testing (hash of 'test-hashed-apikey-for-auth-test')
    -- Used by 07_auth_functions.sql tests
    INSERT INTO "public"."apikeys" ("id", "created_at", "user_id", "key", "key_hash", "updated_at", "name") VALUES
    (100, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', NULL, encode(extensions.digest('test-hashed-apikey-for-auth-test', 'sha256'), 'hex'), NOW(), 'test hashed org super admin');

    -- Expired hashed API key for testing (expired 1 day ago)
    INSERT INTO "public"."apikeys" ("id", "created_at", "user_id", "key", "key_hash", "updated_at", "name", "expires_at") VALUES
    (101, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', NULL, encode(extensions.digest('expired-hashed-key-for-test', 'sha256'), 'hex'), NOW(), 'test expired hashed', NOW() - INTERVAL '1 day');

    -- Expired plain API key for testing (expired 1 day ago)
    INSERT INTO "public"."apikeys" ("id", "created_at", "user_id", "key", "updated_at", "name", "expires_at") VALUES
    (102, NOW(), '6aa76066-55ef-4238-ade6-0b32334a4097', 'expired-plain-key-for-test', NOW(), 'test expired plain', NOW() - INTERVAL '1 day');

    INSERT INTO "public"."apps" ("created_at", "app_id", "icon_url", "name", "last_version", "updated_at", "owner_org", "user_id") VALUES
    (NOW(), 'com.demoadmin.app', '', 'Demo Admin app', '1.0.0', NOW(), '22dbad8a-b885-4309-9b3b-a09f8460fb6d', 'c591b04e-cf29-4945-b9a0-776d0672061a'),
    (NOW(), 'com.demo.app', '', 'Demo app', '1.0.0', NOW(), '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097'),
    (NOW(), 'com.stats.app', '', 'Stats Test App', '1.0.0', NOW(), 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d'),
    (NOW(), 'com.rls.app', '', 'RLS Test App', '1.0.0', NOW(), 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'),
    (NOW(), 'com.encrypted.app', '', 'Encrypted Test App', '1.0.0', NOW(), 'a7b8c9d0-e1f2-4a3b-9c4d-5e6f7a8b9ca4', 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708193'),
    (NOW(), 'com.test2.app', '', 'Test2 App', '1.0.0', NOW(), '34a8c55d-2d0f-4652-a43f-684c7a9403ac', '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5');

    WITH seed_key_roles (id, org_role_name) AS (
      VALUES
        (1, public.rbac_role_org_member()),
        (2, public.rbac_role_org_member()),
        (3, public.rbac_role_org_super_admin()),
        (4, public.rbac_role_org_member()),
        (5, public.rbac_role_org_member()),
        (6, public.rbac_role_org_super_admin()),
        (7, public.rbac_role_org_member()),
        (8, public.rbac_role_org_member()),
        (9, public.rbac_role_org_super_admin()),
        (10, public.rbac_role_org_member()),
        (11, public.rbac_role_org_member()),
        (12, public.rbac_role_org_super_admin()),
        (13, public.rbac_role_org_member()),
        (14, public.rbac_role_org_super_admin()),
        (15, public.rbac_role_org_super_admin()),
        (100, public.rbac_role_org_super_admin()),
        (101, public.rbac_role_org_super_admin()),
        (102, public.rbac_role_org_super_admin()),
        (110, public.rbac_role_org_super_admin()),
        (111, public.rbac_role_org_super_admin()),
        (112, public.rbac_role_org_super_admin()),
        (113, public.rbac_role_apikey_manager())
    )
    INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      granted_by,
      reason,
      is_direct
    )
    SELECT
      public.rbac_principal_apikey(),
      ak.rbac_id,
      roles.id,
      public.rbac_scope_org(),
      org_memberships.org_id,
      ak.user_id,
      'Seeded API key V2 org binding',
      true
    FROM seed_key_roles key_roles
    JOIN public.apikeys ak ON ak.id = key_roles.id
    JOIN public.org_users org_memberships
      ON org_memberships.user_id = ak.user_id
      AND org_memberships.is_invite IS NOT TRUE
    JOIN public.roles roles
      ON roles.name = key_roles.org_role_name
      AND roles.scope_type = public.rbac_scope_org()
    ON CONFLICT DO NOTHING;

    WITH seed_key_roles (id, app_role_name) AS (
      VALUES
        (1, public.rbac_role_app_uploader()),
        (2, public.rbac_role_app_reader()),
        (4, public.rbac_role_app_uploader()),
        (5, public.rbac_role_app_reader()),
        (7, public.rbac_role_app_developer()),
        (8, public.rbac_role_app_uploader()),
        (10, public.rbac_role_app_uploader()),
        (11, public.rbac_role_app_reader()),
        (13, public.rbac_role_app_developer())
    )
    INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      app_id,
      granted_by,
      reason,
      is_direct
    )
    SELECT
      public.rbac_principal_apikey(),
      ak.rbac_id,
      roles.id,
      public.rbac_scope_app(),
      apps.owner_org,
      apps.id,
      ak.user_id,
      'Seeded API key V2 app binding',
      true
    FROM seed_key_roles key_roles
    JOIN public.apikeys ak ON ak.id = key_roles.id
    JOIN public.org_users org_memberships
      ON org_memberships.user_id = ak.user_id
      AND org_memberships.is_invite IS NOT TRUE
    JOIN public.apps apps ON apps.owner_org = org_memberships.org_id
    JOIN public.roles roles
      ON roles.name = key_roles.app_role_name
      AND roles.scope_type = public.rbac_scope_app()
    ON CONFLICT DO NOTHING;

    INSERT INTO "public"."app_versions" ("id", "created_at", "app_id", "name", "r2_path", "updated_at", "deleted", "external_url", "checksum", "session_key", "storage_provider", "owner_org", "user_id", "comment", "link") VALUES
    (3, NOW(), 'com.demo.app', '1.0.0', 'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.demo.app/1.0.0.zip', NOW(), 'f', NULL, '3885ee49', NULL, 'r2', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', 'its a test', 'https://capgo.app'),
    (4, NOW(), 'com.demo.app', '1.0.1', 'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.demo.app/1.0.1.zip', NOW(), 'f', NULL, '', NULL, 'r2-direct', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', 'its a test', 'https://capgo.app'),
    (5, NOW(), 'com.demo.app', '1.361.0', 'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.demo.app/1.361.0.zip', NOW(), 'f', NULL, '9d4f798a', NULL, 'r2', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', 'its a test', 'https://capgo.app'),
    (6, NOW(), 'com.demo.app', '1.360.0', 'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.demo.app/1.360.0.zip', NOW(), 'f', NULL, '44913a9f', NULL, 'r2', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', 'its a test', 'https://capgo.app'),
    (7, NOW(), 'com.demo.app', '1.359.0', 'orgs/046a36ac-e03c-4590-9257-bd6c9dba9ee8/apps/com.demo.app/1.359.0.zip', NOW(), 'f', NULL, '9f74e70a', NULL, 'r2', '046a36ac-e03c-4590-9257-bd6c9dba9ee8', '6aa76066-55ef-4238-ade6-0b32334a4097', 'its a test', 'https://capgo.app'),
    (10, NOW(), 'com.demoadmin.app', '1.0.0', 'orgs/22dbad8a-b885-4309-9b3b-a09f8460fb6d/apps/com.demoadmin.app/1.0.0.zip', NOW(), 'f', NULL, 'admin123', NULL, 'r2', '22dbad8a-b885-4309-9b3b-a09f8460fb6d', 'c591b04e-cf29-4945-b9a0-776d0672061a', 'admin app test version', 'https://capgo.app'),
    (13, NOW(), 'com.stats.app', '1.0.0', 'orgs/b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e/apps/com.stats.app/1.0.0.zip', NOW(), 'f', NULL, 'stats123', NULL, 'r2', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d', 'stats test version', 'https://capgo.app'),
    (16, now(), 'com.test2.app', '1.0.0', 'orgs/34a8c55d-2d0f-4652-a43f-684c7a9403ac/apps/com.test2.app/1.0.0.zip', now(), 'f', NULL, 'test2123', NULL, 'r2', '34a8c55d-2d0f-4652-a43f-684c7a9403ac', '6f0d1a2e-59ed-4769-b9d7-4d9615b28fe5', 'test2 app version', 'https://capgo.app');

    INSERT INTO "public"."app_versions_meta" ("id", "created_at", "app_id", "updated_at", "checksum", "size") VALUES
    (3, NOW(), 'com.demo.app', NOW(), '3885ee49', 1012506),
    (4, NOW(), 'com.demo.app', NOW(), '', 0),
    (5, NOW(), 'com.demo.app', NOW(), '9d4f798a', 1012529),
    (6, NOW(), 'com.demo.app', NOW(), '44913a9f', 1012541),
    (7, NOW(), 'com.demo.app', NOW(), '9f74e70a', 1012548),
    (10, NOW(), 'com.demoadmin.app', NOW(), 'admin123', 1500000),
    (13, NOW(), 'com.stats.app', NOW(), 'stats123', 850000);

    INSERT INTO "public"."channels" ("id", "created_at", "name", "app_id", "version", "updated_at", "public", "disable_auto_update_under_native", "disable_auto_update", "ios", "android", "electron", "allow_device_self_set", "allow_emulator", "allow_device", "allow_dev", "allow_prod", "created_by") VALUES
    (1, NOW(), 'production', 'com.demo.app', 3, NOW(), 't', 't', 'major'::"public"."disable_update", 'f', 't', 't', 't', 't', 't', 't', 't', '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid),
    (2, NOW(), 'no_access', 'com.demo.app', 5, NOW(), 'f', 't', 'major'::"public"."disable_update", 't', 't', 'f', 't', 't', 't', 't', 't', '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid),
    (3, NOW(), 'two_default', 'com.demo.app', 3, NOW(), 't', 't', 'major'::"public"."disable_update", 't', 'f', 'f', 't', 't', 't', 't', 't', '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid),
    (4, NOW(), 'production', 'com.stats.app', 13, NOW(), 't', 't', 'major'::"public"."disable_update", 'f', 't', 't', 't', 't', 't', 't', 't', '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d'::uuid),
    (5, NOW(), 'electron_only', 'com.demo.app', 3, NOW(), 'f', 't', 'major'::"public"."disable_update", 'f', 'f', 't', 't', 't', 't', 't', 't', '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid);

    INSERT INTO "public"."deploy_history" ("id", "created_at", "updated_at", "channel_id", "app_id", "version_id", "deployed_at", "owner_org", "created_by") VALUES
    (1, NOW() - interval '15 days', NOW() - interval '15 days', 1, 'com.demo.app', 3, NOW() - interval '15 days', '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid),
    (2, NOW() - interval '10 days', NOW() - interval '10 days', 1, 'com.demo.app', 5, NOW() - interval '10 days', '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid),
    (3, NOW() - interval '5 days', NOW() - interval '5 days', 1, 'com.demo.app', 3, NOW() - interval '5 days', '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid),
    (4, NOW() - interval '7 days', NOW() - interval '7 days', 4, 'com.stats.app', 13, NOW() - interval '7 days', 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'::uuid, '7a1b2c3d-4e5f-4a6b-7c8d-9e0f1a2b3c4d'::uuid);

    -- Insert test devices for RLS testing
    INSERT INTO "public"."devices" ("updated_at", "device_id", "version_name", "app_id", "platform", "plugin_version", "os_version", "version_build", "custom_id", "is_prod", "is_emulator") VALUES
    (NOW(), '00000000-0000-0000-0000-000000000001', '1.0.0', 'com.demo.app', 'ios', '4.15.3', '16.0', '1.0.0', 'test-device-1', 't', 'f'),
    (NOW(), '00000000-0000-0000-0000-000000000002', '1.0.1', 'com.demo.app', 'android', '4.15.3', '13', '1.0.1', 'test-device-2', 't', 'f'),
    (NOW(), '00000000-0000-0000-0000-000000000003', '1.361.0', 'com.demo.app', 'ios', '4.15.3', '15.0', '1.361.0', 'test-device-3', 'f', 't'),
    (NOW(), '00000000-0000-0000-0000-000000000004', '1.0.0', 'com.demoadmin.app', 'android', '4.15.3', '12', '1.0.0', 'admin-test-device', 't', 'f'),
    (NOW(), '00000000-0000-0000-0000-000000000005', '1.0.0', 'com.stats.app', 'android', '4.15.3', '11', '1.0.0', 'stats-test-device', 't', 'f'),
    (NOW(), '00000000-0000-0000-0000-000000000006', '1.0.0', 'com.demo.app', 'electron', '7.0.0', 'Linux 5.15', '1.0.0', 'electron-test-device', 't', 'f');

    -- Drop replicated orgs but keet the the seed ones
    DELETE from "public"."orgs" where POSITION('organization' in orgs.name)=1;
    PERFORM setval('public.apikeys_id_seq', 113, true);
    PERFORM setval('public.app_versions_id_seq', 16, true);
    PERFORM setval('public.channel_id_seq', 6, false);
    PERFORM setval('public.deploy_history_id_seq', 5, false);
END;
$_$;

ALTER FUNCTION "public"."reset_and_seed_data" () OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."reset_and_seed_data" ()
FROM
  PUBLIC;

GRANT ALL ON FUNCTION "public"."reset_and_seed_data" () TO "service_role";

CREATE OR REPLACE FUNCTION "public"."reset_and_seed_stats_data" () RETURNS "void" LANGUAGE "plpgsql"
SET
  search_path = '' AS $$
DECLARE
  start_date TIMESTAMP := CURRENT_DATE - INTERVAL '15 days';
  end_date TIMESTAMP := CURRENT_DATE;
  curr_date DATE;
  random_mau INTEGER;
  random_bandwidth BIGINT;
  random_storage BIGINT;
  random_file_size BIGINT;
  random_uuid UUID;
  random_version_id BIGINT := 3;
  random_action VARCHAR(20);
  random_timestamp TIMESTAMP;
  random_daily_change NUMERIC := 0;
  previous_install BIGINT := 0;
  previous_version_id BIGINT := 3;
  current_version_id BIGINT := 4;
  demo_org_id uuid := '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid;
BEGIN
  -- Truncate all tables
  TRUNCATE TABLE public.daily_mau, public.daily_bandwidth, public.daily_storage, public.daily_version, public.storage_usage, public.version_usage, public.device_usage, public.bandwidth_usage, public.devices, public.stats;

  -- Generate a random UUID
  random_uuid := gen_random_uuid();

  INSERT INTO public.devices (updated_at, device_id, version_name, app_id, platform, plugin_version, os_version, version_build, custom_id, is_prod, is_emulator) VALUES
    (NOW(), random_uuid, '1.0.0', 'com.demo.app', 'android', '4.15.3', '9', '1.223.0', '', 't', 't');

  --  insert a fix device id for test
  INSERT INTO public.devices (updated_at, device_id, version_name, app_id, platform, plugin_version, os_version, version_build, custom_id, is_prod, is_emulator) VALUES
    (NOW(), '00000000-0000-0000-0000-000000000000', '1.0.0', 'com.demo.app', 'android', '4.15.3', '9', '1.223.0', '', 't', 't');

  INSERT INTO public.devices (updated_at, device_id, version_name, app_id, platform, plugin_version, os_version, version_build, custom_id, is_prod, is_emulator) VALUES
    (NOW(), '00000000-0000-0000-0000-000000000010', '1.0.0', 'com.demo.app', 'ios', '4.15.3', '16.0', '1.0.0', 'observe-plugin-4-ios', 't', 'f'),
    (NOW(), '00000000-0000-0000-0000-000000000011', '1.0.1', 'com.demo.app', 'android', '4.15.3', '14', '1.0.1', 'observe-plugin-4-android', 't', 'f'),
    (NOW(), '00000000-0000-0000-0000-000000000012', '1.0.0', 'com.demo.app', 'electron', '7.0.0', 'Linux 5.15', '1.0.0', 'observe-plugin-7-electron', 't', 'f');

  INSERT INTO public.stats (created_at, action, device_id, version_name, app_id) VALUES
    (NOW(), 'get'::"public"."stats_action", random_uuid, '1.0.0', 'com.demo.app'),
    (NOW(), 'set'::"public"."stats_action", random_uuid, '1.0.0', 'com.demo.app');

  INSERT INTO public.stats (created_at, action, device_id, version_name, app_id, metadata) VALUES
    (NOW(), 'webview_javascript_error'::"public"."stats_action", '44444444-4444-4444-4444-444444444444', '1.0.0', 'com.demo.app', '{"message":"Uncaught ReferenceError: foo is not defined","error_type":"javascript_error","href":"capacitor://localhost/index.html"}'::jsonb);

  -- Seed data for daily_mau, daily_bandwidth, and daily_storage
  curr_date := start_date::DATE;
  WHILE curr_date <= end_date::DATE LOOP
    random_mau := FLOOR(RANDOM() * 1000) + 1;
    random_bandwidth := FLOOR(RANDOM() * 1000000000) + 1;
    random_storage := FLOOR(RANDOM() * 1000000000) + 1;

    INSERT INTO public.daily_mau (app_id, date, mau) VALUES ('com.demo.app', curr_date, random_mau);
    INSERT INTO public.daily_bandwidth (app_id, date, bandwidth) VALUES ('com.demo.app', curr_date, random_bandwidth);
    INSERT INTO public.daily_storage (app_id, date, storage) VALUES ('com.demo.app', curr_date, random_storage);

    curr_date := curr_date + INTERVAL '1 day';
  END LOOP;

  -- Seed data for daily_version

  curr_date := start_date::DATE;
  WHILE curr_date <= end_date::DATE LOOP
    IF curr_date != start_date::DATE THEN
      -- Generate a random value between 0.2 and 0.8 using a more reliable method
      random_daily_change := (random() * 0.6 + 0.2);
      IF previous_version_id = 3 THEN
        current_version_id := 4;
      ELSE
        current_version_id := 3;
      END IF;

      INSERT INTO public.daily_version (date, app_id, version_id, version_name, get, fail, install, uninstall)
      VALUES (curr_date, 'com.demo.app', previous_version_id, CASE WHEN previous_version_id = 3 THEN '1.0.0' ELSE '1.0.1' END, FLOOR(RANDOM() * 100) + 1, FLOOR(RANDOM() * 10) + 1, 0, previous_install * random_daily_change);

      INSERT INTO public.daily_version (date, app_id, version_id, version_name, get, fail, install, uninstall)
      VALUES (curr_date, 'com.demo.app', current_version_id, CASE WHEN current_version_id = 3 THEN '1.0.0' ELSE '1.0.1' END, FLOOR(RANDOM() * 100) + 1, FLOOR(RANDOM() * 10) + 1, previous_install * random_daily_change, 0);
      previous_version_id := current_version_id;
      previous_install := previous_install * random_daily_change;
    ELSE
      previous_install := FLOOR(RANDOM() * 50000) + 1;
      INSERT INTO public.daily_version (date, app_id, version_id, version_name, get, fail, install, uninstall)
      VALUES (curr_date, 'com.demo.app', current_version_id, CASE WHEN current_version_id = 3 THEN '1.0.0' ELSE '1.0.1' END, FLOOR(RANDOM() * 100) + 1, FLOOR(RANDOM() * 10) + 1, previous_install, 0);
    END IF;

    curr_date := curr_date + INTERVAL '1 day';
  END LOOP;

  -- Add daily_version data for additional apps for testing multi-app view
  curr_date := start_date::DATE + INTERVAL '5 days'; -- Start 5 days later for variety
  WHILE curr_date <= end_date::DATE LOOP
    -- Add data for com.demoadmin.app
    INSERT INTO public.daily_version (date, app_id, version_id, version_name, get, fail, install, uninstall)
    VALUES (curr_date, 'com.demoadmin.app', 10, '1.0.0', FLOOR(RANDOM() * 30) + 5, FLOOR(RANDOM() * 3) + 0, FLOOR(RANDOM() * 20) + 3, 0);

    -- Add data for com.stats.app
    INSERT INTO public.daily_version (date, app_id, version_id, version_name, get, fail, install, uninstall)
    VALUES (curr_date, 'com.stats.app', 13, '1.0.0', FLOOR(RANDOM() * 25) + 8, FLOOR(RANDOM() * 2) + 0, FLOOR(RANDOM() * 15) + 2, 0);

    curr_date := curr_date + INTERVAL '1 day';
  END LOOP;

  -- Seed data for storage_usage
  FOR i IN 1..20 LOOP
    random_file_size := FLOOR(RANDOM() * 10485760) - 5242880; -- Random size between -5MB and 5MB
    INSERT INTO public.storage_usage (device_id, app_id, file_size) VALUES (random_uuid, 'com.demo.app', random_file_size);
  END LOOP;

  -- Seed data for version_usage
  FOR i IN 1..30 LOOP
    random_timestamp := start_date + (RANDOM() * (end_date - start_date));
    random_action := (ARRAY['get', 'fail', 'install', 'uninstall'])[FLOOR(RANDOM() * 4) + 1];
    INSERT INTO public.version_usage (timestamp, app_id, version_id, action)
    VALUES (random_timestamp, 'com.demo.app', random_version_id, random_action::"public"."version_action");
  END LOOP;

  -- Seed data for device_usage
  FOR i IN 1..50 LOOP
    INSERT INTO public.device_usage (device_id, app_id, org_id)
    VALUES (random_uuid, 'com.demo.app', demo_org_id::text);
  END LOOP;

  -- Seed data for bandwidth_usage
  FOR i IN 1..40 LOOP
    random_file_size := FLOOR(RANDOM() * 10485760) + 1; -- Random size between 1 byte and 10MB
    INSERT INTO public.bandwidth_usage (device_id, app_id, file_size) VALUES (random_uuid, 'com.demo.app', random_file_size);
  END LOOP;
END;
$$;

ALTER FUNCTION "public"."reset_and_seed_stats_data" () OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."reset_and_seed_stats_data" ()
FROM
  PUBLIC;

GRANT ALL ON FUNCTION "public"."reset_and_seed_stats_data" () TO "service_role";

CREATE OR REPLACE FUNCTION "public"."reset_app_data" ("p_app_id" character varying) RETURNS "void" LANGUAGE "plpgsql"
SET
  search_path = '' SECURITY DEFINER AS $$
BEGIN
    -- Use advisory lock to prevent concurrent execution for the same app
    PERFORM pg_advisory_xact_lock(hashtext(p_app_id));

    -- Delete in dependency order to avoid foreign key conflicts
    DELETE FROM public.deploy_history WHERE app_id = p_app_id;
    DELETE FROM public.channel_devices WHERE app_id = p_app_id;
    DELETE FROM public.channels WHERE app_id = p_app_id;
    DELETE FROM public.app_versions WHERE app_id = p_app_id;
    DELETE FROM public.build_requests WHERE app_id = p_app_id;
    DELETE FROM public.apps WHERE app_id = p_app_id;

    -- Advisory lock is automatically released at transaction end
END;
$$;

ALTER FUNCTION "public"."reset_app_data" ("p_app_id" character varying) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."reset_app_data" ("p_app_id" character varying)
FROM
  PUBLIC;

GRANT ALL ON FUNCTION "public"."reset_app_data" ("p_app_id" character varying) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."reset_and_seed_app_data" (
  "p_app_id" varchar,
  "p_org_id" uuid DEFAULT NULL,
  "p_user_id" uuid DEFAULT NULL,
  "p_admin_user_id" uuid DEFAULT NULL,
  "p_stripe_customer_id" text DEFAULT NULL,
  "p_plan_product_id" text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  org_id uuid := COALESCE(p_org_id, '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid);
  user_id uuid := COALESCE(p_user_id, '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid);
  admin_user_id uuid := COALESCE(p_admin_user_id, 'c591b04e-cf29-4945-b9a0-776d0672061a'::uuid);
  stripe_customer_id text := COALESCE(p_stripe_customer_id, 'cus_Q38uE91NP8Ufqc');
  plan_product_id text := COALESCE(p_plan_product_id, 'prod_LQIregjtNduh4q');
  org_name text := CASE
    WHEN p_org_id IS NULL THEN 'Demo org'
    ELSE concat('Seeded Org ', p_app_id)
  END;
  v1_0_1_version_id bigint; v1_0_0_version_id bigint; v1_361_0_version_id bigint; v1_360_0_version_id bigint; v1_359_0_version_id bigint;
  production_channel_id bigint; beta_channel_id bigint; development_channel_id bigint; no_access_channel_id bigint; electron_only_channel_id bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_app_id));
  EXECUTE 'DELETE FROM public.org_id_tombstones WHERE org_id = $1' USING org_id;
  PERFORM public.reset_app_data(p_app_id);
  -- Ensure the base Stripe customer and org exist so FK inserts are stable between tests
  INSERT INTO public.stripe_info (
    customer_id,
    product_id,
    subscription_id,
    status,
    trial_at,
    is_good_plan,
    plan_usage,
    subscription_anchor_start,
    subscription_anchor_end,
    mau_exceeded,
    bandwidth_exceeded,
    storage_exceeded,
    build_time_exceeded
  ) VALUES (
    stripe_customer_id,
    plan_product_id,
    'sub_seeded_demo',
    'succeeded',
    NOW() + interval '15 days',
    true,
    2,
    NOW() - interval '15 days',
    NOW() + interval '15 days',
    false,
    false,
    false,
    false
  )
  ON CONFLICT (customer_id) DO UPDATE SET
    product_id = EXCLUDED.product_id,
    subscription_id = EXCLUDED.subscription_id,
    status = EXCLUDED.status,
    trial_at = EXCLUDED.trial_at,
    is_good_plan = EXCLUDED.is_good_plan,
    plan_usage = EXCLUDED.plan_usage,
    subscription_anchor_start = EXCLUDED.subscription_anchor_start,
    subscription_anchor_end = EXCLUDED.subscription_anchor_end,
    mau_exceeded = EXCLUDED.mau_exceeded,
    bandwidth_exceeded = EXCLUDED.bandwidth_exceeded,
    storage_exceeded = EXCLUDED.storage_exceeded,
    build_time_exceeded = EXCLUDED.build_time_exceeded,
    updated_at = NOW();

  INSERT INTO public.orgs (id, created_by, created_at, updated_at, logo, name, management_email, customer_id)
  VALUES (
    org_id,
    user_id,
    NOW(),
    NOW(),
    '',
    org_name,
    'test@capgo.app',
    stripe_customer_id
  )
  ON CONFLICT (id) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    management_email = EXCLUDED.management_email,
    name = EXCLUDED.name,
    updated_at = NOW();

  EXECUTE $sql$
    INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
    SELECT $1, $2, public.rbac_role_org_super_admin(), false
    WHERE NOT EXISTS (
      SELECT 1 FROM public.org_users ou
      WHERE ou.org_id = $1 AND ou.user_id = $2
    )
  $sql$ USING org_id, user_id;

  EXECUTE $sql2$
    INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
    SELECT $1, $2, public.rbac_role_org_super_admin(), false
    WHERE NOT EXISTS (
      SELECT 1 FROM public.org_users ou
      WHERE ou.org_id = $1 AND ou.user_id = $2
    )
  $sql2$ USING org_id, admin_user_id;

  -- API keys use bindings-priority: a key with its own role_bindings can only reach
  -- orgs it is bound to. Clone each owner key's Demo-org binding onto this org so
  -- apikey-authed tests work against dedicated per-file orgs too. Skip orgs with
  -- apikey expiration policies: their triggers reject bindings for non-expiring keys.
  EXECUTE $sql3$
    INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct)
    SELECT rb.principal_type, rb.principal_id, rb.role_id, rb.scope_type, $1, rb.granted_by, 'Seeded API key V2 org binding (per-app org)', true
    FROM public.role_bindings rb
    JOIN public.apikeys ak ON ak.rbac_id = rb.principal_id
    WHERE rb.principal_type = public.rbac_principal_apikey()
      AND rb.scope_type = public.rbac_scope_org()
      AND rb.org_id = '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid
      AND ak.user_id IN ($2, $3)
      AND NOT EXISTS (
        SELECT 1 FROM public.orgs o
        WHERE o.id = $1
          AND (o.require_apikey_expiration OR o.max_apikey_expiration_days IS NOT NULL)
      )
    ON CONFLICT DO NOTHING
  $sql3$ USING org_id, user_id, admin_user_id;

  INSERT INTO public.apps (created_at, app_id, icon_url, name, last_version, updated_at, owner_org, user_id)
  VALUES (NOW(), p_app_id, '', 'Seeded App', '1.0.0', NOW(), org_id, user_id);
  WITH version_inserts AS (
    INSERT INTO public.app_versions (created_at, app_id, name, r2_path, updated_at, deleted, external_url, checksum, storage_provider, owner_org, comment, link, user_id)
    VALUES
      (NOW(), p_app_id, '1.0.1', 'orgs/'||org_id||'/apps/'||p_app_id||'/1.0.1.zip', NOW(), 'f', NULL, '', 'r2-direct', org_id, 'Bug fixes and minor improvements', 'https://github.com/Cap-go/capgo/releases/tag/v1.0.1', user_id),
      (NOW(), p_app_id, '1.0.0', 'orgs/'||org_id||'/apps/'||p_app_id||'/1.0.0.zip', NOW(), 'f', NULL, '3885ee49', 'r2', org_id, 'Initial release', 'https://github.com/Cap-go/capgo/releases/tag/v1.0.0', user_id),
      (NOW(), p_app_id, '1.361.0', 'orgs/'||org_id||'/apps/'||p_app_id||'/1.361.0.zip', NOW(), 'f', NULL, '9d4f798a', 'r2', org_id, 'Major version update with new features', 'https://github.com/Cap-go/capgo/releases/tag/v1.361.0', user_id),
      (NOW(), p_app_id, '1.360.0', 'orgs/'||org_id||'/apps/'||p_app_id||'/1.360.0.zip', NOW(), 'f', NULL, '44913a9f', 'r2', org_id, 'Pre-release version with experimental features', 'https://github.com/Cap-go/capgo/releases/tag/v1.360.0', user_id),
      (NOW(), p_app_id, '1.359.0', 'orgs/'||org_id||'/apps/'||p_app_id||'/1.359.0.zip', NOW(), 'f', NULL, '9f74e70a', 'r2', org_id, 'Stability improvements', 'https://github.com/Cap-go/capgo/releases/tag/v1.359.0', user_id)
    RETURNING id, name
  )
  SELECT MAX(CASE WHEN name='1.0.1' THEN id END), MAX(CASE WHEN name='1.0.0' THEN id END), MAX(CASE WHEN name='1.361.0' THEN id END), MAX(CASE WHEN name='1.360.0' THEN id END), MAX(CASE WHEN name='1.359.0' THEN id END)
  INTO v1_0_1_version_id, v1_0_0_version_id, v1_361_0_version_id, v1_360_0_version_id, v1_359_0_version_id FROM version_inserts;
  WITH channel_inserts AS (
    INSERT INTO public.channels (created_at, name, app_id, version, updated_at, public, disable_auto_update_under_native, disable_auto_update, ios, android, electron, allow_device_self_set, allow_emulator, allow_device, allow_dev, allow_prod, created_by, owner_org)
    VALUES
      (NOW(), 'production', p_app_id, v1_0_0_version_id, NOW(), 't', 't', 'major'::public.disable_update, 'f', 't', 't', 't', 't', 't', 't', 't', user_id, org_id),
      (NOW(), 'beta', p_app_id, v1_361_0_version_id, NOW(), 'f', 't', 'major'::public.disable_update, 't', 't', 't', 't', 't', 't', 't', 't', user_id, org_id),
      (NOW(), 'development', p_app_id, v1_359_0_version_id, NOW(), 't', 't', 'major'::public.disable_update, 't', 'f', 'f', 't', 't', 't', 't', 't', user_id, org_id),
      (NOW(), 'no_access', p_app_id, v1_361_0_version_id, NOW(), 'f', 't', 'major'::public.disable_update, 'f', 'f', 'f', 't', 't', 't', 't', 't', user_id, org_id),
      (NOW(), 'electron_only', p_app_id, v1_360_0_version_id, NOW(), 'f', 't', 'major'::public.disable_update, 'f', 'f', 't', 't', 't', 't', 't', 't', user_id, org_id)
    RETURNING id, name
  )
  SELECT MAX(CASE WHEN name='production' THEN id END), MAX(CASE WHEN name='beta' THEN id END), MAX(CASE WHEN name='development' THEN id END), MAX(CASE WHEN name='no_access' THEN id END), MAX(CASE WHEN name='electron_only' THEN id END)
  INTO production_channel_id, beta_channel_id, development_channel_id, no_access_channel_id, electron_only_channel_id FROM channel_inserts;
  INSERT INTO public.deploy_history (created_at, updated_at, channel_id, app_id, version_id, deployed_at, owner_org, created_by)
  VALUES
    (NOW() - interval '15 days', NOW() - interval '15 days', production_channel_id, p_app_id, v1_0_0_version_id, NOW() - interval '15 days', org_id, user_id),
    (NOW() - interval '10 days', NOW() - interval '10 days', beta_channel_id, p_app_id, v1_361_0_version_id, NOW() - interval '10 days', org_id, user_id),
    (NOW() - interval '5 days', NOW() - interval '5 days', development_channel_id, p_app_id, v1_359_0_version_id, NOW() - interval '5 days', org_id, user_id),
    (NOW() - interval '3 days', NOW() - interval '3 days', no_access_channel_id, p_app_id, v1_361_0_version_id, NOW() - interval '3 days', org_id, user_id),
    (NOW() - interval '2 days', NOW() - interval '2 days', electron_only_channel_id, p_app_id, v1_360_0_version_id, NOW() - interval '2 days', org_id, user_id);
  PERFORM v1_0_1_version_id, v1_360_0_version_id;
END;
$$;

ALTER FUNCTION "public"."reset_and_seed_app_data" (
  "p_app_id" character varying,
  "p_org_id" uuid,
  "p_user_id" uuid,
  "p_admin_user_id" uuid,
  "p_stripe_customer_id" text,
  "p_plan_product_id" text
) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."reset_and_seed_app_data" (
  "p_app_id" character varying,
  "p_org_id" uuid,
  "p_user_id" uuid,
  "p_admin_user_id" uuid,
  "p_stripe_customer_id" text,
  "p_plan_product_id" text
)
FROM
  PUBLIC;

GRANT ALL ON FUNCTION "public"."reset_and_seed_app_data" (
  "p_app_id" character varying,
  "p_org_id" uuid,
  "p_user_id" uuid,
  "p_admin_user_id" uuid,
  "p_stripe_customer_id" text,
  "p_plan_product_id" text
) TO "service_role";

CREATE OR REPLACE FUNCTION "public"."reset_app_stats_data" ("p_app_id" character varying) RETURNS "void" LANGUAGE "plpgsql"
SET
  search_path = '' SECURITY DEFINER AS $$
BEGIN
  -- Use advisory lock to prevent concurrent execution for the same app
  PERFORM pg_advisory_xact_lock(hashtext(p_app_id || '_stats'));

  -- Delete existing data for the specified app_id in dependency order
  DELETE FROM public.daily_mau WHERE app_id = p_app_id;
  DELETE FROM public.daily_bandwidth WHERE app_id = p_app_id;
  DELETE FROM public.daily_storage WHERE app_id = p_app_id;
  DELETE FROM public.daily_version WHERE app_id = p_app_id;
  DELETE FROM public.daily_build_time WHERE app_id = p_app_id;
  DELETE FROM public.storage_usage WHERE app_id = p_app_id;
  DELETE FROM public.version_usage WHERE app_id = p_app_id;
  DELETE FROM public.device_usage WHERE app_id = p_app_id;
  DELETE FROM public.bandwidth_usage WHERE app_id = p_app_id;
  DELETE FROM public.devices WHERE app_id = p_app_id;
  DELETE FROM public.stats WHERE app_id = p_app_id;

  -- Advisory lock is automatically released at transaction end
END;
$$;

ALTER FUNCTION "public"."reset_app_stats_data" ("p_app_id" character varying) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."reset_app_stats_data" ("p_app_id" character varying)
FROM
  PUBLIC;

GRANT ALL ON FUNCTION "public"."reset_app_stats_data" ("p_app_id" character varying) TO "service_role";

-- P) reset_and_seed_app_stats_data: cast uuid, drop unused vars
CREATE OR REPLACE FUNCTION "public"."reset_and_seed_app_stats_data" ("p_app_id" varchar) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  start_date TIMESTAMP := CURRENT_DATE - INTERVAL '15 days';
  end_date TIMESTAMP := CURRENT_DATE;
  curr_date DATE;
  random_mau INTEGER;
  random_bandwidth BIGINT;
  random_storage BIGINT;
  random_uuid UUID;
  random_fixed_uuid UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  random_version_id BIGINT := 3;
  org_id uuid;
  fallback_org_id uuid := '046a36ac-e03c-4590-9257-bd6c9dba9ee8'::uuid;
  fallback_user_id uuid := '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_app_id || '_stats'));
  PERFORM public.reset_app_stats_data(p_app_id);
  random_uuid := gen_random_uuid();
  SELECT owner_org INTO org_id FROM public.apps WHERE app_id = p_app_id LIMIT 1;
  IF org_id IS NULL THEN
    org_id := fallback_org_id;
  END IF;
  INSERT INTO public.apps (created_at, app_id, icon_url, name, last_version, updated_at, owner_org, user_id)
  VALUES (NOW(), p_app_id, '', 'Seeded Stats App', '1.0.0', NOW(), org_id, fallback_user_id)
  ON CONFLICT (app_id) DO NOTHING;
  INSERT INTO public.devices (updated_at, device_id, version_name, app_id, platform, plugin_version, os_version, version_build, custom_id, is_prod, is_emulator)
  VALUES (NOW(), random_uuid, '1.0.0', p_app_id, 'android', '4.15.3', '9', '1.223.0', '', 't', 't'), (NOW(), random_fixed_uuid, '1.0.0', p_app_id, 'android', '4.15.3', '9', '1.223.0', '', 't', 't');
  INSERT INTO public.stats (created_at, action, device_id, version_name, app_id)
  VALUES (NOW(), 'get'::public.stats_action, random_uuid, '1.0.0', p_app_id), (NOW(), 'set'::public.stats_action, random_uuid, '1.0.0', p_app_id);
  curr_date := start_date::DATE;
  WHILE curr_date <= end_date::DATE LOOP
    random_mau := FLOOR(RANDOM() * 1000) + 1; random_bandwidth := FLOOR(RANDOM() * 1000000000) + 1; random_storage := FLOOR(RANDOM() * 1000000000) + 1;
    INSERT INTO public.daily_mau (app_id, date, mau) VALUES (p_app_id, curr_date, random_mau);
    INSERT INTO public.daily_bandwidth (app_id, date, bandwidth) VALUES (p_app_id, curr_date, random_bandwidth);
    INSERT INTO public.daily_storage (app_id, date, storage) VALUES (p_app_id, curr_date, random_storage);
    INSERT INTO public.daily_build_time (app_id, date, build_time_unit, build_count)
    VALUES (p_app_id, curr_date, FLOOR(RANDOM() * 7200) + 300, FLOOR(RANDOM() * 10) + 1);
    INSERT INTO public.daily_version (date, app_id, version_id, version_name, get, fail, install, uninstall)
    VALUES (curr_date, p_app_id, random_version_id, '1.0.0', FLOOR(RANDOM() * 100) + 1, FLOOR(RANDOM() * 10) + 1, FLOOR(RANDOM() * 50) + 1, FLOOR(RANDOM() * 20) + 1);
    curr_date := curr_date + INTERVAL '1 day';
  END LOOP;
  INSERT INTO public.storage_usage (device_id, app_id, file_size) SELECT random_uuid, p_app_id, FLOOR(RANDOM() * 10485760) - 5242880 FROM generate_series(1, 20);
  INSERT INTO public.version_usage (timestamp, app_id, version_id, action)
  SELECT start_date + (RANDOM() * (end_date - start_date)), p_app_id, random_version_id, (ARRAY['get','fail','install','uninstall'])[FLOOR(RANDOM() * 4) + 1]::public.version_action FROM generate_series(1, 30);
  INSERT INTO public.device_usage (device_id, app_id, org_id)
  SELECT random_uuid, p_app_id, org_id::text FROM generate_series(1, 50);
  INSERT INTO public.bandwidth_usage (device_id, app_id, file_size) SELECT random_uuid, p_app_id, FLOOR(RANDOM() * 10485760) + 1 FROM generate_series(1, 40);
END;
$$;

ALTER FUNCTION "public"."reset_and_seed_app_stats_data" ("p_app_id" character varying) OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."reset_and_seed_app_stats_data" ("p_app_id" character varying)
FROM
  PUBLIC;

GRANT ALL ON FUNCTION "public"."reset_and_seed_app_stats_data" ("p_app_id" character varying) TO "service_role";

-- Realistic demo customer ("Acme Mobile") used to exercise the hosted MCP server,
-- take console screenshots and mirror the account handed to app-directory reviewers.
-- Everything here is fake: invented company, @example.com teammates, fake devices.
-- Login: demo@capgo.app / demodemo. MCP / API key: acde0000-0000-4000-8000-00000000c0de
-- Isolated from the test fixtures: own users, org, apps (com.acme.*) and API keys.
-- Re-running `SELECT public.reset_and_seed_demo_customer_data()` rebuilds the telemetry.
-- The account itself is only created once: deleting apps queues async cleanup jobs
-- that would race with re-inserted rows.

-- Demo customer, part 1: users, org, apps, bundles, channels, builds, push, webhooks, audit trail.
CREATE OR REPLACE FUNCTION "public"."seed_demo_customer_account" () RETURNS "void" LANGUAGE "plpgsql"
SET
  search_path = '' SECURITY DEFINER AS $_$
DECLARE
  v_owner uuid := 'acde0000-0000-4000-8000-000000000001'::uuid;
  v_admin uuid := 'acde0000-0000-4000-8000-000000000002'::uuid;
  v_dev uuid := 'acde0000-0000-4000-8000-000000000003'::uuid;
  v_org uuid := 'acde0000-0000-4000-8000-0000000000a1'::uuid;
  v_customer text := 'cus_demo_acme_mobile';
  v_apps text[] := ARRAY['com.acme.shop', 'com.acme.driver', 'com.acme.internal'];
  v_password text := '$2a$10$/./S9gS8W0hA7ECm2DqZWOZPZPaDnoFJ75eRAW.vFZtNEaB0P8cUK'; -- demodemo
  v_mcp_key text := 'acde0000-0000-4000-8000-00000000c0de';
  v_ci_key text := 'acde0000-0000-4000-8000-00000000c1c1';
  v_webhook_releases uuid := 'acde0000-0000-4000-8000-0000000000b1'::uuid;
  v_webhook_analytics uuid := 'acde0000-0000-4000-8000-0000000000b2'::uuid;
BEGIN
  PERFORM pg_catalog.set_config('capgo.seed_channel_targets', 'true', true);
  SET LOCAL client_min_messages = WARNING;
  -- Seed-time audit rows are replaced below, so do not queue webhook dispatches for them.
  ALTER TABLE public.audit_logs DISABLE TRIGGER on_audit_log_webhook;

  -- ------------------------------------------------------------------
  -- Users: the owner logs in, teammates are clearly fake @example.com people
  -- ------------------------------------------------------------------
  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, invited_at, confirmation_token, confirmation_sent_at, recovery_token, recovery_sent_at, email_change_token_new, email_change, email_change_sent_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at, phone, phone_confirmed_at, phone_change, phone_change_token, phone_change_sent_at, email_change_token_current, email_change_confirm_status, banned_until, reauthentication_token, reauthentication_sent_at) VALUES
    ('00000000-0000-0000-0000-000000000000', v_owner, 'authenticated', 'authenticated', 'demo@capgo.app', v_password, pg_catalog.now() - interval '400 days', NULL, '', NULL, '', NULL, '', '', NULL, pg_catalog.now() - interval '2 hours', '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "demo_customer_owner"}', false, pg_catalog.now() - interval '400 days', pg_catalog.now(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated', 'maya.chen@example.com', v_password, pg_catalog.now() - interval '380 days', NULL, '', NULL, '', NULL, '', '', NULL, pg_catalog.now() - interval '1 day', '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "demo_customer_admin"}', false, pg_catalog.now() - interval '380 days', pg_catalog.now(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL),
    ('00000000-0000-0000-0000-000000000000', v_dev, 'authenticated', 'authenticated', 'jordan.lee@example.com', v_password, pg_catalog.now() - interval '150 days', NULL, '', NULL, '', NULL, '', '', NULL, pg_catalog.now() - interval '3 days', '{"provider": "email", "providers": ["email"]}', '{"test_identifier": "demo_customer_developer"}', false, pg_catalog.now() - interval '150 days', pg_catalog.now(), NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL);

  INSERT INTO public.users (created_at, image_url, first_name, last_name, country, email, id, updated_at, enable_notifications, opt_for_newsletters) VALUES
    (pg_catalog.now() - interval '400 days', '', 'Alex', 'Rivera', 'US', 'demo@capgo.app', v_owner, pg_catalog.now(), true, false),
    (pg_catalog.now() - interval '380 days', '', 'Maya', 'Chen', 'CA', 'maya.chen@example.com', v_admin, pg_catalog.now(), true, false),
    (pg_catalog.now() - interval '150 days', '', 'Jordan', 'Lee', 'GB', 'jordan.lee@example.com', v_dev, pg_catalog.now(), true, false);

  -- ------------------------------------------------------------------
  -- Organization on a paid Team plan, mid billing cycle
  -- ------------------------------------------------------------------
  INSERT INTO public.stripe_info (created_at, updated_at, subscription_id, customer_id, status, product_id, trial_at, price_id, is_good_plan, plan_usage, subscription_anchor_start, subscription_anchor_end, mau_exceeded, bandwidth_exceeded, storage_exceeded, build_time_exceeded, paid_at, upgraded_at, customer_country)
  VALUES (pg_catalog.now() - interval '400 days', pg_catalog.now(), 'sub_demo_acme_mobile', v_customer, 'succeeded', 'prod_LQIugvJcPrxhda', pg_catalog.now() - interval '385 days', 'price_1KjSIUGH46eYKnWwWHvg8XYs', true, 34, pg_catalog.date_trunc('day', pg_catalog.now()) - interval '12 days', pg_catalog.date_trunc('day', pg_catalog.now()) + interval '18 days', false, false, false, false, pg_catalog.now() - interval '12 days', pg_catalog.now() - interval '210 days', 'US');

  ALTER TABLE public.orgs DISABLE TRIGGER generate_org_user_stripe_info_on_org_create;
  INSERT INTO public.orgs (id, created_by, created_at, updated_at, logo, name, management_email, customer_id, website)
  VALUES (v_org, v_owner, pg_catalog.now() - interval '400 days', pg_catalog.now(), '', 'Acme Mobile', 'demo@capgo.app', v_customer, 'https://acme-mobile.example.com');
  ALTER TABLE public.orgs ENABLE TRIGGER generate_org_user_stripe_info_on_org_create;

  INSERT INTO public.org_users (org_id, user_id, rbac_role_name, app_id, channel_id, is_invite, created_at) VALUES
    (v_org, v_owner, public.rbac_role_org_super_admin(), NULL, NULL, false, pg_catalog.now() - interval '400 days'),
    (v_org, v_admin, public.rbac_role_org_admin(), NULL, NULL, false, pg_catalog.now() - interval '380 days'),
    (v_org, v_dev, public.rbac_role_org_member(), NULL, NULL, false, pg_catalog.now() - interval '150 days');

  INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct)
  SELECT public.rbac_principal_user(), ou.user_id, roles.id, public.rbac_scope_org(), ou.org_id, v_owner, 'Seeded demo customer binding', true
  FROM public.org_users ou
  JOIN public.roles roles ON roles.name = ou.rbac_role_name AND roles.scope_type = public.rbac_scope_org()
  WHERE ou.org_id = v_org
  ON CONFLICT DO NOTHING;

  -- ------------------------------------------------------------------
  -- Apps (icons are inline SVG data URIs so they render offline)
  -- ------------------------------------------------------------------
  -- Long-running apps: onboarding finished and the getting-started checklist dismissed.
  INSERT INTO public.apps (created_at, app_id, icon_url, name, last_version, updated_at, owner_org, user_id, retention, need_onboarding, existing_app, onboarding_completed_at, default_upload_channel, onboarding)
  SELECT pg_catalog.now() - a.age, a.app_id,
    'data:image/svg+xml;base64,' || pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="' || a.color || '"/>'
      || '<text x="32" y="43" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">' || a.letter || '</text></svg>',
      'UTF8'), 'base64'), E'\n', ''),
    a.name, a.last_version, pg_catalog.now(), v_org, v_owner, 7776000, false, true, pg_catalog.now() - a.age + interval '1 hour', 'production',
    pg_catalog.jsonb_build_object(
      'getting_started_dismissed_at', pg_catalog.to_char((pg_catalog.now() - a.age + interval '2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'setup', pg_catalog.jsonb_build_object('source', 'cli', 'outcome', 'completed')
    )
  FROM (VALUES
    ('com.acme.shop', 'Acme Shop', '2.5.0-beta.1', interval '390 days', '#E8590C', 'S'),
    ('com.acme.driver', 'Acme Driver', '3.5.0-rc.1', interval '260 days', '#1971C2', 'D'),
    ('com.acme.internal', 'Acme Field Ops', '1.3.0', interval '120 days', '#2B8A3E', 'F')
  ) AS a(app_id, name, last_version, age, color, letter);

  -- Jordan (org member) works on the two customer-facing apps only.
  INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by, reason, is_direct)
  SELECT public.rbac_principal_user(), v_dev, roles.id, public.rbac_scope_app(), v_org, apps.id, v_owner, 'Seeded demo customer app binding', true
  FROM public.apps apps
  JOIN public.roles roles ON roles.name = public.rbac_role_app_developer() AND roles.scope_type = public.rbac_scope_app()
  WHERE apps.app_id IN ('com.acme.shop', 'com.acme.driver')
  ON CONFLICT DO NOTHING;

  -- ------------------------------------------------------------------
  -- API keys: the MCP key (org super admin) and a CI uploader key
  -- ------------------------------------------------------------------
  PERFORM pg_catalog.set_config('capgo.skip_apikey_trigger', 'true', true);
  INSERT INTO public.apikeys (id, created_at, user_id, key, updated_at, name) VALUES
    (9001, pg_catalog.now() - interval '20 days', v_owner, v_mcp_key, pg_catalog.now(), 'Claude MCP (demo)'),
    (9002, pg_catalog.now() - interval '200 days', v_owner, v_ci_key, pg_catalog.now(), 'GitHub Actions uploader');
  PERFORM pg_catalog.set_config('capgo.skip_apikey_trigger', 'false', true);

  INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct)
  SELECT public.rbac_principal_apikey(), ak.rbac_id, roles.id, public.rbac_scope_org(), v_org, v_owner, 'Seeded demo customer API key binding', true
  FROM public.apikeys ak
  JOIN public.roles roles ON roles.name = public.rbac_role_org_super_admin() AND roles.scope_type = public.rbac_scope_org()
  WHERE ak.id = 9001
  ON CONFLICT DO NOTHING;

  INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, app_id, granted_by, reason, is_direct)
  SELECT public.rbac_principal_apikey(), ak.rbac_id, roles.id, public.rbac_scope_app(), v_org, apps.id, v_owner, 'Seeded demo customer CI binding', true
  FROM public.apikeys ak
  CROSS JOIN public.apps apps
  JOIN public.roles roles ON roles.name = public.rbac_role_app_uploader() AND roles.scope_type = public.rbac_scope_app()
  WHERE ak.id = 9002 AND apps.app_id IN ('com.acme.shop', 'com.acme.driver')
  ON CONFLICT DO NOTHING;

  -- ------------------------------------------------------------------
  -- Bundles: semver history over ~60 days, one deleted bad release
  -- ------------------------------------------------------------------
  -- Skip the async on_version_create job: it would email the org for every seeded
  -- bundle and race to overwrite apps.last_version in queue order.
  ALTER TABLE public.app_versions DISABLE TRIGGER on_version_create;
  INSERT INTO public.app_versions (created_at, updated_at, app_id, name, r2_path, deleted, deleted_at, checksum, storage_provider, owner_org, user_id, comment, link, native_packages, cli_version, min_update_version)
  SELECT
    pg_catalog.now() - v.age,
    pg_catalog.now() - v.age,
    v.app_id,
    v.name,
    'orgs/' || v_org::text || '/apps/' || v.app_id || '/' || v.name || '.zip',
    v.is_deleted,
    CASE WHEN v.is_deleted THEN pg_catalog.now() - v.age + interval '5 hours' END,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v.app_id || '@' || v.name, 'UTF8')), 'hex'),
    'r2',
    v_org,
    CASE WHEN v.by_ci THEN v_owner ELSE v_admin END,
    v.comment,
    'https://github.com/acme-mobile/' || pg_catalog.split_part(v.app_id, '.', 3) || '/releases/tag/v' || v.name,
    CASE WHEN v.cap = 6 THEN ARRAY[
      '{"name":"@capacitor/core","version":"6.2.1"}', '{"name":"@capacitor/app","version":"6.0.2"}',
      '{"name":"@capacitor/camera","version":"6.1.2"}', '{"name":"@capacitor/push-notifications","version":"6.0.4"}',
      '{"name":"@capgo/capacitor-updater","version":"6.14.9"}'
    ]::jsonb[] ELSE ARRAY[
      '{"name":"@capacitor/core","version":"7.4.3"}', '{"name":"@capacitor/app","version":"7.1.0"}',
      '{"name":"@capacitor/camera","version":"7.0.2"}', '{"name":"@capacitor/push-notifications","version":"7.0.3"}',
      '{"name":"@capacitor/geolocation","version":"7.1.5"}', '{"name":"@capgo/capacitor-updater","version":"7.34.1"}'
    ]::jsonb[] END,
    CASE WHEN v.cap = 6 THEN '6.17.2' ELSE '7.42.0' END,
    v.min_update
  FROM (VALUES
    ('com.acme.shop', '1.8.0', interval '58 days', 'Spring catalog refresh', 6, false, true, NULL),
    ('com.acme.shop', '1.8.1', interval '54 days 3 hours', 'Fix promo banner overflow on small screens', 6, false, true, NULL),
    ('com.acme.shop', '1.9.0', interval '49 days 5 hours', 'Wishlist sync across devices', 6, false, false, NULL),
    ('com.acme.shop', '1.9.1', interval '45 days 2 hours', 'Hotfix: Apple Pay sheet dismissed twice', 6, false, true, NULL),
    ('com.acme.shop', '1.9.2', interval '41 days 6 hours', 'Image caching on slow networks', 6, false, true, NULL),
    ('com.acme.shop', '2.0.0', interval '36 days 4 hours', 'New checkout flow on the Capacitor 7 runtime', 7, false, false, '2.0.0'),
    ('com.acme.shop', '2.0.1', interval '33 days 1 hour', 'Fix address autocomplete on Android', 7, false, true, '2.0.0'),
    ('com.acme.shop', '2.1.0', interval '28 days 7 hours', 'Order tracking timeline', 7, false, true, '2.0.0'),
    ('com.acme.shop', '2.2.0', interval '22 days 2 hours', 'Loyalty points and referral codes', 7, false, false, '2.0.0'),
    ('com.acme.shop', '2.2.1', interval '20 days 9 hours', 'Loyalty points rounding (pulled: wrong totals)', 7, true, true, '2.0.0'),
    ('com.acme.shop', '2.3.0', interval '15 days 3 hours', 'Faster product search', 7, false, true, '2.0.0'),
    ('com.acme.shop', '2.3.1', interval '11 days 5 hours', 'Fix cart badge after logout', 7, false, true, '2.0.0'),
    ('com.acme.shop', '2.4.0', interval '7 days 2 hours', 'Saved carts and one-tap reorder', 7, false, false, '2.0.0'),
    ('com.acme.shop', '2.4.1', interval '2 days 4 hours', 'Fix crash when opening email deep links', 7, false, true, '2.0.0'),
    ('com.acme.shop', '2.5.0-beta.1', interval '1 day 3 hours', 'Beta: redesigned home feed', 7, false, true, '2.0.0'),
    ('com.acme.driver', '3.0.0', interval '57 days 2 hours', 'Route planner rewrite', 6, false, false, NULL),
    ('com.acme.driver', '3.0.1', interval '52 days 6 hours', 'Fix GPS drift in tunnels', 6, false, true, NULL),
    ('com.acme.driver', '3.1.0', interval '44 days 1 hour', 'Proof of delivery photos', 7, false, false, '3.1.0'),
    ('com.acme.driver', '3.1.1', interval '39 days 3 hours', 'Compress delivery photos before upload', 7, false, true, '3.1.0'),
    ('com.acme.driver', '3.2.0', interval '31 days 4 hours', 'Offline queue for scans', 7, false, true, '3.1.0'),
    ('com.acme.driver', '3.2.1', interval '25 days 2 hours', 'Barcode scanner focus fix', 7, false, true, '3.1.0'),
    ('com.acme.driver', '3.3.0', interval '18 days 5 hours', 'Shift summary screen', 7, false, false, '3.1.0'),
    ('com.acme.driver', '3.3.1', interval '12 days 2 hours', 'Fix shift timer after background', 7, false, true, '3.1.0'),
    ('com.acme.driver', '3.4.0', interval '6 days 6 hours', 'Turn-by-turn handoff to Maps', 7, false, true, '3.1.0'),
    ('com.acme.driver', '3.4.1', interval '3 days 1 hour', 'Battery usage improvements', 7, false, true, '3.1.0'),
    ('com.acme.driver', '3.5.0-rc.1', interval '20 hours', 'RC: multi-stop optimisation', 7, false, true, '3.1.0'),
    ('com.acme.internal', '0.9.0', interval '55 days', 'Pilot for warehouse leads', 7, false, false, NULL),
    ('com.acme.internal', '1.0.0', interval '46 days 3 hours', 'First company-wide release', 7, false, false, NULL),
    ('com.acme.internal', '1.0.1', interval '39 days 2 hours', 'SSO session refresh fix', 7, false, true, NULL),
    ('com.acme.internal', '1.1.0', interval '31 days 5 hours', 'Inventory count mode', 7, false, true, NULL),
    ('com.acme.internal', '1.1.1', interval '25 days 1 hour', 'Fix CSV export encoding', 7, false, true, NULL),
    ('com.acme.internal', '1.2.0', interval '16 days 4 hours', 'Shift handover notes', 7, false, true, NULL),
    ('com.acme.internal', '1.2.1', interval '9 days 2 hours', 'Dark mode for night shifts', 7, false, true, NULL),
    ('com.acme.internal', '1.3.0', interval '4 days 3 hours', 'Barcode bulk scan', 7, false, true, NULL)
  ) AS v(app_id, name, age, comment, cap, is_deleted, by_ci, min_update);

  ALTER TABLE public.app_versions ENABLE TRIGGER on_version_create;

  INSERT INTO public.app_versions_meta (id, created_at, updated_at, app_id, checksum, size, owner_org)
  SELECT av.id, av.created_at, av.created_at, av.app_id, av.checksum,
    CASE av.app_id
      WHEN 'com.acme.shop' THEN 4100000 + (pg_catalog.hashtext(av.name) & 1023) * 700
      WHEN 'com.acme.driver' THEN 2900000 + (pg_catalog.hashtext(av.name) & 1023) * 500
      ELSE 1700000 + (pg_catalog.hashtext(av.name) & 1023) * 300
    END,
    v_org
  FROM public.app_versions av
  WHERE av.app_id = ANY (v_apps);

  -- ------------------------------------------------------------------
  -- Channels: production (public, progressive rollout on the shop), beta, internal
  -- ------------------------------------------------------------------
  INSERT INTO public.channels (created_at, updated_at, name, app_id, version, public, disable_auto_update_under_native, disable_auto_update, ios, android, electron, allow_device_self_set, allow_emulator, allow_device, allow_dev, allow_prod, created_by, owner_org,
    rollout_version, rollout_enabled, rollout_percentage_bps, auto_pause_enabled, auto_pause_window_minutes, auto_pause_failure_rate_bps, auto_pause_min_attempts, auto_pause_min_failures, auto_pause_action)
  SELECT pg_catalog.now() - c.age, pg_catalog.now() - c.touched, c.name, c.app_id,
    (SELECT av.id FROM public.app_versions av WHERE av.app_id = c.app_id AND av.name = c.version_name),
    c.is_public, true, c.disable_auto_update::public.disable_update, true, true, false, c.self_set, c.emulators, true, c.dev_builds, true, v_owner, v_org,
    (SELECT av.id FROM public.app_versions av WHERE av.app_id = c.app_id AND av.name = c.rollout_name),
    c.rollout_name IS NOT NULL, c.rollout_bps, c.rollout_name IS NOT NULL, 60,
    CASE WHEN c.rollout_name IS NOT NULL THEN 300 END,
    CASE WHEN c.rollout_name IS NOT NULL THEN 200 END,
    CASE WHEN c.rollout_name IS NOT NULL THEN 20 END,
    'pause'
  FROM (VALUES
    ('com.acme.shop', 'production', '2.4.0', '2.4.1', 2500, true, false, false, false, 'major', interval '380 days', interval '2 days 3 hours'),
    ('com.acme.shop', 'beta', '2.5.0-beta.1', NULL, 0, false, true, true, true, 'major', interval '300 days', interval '1 day 3 hours'),
    ('com.acme.shop', 'internal', '2.4.1', NULL, 0, false, false, true, true, 'none', interval '300 days', interval '2 days 4 hours'),
    ('com.acme.driver', 'production', '3.4.1', NULL, 0, true, false, false, false, 'major', interval '255 days', interval '2 days 20 hours'),
    ('com.acme.driver', 'beta', '3.5.0-rc.1', NULL, 0, false, true, true, true, 'major', interval '200 days', interval '20 hours'),
    ('com.acme.driver', 'internal', '3.5.0-rc.1', NULL, 0, false, false, true, true, 'none', interval '200 days', interval '20 hours'),
    ('com.acme.internal', 'production', '1.2.1', NULL, 0, true, false, false, false, 'major', interval '118 days', interval '8 days 20 hours'),
    ('com.acme.internal', 'beta', '1.3.0', NULL, 0, false, true, true, true, 'major', interval '110 days', interval '4 days 3 hours'),
    ('com.acme.internal', 'internal', '1.3.0', NULL, 0, false, false, true, true, 'none', interval '110 days', interval '4 days 3 hours')
  ) AS c(app_id, name, version_name, rollout_name, rollout_bps, is_public, self_set, emulators, dev_builds, disable_auto_update, age, touched);

  -- Deploy history: every non-deleted bundle reached beta first, then production a day later.
  DELETE FROM public.deploy_history WHERE app_id = ANY (v_apps);
  INSERT INTO public.deploy_history (created_at, updated_at, deployed_at, channel_id, app_id, version_id, owner_org, created_by)
  SELECT d.at, d.at, d.at, ch.id, av.app_id, av.id, v_org, CASE WHEN ch.name = 'production' THEN v_admin ELSE v_owner END
  FROM public.app_versions av
  JOIN public.channels ch ON ch.app_id = av.app_id
  CROSS JOIN LATERAL (
    SELECT CASE ch.name
      WHEN 'production' THEN av.created_at + interval '22 hours'
      ELSE av.created_at + interval '20 minutes'
    END AS at
  ) d
  WHERE av.app_id = ANY (v_apps)
    AND av.deleted = false
    AND ch.name IN ('production', 'beta')
    AND (
      ch.name = 'beta'
      OR (
        av.name NOT LIKE '%-%'
        AND av.created_at <= (SELECT cur.created_at FROM public.app_versions cur WHERE cur.id = ch.version)
      )
    );

  -- ----------------------------------------------------------------
  -- Native cloud builds (status and billing rows, logs stream from the builder)
  -- ----------------------------------------------------------------
  INSERT INTO public.build_requests (app_id, owner_org, requested_by, platform, build_mode, build_config, status, builder_job_id, upload_session_key, upload_path, upload_url, upload_expires_at, last_error, created_at, updated_at, started_at, completed_at, runner_wait_seconds)
  SELECT b.app_id, v_org, CASE WHEN b.n % 3 = 0 THEN v_dev ELSE v_admin END, b.platform, b.mode,
    pg_catalog.jsonb_build_object('scheme', CASE WHEN b.platform = 'ios' THEN 'App' END, 'flavor', CASE WHEN b.platform = 'android' THEN 'production' END),
    b.status, 'job-acme-' || pg_catalog.split_part(b.app_id, '.', 3) || '-' || pg_catalog.lpad(b.n::text, 3, '0'),
    'acme-build-session-' || pg_catalog.split_part(b.app_id, '.', 3) || '-' || b.n,
    'orgs/' || v_org::text || '/apps/' || b.app_id || '/builds/' || b.n || '.zip',
    'https://builder.example.com/upload/' || b.n,
    pg_catalog.now() - b.age + interval '1 hour',
    b.err,
    pg_catalog.now() - b.age, pg_catalog.now() - b.age + b.secs * interval '1 second',
    pg_catalog.now() - b.age + interval '35 seconds',
    CASE WHEN b.status IN ('succeeded', 'failed', 'cancelled') THEN pg_catalog.now() - b.age + interval '35 seconds' + b.secs * interval '1 second' END,
    8 + b.n % 20
  FROM (VALUES
    ('com.acme.shop', 1, 'ios', 'release', 'succeeded', interval '56 days', 642, NULL),
    ('com.acme.shop', 2, 'android', 'release', 'succeeded', interval '56 days 1 hour', 401, NULL),
    ('com.acme.shop', 3, 'ios', 'release', 'failed', interval '37 days', 133, 'Provisioning profile "Acme Shop App Store" does not include the Push Notifications capability'),
    ('com.acme.shop', 4, 'ios', 'release', 'succeeded', interval '36 days 20 hours', 655, NULL),
    ('com.acme.shop', 5, 'android', 'release', 'succeeded', interval '36 days 19 hours', 418, NULL),
    ('com.acme.shop', 6, 'android', 'debug', 'succeeded', interval '22 days', 287, NULL),
    ('com.acme.shop', 7, 'ios', 'release', 'succeeded', interval '8 days', 611, NULL),
    ('com.acme.shop', 8, 'android', 'release', 'failed', interval '7 days 22 hours', 94, 'Execution failed for task '':app:processReleaseGoogleServices'': File google-services.json is missing'),
    ('com.acme.shop', 9, 'android', 'release', 'succeeded', interval '7 days 20 hours', 409, NULL),
    ('com.acme.shop', 10, 'ios', 'release', 'succeeded', interval '1 day 2 hours', 598, NULL),
    ('com.acme.shop', 11, 'android', 'release', 'succeeded', interval '1 day 1 hour', 396, NULL),
    ('com.acme.driver', 1, 'android', 'release', 'succeeded', interval '50 days', 377, NULL),
    ('com.acme.driver', 2, 'ios', 'release', 'succeeded', interval '44 days', 588, NULL),
    ('com.acme.driver', 3, 'android', 'release', 'succeeded', interval '44 days 2 hours', 365, NULL),
    ('com.acme.driver', 4, 'android', 'release', 'cancelled', interval '18 days', 61, 'Cancelled by user'),
    ('com.acme.driver', 5, 'android', 'release', 'succeeded', interval '17 days 23 hours', 381, NULL),
    ('com.acme.driver', 6, 'ios', 'release', 'succeeded', interval '17 days 22 hours', 602, NULL),
    ('com.acme.internal', 1, 'ios', 'release', 'succeeded', interval '46 days', 521, NULL),
    ('com.acme.internal', 2, 'android', 'release', 'succeeded', interval '46 days 1 hour', 344, NULL),
    ('com.acme.internal', 3, 'ios', 'release', 'succeeded', interval '16 days', 533, NULL)
  ) AS b(app_id, n, platform, mode, status, age, secs, err);

  INSERT INTO public.build_logs (created_at, org_id, user_id, build_id, platform, billable_seconds, build_time_unit, app_id)
  SELECT br.completed_at, br.owner_org, br.requested_by, br.builder_job_id, br.platform,
    pg_catalog.ceil(EXTRACT(EPOCH FROM br.completed_at - br.started_at))::bigint,
    pg_catalog.ceil(EXTRACT(EPOCH FROM br.completed_at - br.started_at))::bigint * CASE WHEN br.platform = 'ios' THEN 2 ELSE 1 END,
    br.app_id
  FROM public.build_requests br
  WHERE br.app_id = ANY (v_apps) AND br.completed_at IS NOT NULL AND br.status IN ('succeeded', 'failed');

  -- ----------------------------------------------------------------
  -- Push notifications (providers, push-to-update settings, campaigns)
  -- ----------------------------------------------------------------
  INSERT INTO public.notification_app_settings (owner_org, app_id, push_update_enabled, push_update_install_mode, push_update_channel, created_by, created_at, updated_at)
  VALUES
    (v_org, 'com.acme.shop', true, 'next', 'production', v_owner, pg_catalog.now() - interval '40 days', pg_catalog.now() - interval '40 days'),
    (v_org, 'com.acme.driver', true, 'set', NULL, v_admin, pg_catalog.now() - interval '25 days', pg_catalog.now() - interval '25 days');

  INSERT INTO public.notification_provider_configs (owner_org, app_id, provider, status, config, secret_ref, created_by, created_at, updated_at)
  SELECT v_org, p.app_id, p.provider, p.status, p.config::jsonb,
    'NOTIFICATIONS_' || pg_catalog.upper(pg_catalog.replace(p.app_id, '.', '_')) || '_' || CASE WHEN p.provider = 'apns' THEN 'IOS' ELSE 'ANDROID' END,
    v_owner, pg_catalog.now() - p.age, pg_catalog.now() - p.age
  FROM (VALUES
    ('com.acme.shop', 'apns', 'configured', '{"teamId":"A1B2C3D4E5","keyId":"KEY0ACME01","bundleId":"com.acme.shop","environment":"production"}', interval '120 days'),
    ('com.acme.shop', 'fcm', 'configured', '{"projectId":"acme-shop-demo"}', interval '120 days'),
    ('com.acme.driver', 'fcm', 'configured', '{"projectId":"acme-driver-demo"}', interval '60 days'),
    ('com.acme.driver', 'apns', 'draft', '{"teamId":"A1B2C3D4E5","bundleId":"com.acme.driver"}', interval '10 days')
  ) AS p(app_id, provider, status, config, age);

  INSERT INTO public.notification_campaigns (owner_org, app_id, name, kind, status, audience, payload, scheduled_at, queued_at, completed_at, counters, created_by, created_at, updated_at)
  SELECT v_org, c.app_id, c.name, c.kind, c.status, c.audience::jsonb, c.payload::jsonb,
    CASE WHEN c.status = 'scheduled' THEN pg_catalog.now() + interval '2 days' END,
    CASE WHEN c.status <> 'scheduled' THEN pg_catalog.now() - c.age END,
    CASE WHEN c.status = 'sent' THEN pg_catalog.now() - c.age + interval '95 seconds' END,
    c.counters::jsonb, v_admin, pg_catalog.now() - c.age - interval '10 minutes', pg_catalog.now() - c.age
  FROM (VALUES
    ('com.acme.shop', 'Weekend sale is live', 'alert', 'sent', '{"broadcast":true,"platforms":["ios","android"]}', '{"title":"Weekend sale is live","body":"20% off everything until Sunday","data":{"route":"/catalog"}}', '{"targeted":2410,"sent":2388,"opened":402,"failed":22}', interval '3 days 4 hours'),
    ('com.acme.shop', 'Check for 2.4.0', 'update_check', 'sent', '{"broadcast":true,"platforms":["ios","android"]}', '{}', '{"targeted":2655,"sent":2631,"failed":24}', interval '7 days'),
    ('com.acme.shop', 'Your order shipped', 'alert', 'sent', '{"externalIds":["usr_4c2f1a9e07b3"]}', '{"title":"Your order is on its way","body":"Track order #48213","data":{"route":"/orders"}}', '{"targeted":1,"sent":1,"opened":1}', interval '5 hours'),
    ('com.acme.shop', 'Cart badge refresh', 'badge', 'sent', '{"tag":"cart_not_empty"}', '{"badge":1}', '{"targeted":318,"sent":316,"failed":2}', interval '1 day 6 hours'),
    ('com.acme.shop', 'Saved carts launch', 'alert', 'scheduled', '{"broadcast":true,"platforms":["ios","android"]}', '{"title":"Save it for later","body":"Try saved carts and one-tap reorder"}', '{"targeted":0}', interval '0 days'),
    ('com.acme.driver', 'Shift reminder', 'alert', 'sent', '{"tag":"shift_tomorrow"}', '{"title":"Shift starts at 7:00","body":"Check your route before leaving"}', '{"targeted":212,"sent":212,"opened":171}', interval '18 hours'),
    ('com.acme.driver', 'Force update check 3.4.1', 'update_check', 'sent', '{"broadcast":true,"platforms":["android"]}', '{}', '{"targeted":688,"sent":680,"failed":8}', interval '2 days 22 hours')
  ) AS c(app_id, name, kind, status, audience, payload, counters, age);

  -- ----------------------------------------------------------------
  -- Audit trail: replace the system rows created by the inserts above with
  -- a readable history attributed to teammates and the CI key.
  -- ----------------------------------------------------------------
  DELETE FROM public.audit_logs WHERE org_id = v_org;
  INSERT INTO public.audit_logs (created_at, table_name, record_id, operation, user_id, org_id, old_record, new_record, changed_fields, actor_type, actor_user_id, actor_user_email, actor_apikey_id, actor_apikey_name)
  SELECT av.created_at, 'app_versions', av.id::text, 'INSERT', v_owner, v_org, NULL,
    pg_catalog.jsonb_build_object('id', av.id, 'app_id', av.app_id, 'name', av.name, 'comment', av.comment, 'checksum', av.checksum),
    NULL, 'apikey', v_owner, 'demo@capgo.app', 9002, 'GitHub Actions uploader'
  FROM public.app_versions av
  WHERE av.app_id = ANY (v_apps) AND av.created_at > pg_catalog.now() - interval '29 days'
  UNION ALL
  SELECT dh.deployed_at, 'channels', dh.channel_id::text, 'UPDATE',
    dh.created_by, v_org,
    pg_catalog.jsonb_build_object('id', dh.channel_id, 'name', ch.name),
    pg_catalog.jsonb_build_object('id', dh.channel_id, 'name', ch.name, 'version', dh.version_id),
    ARRAY['version'], 'user', dh.created_by,
    CASE WHEN dh.created_by = v_admin THEN 'maya.chen@example.com' ELSE 'demo@capgo.app' END, NULL, NULL
  FROM public.deploy_history dh
  JOIN public.channels ch ON ch.id = dh.channel_id
  WHERE dh.app_id = ANY (v_apps) AND dh.deployed_at > pg_catalog.now() - interval '29 days'
  UNION ALL
  SELECT pg_catalog.now() - interval '20 days 9 hours' + interval '5 hours', 'app_versions', av.id::text, 'UPDATE', v_admin, v_org,
    pg_catalog.jsonb_build_object('id', av.id, 'name', av.name, 'deleted', false),
    pg_catalog.jsonb_build_object('id', av.id, 'name', av.name, 'deleted', true),
    ARRAY['deleted'], 'user', v_admin, 'maya.chen@example.com', NULL, NULL
  FROM public.app_versions av WHERE av.app_id = 'com.acme.shop' AND av.name = '2.2.1'
  UNION ALL
  SELECT ch.updated_at, 'channels', ch.id::text, 'UPDATE', v_admin, v_org,
    pg_catalog.jsonb_build_object('id', ch.id, 'name', ch.name, 'rollout_enabled', false, 'rollout_percentage_bps', 0),
    pg_catalog.jsonb_build_object('id', ch.id, 'name', ch.name, 'rollout_enabled', true, 'rollout_percentage_bps', 2500, 'rollout_version', ch.rollout_version),
    ARRAY['rollout_enabled', 'rollout_percentage_bps', 'rollout_version'], 'user', v_admin, 'maya.chen@example.com', NULL, NULL
  FROM public.channels ch WHERE ch.app_id = ANY (v_apps) AND ch.rollout_enabled
  UNION ALL
  SELECT pg_catalog.now() - interval '26 days', 'org_users', '0', 'UPDATE', v_owner, v_org,
    pg_catalog.jsonb_build_object('user_id', v_dev, 'rbac_role_name', 'org_member'),
    pg_catalog.jsonb_build_object('user_id', v_dev, 'rbac_role_name', 'org_member', 'app_roles', pg_catalog.jsonb_build_array('app_developer')),
    ARRAY['app_roles'], 'user', v_owner, 'demo@capgo.app', NULL, NULL
  UNION ALL
  SELECT pg_catalog.now() - interval '14 days', 'apps', a.id::text, 'UPDATE', v_owner, v_org,
    pg_catalog.jsonb_build_object('app_id', a.app_id, 'retention', 2592000),
    pg_catalog.jsonb_build_object('app_id', a.app_id, 'retention', 7776000),
    ARRAY['retention'], 'user', v_owner, 'demo@capgo.app', NULL, NULL
  FROM public.apps a WHERE a.app_id = 'com.acme.shop';

  -- ----------------------------------------------------------------
  -- Webhooks (inserted after the audit rows so seeding does not queue deliveries)
  -- ----------------------------------------------------------------
  INSERT INTO public.webhooks (id, org_id, name, url, secret, enabled, events, created_at, updated_at, created_by, delivery_version)
  VALUES
    (v_webhook_releases, v_org, 'Release notes to Slack', 'https://hooks.acme-mobile.example.com/capgo/releases', 'whsec_demo_acme_releases_0000000000000000', true, ARRAY['app_versions'], pg_catalog.now() - interval '90 days', pg_catalog.now() - interval '30 days', v_admin, 'standard'),
    (v_webhook_analytics, v_org, 'Warehouse sync (paused)', 'https://etl.acme-mobile.example.com/ingest/capgo', 'whsec_demo_acme_warehouse_000000000000000', false, ARRAY['apps', 'org_users', 'orgs'], pg_catalog.now() - interval '200 days', pg_catalog.now() - interval '12 days', v_owner, 'legacy');

  INSERT INTO public.webhook_deliveries (webhook_id, org_id, audit_log_id, event_type, status, request_payload, response_status, response_body, response_headers, attempt_count, max_attempts, next_retry_at, created_at, completed_at, duration_ms, delivery_version)
  SELECT v_webhook_releases, v_org, al.id, al.table_name || '.' || al.operation,
    CASE WHEN al.rn % 7 = 4 THEN 'failed' ELSE 'success' END,
    pg_catalog.jsonb_build_object(
      'type', al.table_name || '.' || al.operation, 'event', al.table_name || '.' || al.operation,
      'event_id', pg_catalog.md5('acme-webhook-' || al.id::text)::uuid, 'timestamp', al.created_at, 'org_id', v_org,
      'data', pg_catalog.jsonb_build_object('table', al.table_name, 'operation', al.operation, 'record_id', al.record_id, 'new_record', al.new_record, 'changed_fields', al.changed_fields, 'actor_type', al.actor_type, 'actor_user_email', al.actor_user_email)
    ),
    CASE WHEN al.rn % 7 = 4 THEN 502 ELSE 200 END,
    CASE WHEN al.rn % 7 = 4 THEN '<html><body>502 Bad Gateway</body></html>' ELSE '{"ok":true}' END,
    CASE WHEN al.rn % 7 = 4 THEN '{"content-type":"text/html"}'::jsonb ELSE '{"content-type":"application/json"}'::jsonb END,
    CASE WHEN al.rn % 7 = 4 THEN 5 ELSE 1 END, 5, NULL,
    al.created_at + interval '2 seconds',
    al.created_at + interval '2 seconds' + CASE WHEN al.rn % 7 = 4 THEN interval '3 hours' ELSE interval '0 seconds' END,
    CASE WHEN al.rn % 7 = 4 THEN 10000 ELSE 140 + (al.rn * 37) % 260 END,
    'standard'
  FROM (
    SELECT a.*, pg_catalog.row_number() OVER (ORDER BY a.created_at) AS rn
    FROM public.audit_logs a
    WHERE a.org_id = v_org AND a.table_name = 'app_versions'
  ) al;

  ALTER TABLE public.audit_logs ENABLE TRIGGER on_audit_log_webhook;
END;
$_$;

ALTER FUNCTION "public"."seed_demo_customer_account" () OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."seed_demo_customer_account" ()
FROM
  PUBLIC;

GRANT ALL ON FUNCTION "public"."seed_demo_customer_account" () TO "service_role";

-- Demo customer, part 2: device fleet, usage, update events and Observe telemetry over 60 days.
-- Always rebuilt from scratch (test helpers truncate these shared tables).
-- Tinbase may apply seed without the plpgsql_check extension; provide a no-op stub for pragma calls.
DO $seed_plpgsql_check_stub$
BEGIN
  IF pg_catalog.to_regnamespace('extensions') IS NULL THEN
    EXECUTE 'CREATE SCHEMA extensions';
  END IF;
  IF pg_catalog.to_regprocedure('extensions.plpgsql_check_pragma(text)') IS NULL THEN
    EXECUTE $exec$
      CREATE FUNCTION extensions.plpgsql_check_pragma(text)
      RETURNS void
      LANGUAGE sql
      IMMUTABLE
      AS $body$ SELECT $body$
    $exec$;
  END IF;
END
$seed_plpgsql_check_stub$;

CREATE OR REPLACE FUNCTION "public"."seed_demo_customer_telemetry" () RETURNS "void" LANGUAGE "plpgsql"
SET
  search_path = '' SECURITY DEFINER AS $_$
DECLARE
  v_org uuid := 'acde0000-0000-4000-8000-0000000000a1'::uuid;
  v_customer text := 'cus_demo_acme_mobile';
  v_apps text[] := ARRAY['com.acme.shop', 'com.acme.driver', 'com.acme.internal'];
  v_today date := (pg_catalog.now() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Temp tables below are created at runtime, so plpgsql_check cannot resolve them statically.
  PERFORM extensions.plpgsql_check_pragma('disable:check');
  SET LOCAL client_min_messages = WARNING;
  -- Deterministic pseudo-random data so screenshots and reviewer accounts are stable.
  PERFORM pg_catalog.setseed(0.4242);

  DELETE FROM public.stats WHERE app_id = ANY (v_apps);
  DELETE FROM public.channel_devices WHERE app_id = ANY (v_apps);
  DELETE FROM public.devices WHERE app_id = ANY (v_apps);
  DELETE FROM public.device_usage WHERE app_id = ANY (v_apps);
  DELETE FROM public.version_usage WHERE app_id = ANY (v_apps);
  DELETE FROM public.daily_mau WHERE app_id = ANY (v_apps);
  DELETE FROM public.daily_bandwidth WHERE app_id = ANY (v_apps);
  DELETE FROM public.daily_storage WHERE app_id = ANY (v_apps);
  DELETE FROM public.daily_version WHERE app_id = ANY (v_apps);

  -- ------------------------------------------------------------------
  -- Device fleet simulation (60 days). Raw tables (devices, device_usage,
  -- version_usage, stats) are the source of truth, daily_* rollups are derived
  -- from them with the same rules cron_stat_app uses, so the cron keeps them stable.
  -- ------------------------------------------------------------------
  DROP TABLE IF EXISTS pg_temp.demo_devices;
  DROP TABLE IF EXISTS pg_temp.demo_releases;
  DROP TABLE IF EXISTS pg_temp.demo_transitions;
  DROP TABLE IF EXISTS pg_temp.demo_windows;

  CREATE TEMP TABLE demo_devices ON COMMIT DROP AS
  WITH cfg AS (
    SELECT * FROM (VALUES
      -- app_id, devices, ios share, beta share, internal share, daily activity, stuck share
      ('com.acme.shop', 3000, 0.58, 0.03, 0.01, 0.30, 0.05),
      ('com.acme.driver', 900, 0.22, 0.04, 0.02, 0.55, 0.04),
      ('com.acme.internal', 140, 0.50, 0.08, 0.12, 0.60, 0.00)
    ) AS t(app_id, n_devices, ios_share, beta_share, internal_share, p_active, stuck_share)
  ),
  base AS (
    SELECT cfg.*, g.n,
      pg_catalog.random() AS r_platform, pg_catalog.random() AS r_channel, pg_catalog.random() AS r_seen,
      pg_catalog.random() AS r_last, pg_catalog.random() AS r_churn, pg_catalog.random() AS r_stuck,
      pg_catalog.random() AS r_native, pg_catalog.random() AS r_os, pg_catalog.random() AS r_plugin,
      pg_catalog.random() AS r_custom, pg_catalog.random() AS r_country, pg_catalog.random() AS r_rollout,
      pg_catalog.random() AS r_builtin, pg_catalog.random() AS r_prod
    FROM cfg
    CROSS JOIN LATERAL pg_catalog.generate_series(1, cfg.n_devices) AS g(n)
  ),
  shaped AS (
    SELECT b.*,
      CASE WHEN b.r_platform < b.ios_share THEN 'ios' ELSE 'android' END AS platform,
      CASE
        WHEN b.r_channel < b.internal_share THEN 'internal'
        WHEN b.r_channel < b.internal_share + b.beta_share THEN 'beta'
        ELSE 'production'
      END AS channel_name,
      -- 70% of the fleet installed before the window, 30% are new users spread over it
      CASE WHEN b.r_seen < 0.70
        THEN pg_catalog.now() - interval '60 days' - interval '1 day' * (b.r_seen * 300)
        ELSE pg_catalog.now() - interval '1 day' * ((b.r_seen - 0.70) / 0.30 * 59.5)
      END AS first_seen,
      b.r_stuck < b.stuck_share AS stuck
    FROM base b
  )
  SELECT
    s.app_id, s.n, s.platform, s.channel_name, s.first_seen, s.stuck, s.p_active,
    pg_catalog.md5(s.app_id || ':device:' || s.n::text)::uuid::text AS device_id,
    -- 82% active in the last few days, the rest churned at some point after they started
    CASE WHEN s.r_churn < 0.82
      THEN GREATEST(s.first_seen, pg_catalog.now() - interval '1 minute' * (5 + s.r_last * s.r_last * 5760))
      ELSE GREATEST(s.first_seen, pg_catalog.now() - interval '60 days') + (pg_catalog.now() - GREATEST(s.first_seen, pg_catalog.now() - interval '60 days')) * (0.15 + 0.7 * s.r_last)
    END AS last_seen,
    s.r_rollout < 0.25 AS in_rollout,
    (s.first_seen > pg_catalog.now() - interval '3 days' AND s.r_builtin < 0.25) AS builtin,
    CASE s.app_id
      WHEN 'com.acme.shop' THEN CASE WHEN s.stuck THEN '1.9.0' WHEN s.r_native < 0.25 THEN '2.0.0' WHEN s.r_native < 0.55 THEN '2.2.0' ELSE '2.4.0' END
      WHEN 'com.acme.driver' THEN CASE WHEN s.stuck THEN '3.0.0' WHEN s.r_native < 0.30 THEN '3.1.0' ELSE '3.3.0' END
      ELSE CASE WHEN s.r_native < 0.40 THEN '1.0.0' ELSE '1.2.0' END
    END AS native_version,
    CASE
      WHEN s.stuck THEN '6.14.9'
      WHEN s.r_plugin < 0.62 THEN '7.34.1'
      WHEN s.r_plugin < 0.90 THEN '7.30.2'
      ELSE '7.25.0'
    END AS plugin_version,
    CASE WHEN s.platform = 'ios'
      THEN (ARRAY['18.6.2', '26.0.1', '26.3', '26.4.1', '26.4.1', '27.0', '27.0'])[1 + pg_catalog.floor(s.r_os * 7)::int]
      ELSE (ARRAY['13', '14', '14', '15', '15', '16', '16'])[1 + pg_catalog.floor(s.r_os * 7)::int]
    END AS os_version,
    CASE WHEN s.r_custom < 0.42 THEN 'usr_' || pg_catalog.substr(pg_catalog.md5(s.app_id || ':user:' || s.n::text), 1, 12) ELSE '' END AS custom_id,
    (ARRAY['US', 'US', 'US', 'US', 'CA', 'GB', 'GB', 'FR', 'DE', 'DE', 'BR', 'MX', 'ES', 'IN', 'JP', 'AU'])[1 + pg_catalog.floor(s.r_country * 16)::int] AS country_code,
    s.channel_name <> 'production' AND s.r_prod < 0.35 AS dev_build,
    s.channel_name = 'internal' AND s.r_prod < 0.20 AS emulator
  FROM shaped s;

  -- What each channel served over time (production also exposes the 25% rollout bundle).
  CREATE TEMP TABLE demo_releases ON COMMIT DROP AS
  SELECT dh.app_id, ch.name AS channel_name, av.id AS version_id, av.name, dh.deployed_at AS released_at, false AS is_rollout,
    av.cli_version = '7.42.0' AS needs_new_native
  FROM public.deploy_history dh
  JOIN public.channels ch ON ch.id = dh.channel_id
  JOIN public.app_versions av ON av.id = dh.version_id
  WHERE dh.app_id = ANY (v_apps)
  UNION ALL
  SELECT ch.app_id, 'production', av.id, av.name, av.created_at + interval '1 hour', true, av.cli_version = '7.42.0'
  FROM public.channels ch
  JOIN public.app_versions av ON av.id = ch.rollout_version
  WHERE ch.app_id = ANY (v_apps) AND ch.rollout_enabled;

  -- Version transitions per device: the device checks for an update some time after
  -- each release and installs whatever its channel serves at that moment.
  CREATE TEMP TABLE demo_transitions ON COMMIT DROP AS
  WITH eligible AS (
    SELECT d.device_id, d.app_id, d.first_seen, d.last_seen, r.version_id, r.name, r.released_at
    FROM pg_temp.demo_devices d
    JOIN pg_temp.demo_releases r
      ON r.app_id = d.app_id
      AND r.channel_name = CASE WHEN d.channel_name = 'internal' THEN 'beta' ELSE d.channel_name END
      AND (NOT r.is_rollout OR d.in_rollout)
      AND (NOT d.stuck OR NOT r.needs_new_native)
    WHERE NOT d.builtin
  ),
  checks AS (
    -- initial install / first launch inside the window
    SELECT e.device_id, e.app_id, GREATEST(e.first_seen, pg_catalog.now() - interval '60 days') AS checked_at, e.last_seen
    FROM eligible e
    GROUP BY e.device_id, e.app_id, e.first_seen, e.last_seen
    UNION ALL
    SELECT e.device_id, e.app_id,
      e.released_at + interval '1 minute' * (15 + 2400 * -pg_catalog.ln(1 - 0.995 * ((pg_catalog.hashtext(e.device_id || e.name) & 2147483647)::float8 / 2147483647.0))),
      e.last_seen
    FROM eligible e
    WHERE e.released_at > GREATEST(e.first_seen, pg_catalog.now() - interval '60 days')
  ),
  windows AS (
    SELECT e.device_id, e.app_id, e.version_id, e.released_at AS valid_from,
      COALESCE(pg_catalog.lead(e.released_at) OVER (PARTITION BY e.device_id, e.app_id ORDER BY e.released_at), 'infinity'::timestamptz) AS valid_to
    FROM eligible e
  ),
  served AS (
    SELECT c.device_id, c.app_id, c.checked_at, w.version_id
    FROM checks c
    JOIN windows w ON w.device_id = c.device_id AND w.app_id = c.app_id
      AND c.checked_at >= w.valid_from AND c.checked_at < w.valid_to
    WHERE c.checked_at <= LEAST(c.last_seen, pg_catalog.now())
  ),
  ordered AS (
    SELECT s.*, pg_catalog.lag(s.version_id) OVER (PARTITION BY s.device_id, s.app_id ORDER BY s.checked_at) AS prev_version_id
    FROM served s
    WHERE s.version_id IS NOT NULL
  )
  SELECT o.device_id, o.app_id, o.checked_at AS at, o.version_id, av.name, o.prev_version_id, pav.name AS prev_name
  FROM ordered o
  JOIN public.app_versions av ON av.id = o.version_id
  LEFT JOIN public.app_versions pav ON pav.id = o.prev_version_id
  WHERE o.prev_version_id IS DISTINCT FROM o.version_id;

  -- Which bundle each device ran over time (one row per transition).
  CREATE TEMP TABLE demo_windows ON COMMIT DROP AS
  SELECT t.device_id, t.app_id, t.version_id, t.name, t.at AS valid_from,
    COALESCE(pg_catalog.lead(t.at) OVER (PARTITION BY t.device_id, t.app_id ORDER BY t.at), 'infinity'::timestamptz) AS valid_to
  FROM pg_temp.demo_transitions t;
  CREATE INDEX ON pg_temp.demo_windows (device_id, app_id, valid_from);
  CREATE INDEX ON pg_temp.demo_devices (device_id, app_id);
  ANALYZE pg_temp.demo_devices;
  ANALYZE pg_temp.demo_transitions;
  ANALYZE pg_temp.demo_windows;

  INSERT INTO public.devices (updated_at, device_id, version, version_name, app_id, platform, plugin_version, os_version, version_build, custom_id, is_prod, is_emulator, default_channel, country_code)
  SELECT d.last_seen, d.device_id, cur.version_id, COALESCE(cur.name, 'builtin'), d.app_id, d.platform::public.platform_os, d.plugin_version, d.os_version, d.native_version, d.custom_id,
    NOT d.dev_build, d.emulator, CASE WHEN d.channel_name = 'production' THEN NULL ELSE d.channel_name END, d.country_code
  FROM pg_temp.demo_devices d
  LEFT JOIN pg_temp.demo_windows cur
    ON cur.device_id = d.device_id AND cur.app_id = d.app_id AND cur.valid_to = 'infinity'::timestamptz;

  -- Testers forced onto beta / internal from the console.
  INSERT INTO public.channel_devices (created_at, updated_at, channel_id, app_id, device_id, owner_org, is_self_set)
  SELECT pg_catalog.now() - interval '1 day' * (3 + x.rn), pg_catalog.now() - interval '1 day' * (3 + x.rn), ch.id, x.app_id, x.device_id, v_org, x.rn % 3 = 0
  FROM (
    SELECT d.app_id, d.device_id, d.channel_name, pg_catalog.row_number() OVER (PARTITION BY d.app_id, d.channel_name ORDER BY d.n) AS rn
    FROM pg_temp.demo_devices d
    WHERE d.channel_name <> 'production' AND NOT d.builtin
  ) x
  JOIN public.channels ch ON ch.app_id = x.app_id AND ch.name = x.channel_name
  WHERE x.rn <= CASE WHEN x.channel_name = 'beta' THEN 6 ELSE 3 END;

  -- device_usage: one row per active day (drives MAU and native version usage)
  INSERT INTO public.device_usage (device_id, app_id, org_id, timestamp, version_build, platform)
  SELECT d.device_id, d.app_id, v_org::text,
    (CASE WHEN day.ts = pg_catalog.date_trunc('day', d.last_seen) THEN d.last_seen
      ELSE day.ts + interval '1 minute' * ((pg_catalog.hashtext(d.device_id || day.ts::text) & 1023))
    END)::timestamp,
    d.native_version, d.platform
  FROM pg_temp.demo_devices d
  CROSS JOIN LATERAL pg_catalog.generate_series(
    pg_catalog.date_trunc('day', GREATEST(d.first_seen, pg_catalog.now() - interval '60 days')),
    pg_catalog.date_trunc('day', d.last_seen),
    interval '1 day'
  ) AS day(ts)
  WHERE day.ts = pg_catalog.date_trunc('day', GREATEST(d.first_seen, pg_catalog.now() - interval '60 days'))
    OR day.ts = pg_catalog.date_trunc('day', d.last_seen)
    OR ((pg_catalog.hashtext(d.device_id || ':active:' || day.ts::text) & 2147483647)::float8 / 2147483647.0) < d.p_active;

  -- version_usage: install / uninstall per transition (+ a failed first attempt for ~1.5%)
  INSERT INTO public.version_usage (timestamp, app_id, version_id, version_name, action, channel_name, channel_id)
  SELECT ev.ts::timestamp, t.app_id, ev.version_id, ev.version_name, ev.action::public.version_action, ch.name, ch.id
  FROM pg_temp.demo_transitions t
  JOIN pg_temp.demo_devices d ON d.device_id = t.device_id AND d.app_id = t.app_id
  JOIN public.channels ch ON ch.app_id = t.app_id AND ch.name = d.channel_name
  CROSS JOIN LATERAL (
    VALUES
      (t.at, 'install', t.version_id, t.name),
      (t.at, 'uninstall', t.prev_version_id, t.prev_name),
      (t.at - interval '3 hours', 'fail', t.version_id, t.name)
  ) AS ev(ts, action, version_id, version_name)
  WHERE t.at >= pg_catalog.now() - interval '60 days'
    AND ev.version_id IS NOT NULL
    AND (ev.action <> 'fail' OR ((pg_catalog.hashtext(t.device_id || ':fail:' || t.name) & 2147483647)::float8 / 2147483647.0) < 0.015);

  -- version_usage: one update check ('get') per active device day, tagged with the
  -- bundle the device ran that day. Bundle adoption charts are built from these.
  INSERT INTO public.version_usage (timestamp, app_id, version_id, version_name, action, channel_name, channel_id)
  SELECT du.timestamp, du.app_id, w.version_id, w.name, 'get'::public.version_action, ch.name, ch.id
  FROM public.device_usage du
  JOIN pg_temp.demo_devices d ON d.device_id = du.device_id AND d.app_id = du.app_id
  JOIN public.channels ch ON ch.app_id = d.app_id AND ch.name = d.channel_name
  JOIN pg_temp.demo_windows w ON w.device_id = du.device_id AND w.app_id = du.app_id
    AND du.timestamp::timestamptz >= w.valid_from AND du.timestamp::timestamptz < w.valid_to
  WHERE du.app_id = ANY (v_apps);

  -- ------------------------------------------------------------------
  -- Daily rollups (dashboard charts, statistics API, bundle adoption)
  -- ------------------------------------------------------------------
  INSERT INTO public.daily_version (date, app_id, version_id, version_name, get, fail, install, uninstall)
  SELECT pg_catalog.date_trunc('day', vu.timestamp)::date, vu.app_id, MAX(vu.version_id), vu.version_name,
    SUM(CASE WHEN vu.action = 'get' THEN 1 ELSE 0 END),
    SUM(CASE WHEN vu.action = 'fail' THEN 1 ELSE 0 END),
    SUM(CASE WHEN vu.action = 'install' THEN 1 ELSE 0 END),
    SUM(CASE WHEN vu.action = 'uninstall' THEN 1 ELSE 0 END)
  FROM public.version_usage vu
  WHERE vu.app_id = ANY (v_apps)
  GROUP BY 1, 2, 4;

  -- MAU = devices first seen per day inside each monthly billing cycle (read_device_usage semantics)
  INSERT INTO public.daily_mau (app_id, date, mau)
  SELECT x.app_id, x.first_day, COUNT(*)
  FROM (
    SELECT du.app_id, du.device_id, cyc.k, MIN(du.timestamp::date) AS first_day
    FROM public.device_usage du
    JOIN public.stripe_info si ON si.customer_id = v_customer
    CROSS JOIN LATERAL (
      SELECT k FROM pg_catalog.generate_series(-1, 4) AS k
      WHERE du.timestamp >= (si.subscription_anchor_start - pg_catalog.make_interval(months => k))
        AND du.timestamp < (si.subscription_anchor_start - pg_catalog.make_interval(months => k - 1))
    ) cyc
    WHERE du.app_id = ANY (v_apps)
    GROUP BY du.app_id, du.device_id, cyc.k
  ) x
  GROUP BY x.app_id, x.first_day;

  -- Bandwidth: full bundle on install, small manifest checks on every active day.
  INSERT INTO public.daily_bandwidth (app_id, date, bandwidth)
  SELECT days.app_id, days.date,
    COALESCE(inst.bytes, 0) + days.active_devices * 18000
  FROM (
    SELECT du.app_id, du.timestamp::date AS date, COUNT(*) AS active_devices
    FROM public.device_usage du
    WHERE du.app_id = ANY (v_apps)
    GROUP BY 1, 2
  ) days
  LEFT JOIN (
    SELECT vu.app_id, vu.timestamp::date AS date, SUM(avm.size) AS bytes
    FROM public.version_usage vu
    JOIN public.app_versions_meta avm ON avm.id = vu.version_id
    WHERE vu.app_id = ANY (v_apps) AND vu.action = 'install'
    GROUP BY 1, 2
  ) inst ON inst.app_id = days.app_id AND inst.date = days.date;

  -- Storage: bundles kept in R2 on each day.
  INSERT INTO public.daily_storage (app_id, date, storage)
  SELECT a.app_id, day.d::date,
    COALESCE((
      SELECT SUM(avm.size) FROM public.app_versions av
      JOIN public.app_versions_meta avm ON avm.id = av.id
      WHERE av.app_id = a.app_id
        AND av.created_at::date <= day.d::date
        AND (av.deleted_at IS NULL OR av.deleted_at::date > day.d::date)
    ), 0)
  FROM pg_catalog.unnest(v_apps) AS a(app_id)
  CROSS JOIN pg_catalog.generate_series(v_today - 59, v_today, interval '1 day') AS day(d);

  -- ------------------------------------------------------------------
  -- stats: update lifecycle events + Observe telemetry for the last 30 days
  -- ------------------------------------------------------------------
  -- Update lifecycle (device logs, update success/failure insights).
  INSERT INTO public.stats (created_at, action, device_id, version_name, app_id, metadata)
  SELECT ev.ts, ev.action::public.stats_action, t.device_id, ev.version_name, t.app_id, ev.metadata
  FROM pg_temp.demo_transitions t
  CROSS JOIN LATERAL (
    SELECT ((pg_catalog.hashtext(t.device_id || ':upd:' || t.name) & 2147483647)::float8 / 2147483647.0) AS h
  ) r
  CROSS JOIN LATERAL (
    VALUES
      (t.at - interval '45 seconds', 'get', t.name, NULL::jsonb, true),
      (t.at - interval '30 seconds', 'download_zip_start', t.name, NULL::jsonb, true),
      (t.at - interval '12 seconds', 'download_complete', t.name, NULL::jsonb, true),
      (t.at, 'set', t.name, NULL::jsonb, true),
      (t.at - interval '3 hours', 'download_fail', t.name, '{"error":"Network connection was lost","http_status":"0"}'::jsonb, r.h < 0.012),
      (t.at - interval '2 hours', 'checksum_fail', t.name, '{"error":"checksum mismatch after unzip"}'::jsonb, r.h >= 0.012 AND r.h < 0.016),
      (t.at - interval '90 minutes', 'update_fail', COALESCE(t.prev_name, t.name), '{"reason":"app killed before notifyAppReady"}'::jsonb, r.h >= 0.016 AND r.h < 0.021)
  ) AS ev(ts, action, version_name, metadata, keep)
  WHERE ev.keep AND t.at >= pg_catalog.now() - interval '30 days';

  -- Observe sessions: launch timing, WebView load, navigation, issues (sampled active days).
  INSERT INTO public.stats (created_at, action, device_id, version_name, app_id, metadata)
  SELECT ev.ts, ev.action::public.stats_action, s.device_id, s.version_name, s.app_id, ev.metadata
  FROM (
    SELECT du.device_id, du.app_id, du.timestamp::timestamptz AS ts, w.name AS version_name, d.platform,
      ((pg_catalog.hashtext(du.device_id || ':s1:' || du.timestamp::text) & 2147483647)::float8 / 2147483647.0) AS h1,
      ((pg_catalog.hashtext(du.device_id || ':s2:' || du.timestamp::text) & 2147483647)::float8 / 2147483647.0) AS h2,
      ((pg_catalog.hashtext(du.device_id || ':s3:' || du.timestamp::text) & 2147483647)::float8 / 2147483647.0) AS h3
    FROM public.device_usage du
    JOIN pg_temp.demo_devices d ON d.device_id = du.device_id AND d.app_id = du.app_id
    JOIN pg_temp.demo_windows w ON w.device_id = du.device_id AND w.app_id = du.app_id
      AND du.timestamp::timestamptz >= w.valid_from AND du.timestamp::timestamptz < w.valid_to
    WHERE du.app_id = ANY (v_apps)
      AND du.timestamp >= (pg_catalog.now() - interval '30 days')::timestamp
      AND (
        -- the most recent launch of every device, plus a sample of older active days
        du.timestamp = d.last_seen::timestamp
        OR ((pg_catalog.hashtext(du.device_id || ':session:' || du.timestamp::text) & 2147483647)::float8 / 2147483647.0) < 0.22
      )
  ) s
  CROSS JOIN LATERAL (
    -- Android cold starts are slower, 2.3.x shop builds carry a slow-launch regression.
    SELECT pg_catalog.round((
      CASE WHEN s.platform = 'android' THEN 1150 ELSE 780 END
      * CASE WHEN s.version_name LIKE '2.3.%' THEN 1.6 ELSE 1 END
      * pg_catalog.exp(0.55 * (s.h1 * 2 - 1) + 0.35 * (s.h2 * 2 - 1))
    )::numeric)::int AS launch_ms,
    pg_catalog.round((420 + 900 * s.h2 * s.h2)::numeric)::int AS load_ms,
    (ARRAY['/home', '/home', '/catalog', '/product/[id]', '/cart', '/checkout', '/orders', '/account'])[1 + pg_catalog.floor(s.h3 * 8)::int] AS route
  ) m
  CROSS JOIN LATERAL (
    VALUES
      (s.ts, 'app_launch_start', NULL::jsonb, true),
      (s.ts + pg_catalog.make_interval(secs => m.launch_ms / 1000.0), 'app_launch_ready', pg_catalog.jsonb_build_object('duration_ms', m.launch_ms::text), true),
      (s.ts + pg_catalog.make_interval(secs => (m.launch_ms + m.load_ms) / 1000.0), 'webview_page_loaded', pg_catalog.jsonb_build_object('duration_ms', m.load_ms::text, 'route', '/home'), true),
      (s.ts + interval '9 seconds', 'app_nav', pg_catalog.jsonb_build_object('route', m.route, 'from', '/home', 'duration_ms', (120 + pg_catalog.floor(s.h1 * 480))::int::text), true),
      (s.ts + interval '41 seconds', 'app_nav', pg_catalog.jsonb_build_object('route', CASE WHEN m.route = '/cart' THEN '/checkout' ELSE '/cart' END, 'from', m.route, 'duration_ms', (90 + pg_catalog.floor(s.h2 * 380))::int::text), s.h3 < 0.55),
      (s.ts + interval '50 seconds', 'webview_javascript_error', pg_catalog.jsonb_build_object('message', 'TypeError: Cannot read properties of undefined (reading ''items'')', 'error_type', 'javascript_error', 'href', 'capacitor://localhost' || m.route), s.h1 > 0.975),
      (s.ts + interval '75 seconds', 'webview_unhandled_rejection', pg_catalog.jsonb_build_object('message', 'Request failed with status code 503', 'href', 'capacitor://localhost/orders'), s.h2 > 0.988),
      (s.ts + interval '2 minutes', 'app_crash', pg_catalog.jsonb_build_object('reason', 'SIGABRT in WebKit networking process', 'native', 'true'), s.h3 > 0.996 AND s.platform = 'ios'),
      (s.ts + interval '2 minutes', 'app_anr', pg_catalog.jsonb_build_object('duration_ms', '5400', 'reason', 'Input dispatching timed out'), s.h3 > 0.993 AND s.platform = 'android'),
      (s.ts + interval '3 minutes', 'app_memory_warning', NULL::jsonb, s.h1 < 0.008 AND s.platform = 'ios'),
      (s.ts + interval '30 seconds', 'app_launch_timeout', pg_catalog.jsonb_build_object('duration_ms', '10000'), m.launch_ms > 4200)
  ) AS ev(ts, action, metadata, keep)
  WHERE ev.keep AND ev.ts <= pg_catalog.now();

  -- Native version changes (store updates) for devices whose native build moved.
  INSERT INTO public.stats (created_at, action, device_id, version_name, app_id, metadata)
  SELECT d.last_seen - interval '6 hours', 'native_app_version_changed'::public.stats_action, d.device_id, COALESCE(cur.name, 'builtin'), d.app_id,
    pg_catalog.jsonb_build_object('from', '2.2.0', 'to', d.native_version)
  FROM pg_temp.demo_devices d
  LEFT JOIN pg_temp.demo_windows cur
    ON cur.device_id = d.device_id AND cur.app_id = d.app_id AND cur.valid_to = 'infinity'::timestamptz
  WHERE d.app_id = 'com.acme.shop' AND d.native_version = '2.4.0' AND d.last_seen > pg_catalog.now() - interval '7 days' AND d.n % 9 = 0;

  -- Charts read cached aggregates: force a refresh for the demo org.
  DELETE FROM public.app_metrics_cache WHERE org_id = v_org;
  DELETE FROM public.org_metrics_cache WHERE org_id = v_org;
END;
$_$;

ALTER FUNCTION "public"."seed_demo_customer_telemetry" () OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."seed_demo_customer_telemetry" ()
FROM
  PUBLIC;

GRANT ALL ON FUNCTION "public"."seed_demo_customer_telemetry" () TO "service_role";

CREATE OR REPLACE FUNCTION "public"."reset_and_seed_demo_customer_data" () RETURNS "void" LANGUAGE "plpgsql"
SET
  search_path = '' SECURITY DEFINER AS $_$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.orgs WHERE id = 'acde0000-0000-4000-8000-0000000000a1'::uuid) THEN
    PERFORM public.seed_demo_customer_account();
  END IF;
  PERFORM public.seed_demo_customer_telemetry();
END;
$_$;

ALTER FUNCTION "public"."reset_and_seed_demo_customer_data" () OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."reset_and_seed_demo_customer_data" ()
FROM
  PUBLIC;

GRANT ALL ON FUNCTION "public"."reset_and_seed_demo_customer_data" () TO "service_role";

-- Seed data
DO $$
BEGIN
    -- Execute seeding functions
    PERFORM public.reset_and_seed_data();
    PERFORM public.reset_and_seed_stats_data();
    PERFORM public.reset_and_seed_app_stats_data('com.stats.app');

    -- Repopulate RBAC permissions (wiped by TRUNCATE auth.users CASCADE)
    -- The CASCADE from auth.users -> apps -> app_versions -> permissions clears this table
    RAISE NOTICE 'Repopulating RBAC permissions and role_permissions...';

    INSERT INTO public.permissions (key, scope_type, description)
    VALUES
      (public.rbac_perm_org_read(), public.rbac_scope_org(), 'Read org level settings and metadata'),
      (public.rbac_perm_org_create_app(), public.rbac_scope_org(), 'Create a new app within an organization'),
      (public.rbac_perm_org_update_settings(), public.rbac_scope_org(), 'Update org configuration/settings'),
      (public.rbac_perm_org_delete(), public.rbac_scope_org(), 'Delete an organization'),
      (public.rbac_perm_org_read_members(), public.rbac_scope_org(), 'Read org membership list'),
      (public.rbac_perm_org_invite_user(), public.rbac_scope_org(), 'Invite or add members to org'),
      (public.rbac_perm_org_update_user_roles(), public.rbac_scope_org(), 'Change org/member roles'),
      (public.rbac_perm_org_manage_apikeys(), public.rbac_scope_org(), 'Manage API keys for the org without assigning user roles'),
      (public.rbac_perm_app_manage_apikeys(), public.rbac_scope_app(), 'Create, update and delete API keys limited to this app'),
      (public.rbac_perm_org_read_billing(), public.rbac_scope_org(), 'Read org billing settings'),
      (public.rbac_perm_org_update_billing(), public.rbac_scope_org(), 'Update org billing settings'),
      (public.rbac_perm_org_read_invoices(), public.rbac_scope_org(), 'Read invoices'),
      (public.rbac_perm_org_read_audit(), public.rbac_scope_org(), 'Read org-level audit trail'),
      (public.rbac_perm_org_read_billing_audit(), public.rbac_scope_org(), 'Read billing/audit details'),
      (public.rbac_perm_app_read(), public.rbac_scope_app(), 'Read app metadata'),
      (public.rbac_perm_app_update_settings(), public.rbac_scope_app(), 'Update app settings'),
      (public.rbac_perm_app_delete(), public.rbac_scope_app(), 'Delete an app'),
      (public.rbac_perm_app_read_bundles(), public.rbac_scope_app(), 'Read app bundle metadata'),
      (public.rbac_perm_app_upload_bundle(), public.rbac_scope_app(), 'Upload a bundle'),
      (public.rbac_perm_app_create_channel(), public.rbac_scope_app(), 'Create channels'),
      (public.rbac_perm_app_read_channels(), public.rbac_scope_app(), 'List/read channels'),
      (public.rbac_perm_app_read_logs(), public.rbac_scope_app(), 'Read app logs/metrics'),
      ('app.manage_notifications', public.rbac_scope_app(), 'Manage notification campaigns, badge updates, recipient lookup, and delivery stats for an app'),
      (public.rbac_perm_app_manage_devices(), public.rbac_scope_app(), 'Manage devices at app scope'),
      (public.rbac_perm_app_read_devices(), public.rbac_scope_app(), 'Read devices at app scope'),
      (public.rbac_perm_app_build_native(), public.rbac_scope_app(), 'Trigger native builds'),
      (public.rbac_perm_app_read_audit(), public.rbac_scope_app(), 'Read app-level audit trail'),
      (public.rbac_perm_app_update_user_roles(), public.rbac_scope_app(), 'Update user roles for this app'),
      (public.rbac_perm_app_transfer(), public.rbac_scope_app(), 'Transfer app to another organization'),
      (public.rbac_perm_bundle_delete(), public.rbac_scope_app(), 'Delete a bundle'),
      (public.rbac_perm_channel_read(), public.rbac_scope_channel(), 'Read channel metadata'),
      (public.rbac_perm_channel_update_settings(), public.rbac_scope_channel(), 'Update channel settings'),
      (public.rbac_perm_channel_delete(), public.rbac_scope_channel(), 'Delete a channel'),
      (public.rbac_perm_channel_read_history(), public.rbac_scope_channel(), 'Read deploy history'),
      (public.rbac_perm_channel_promote_bundle(), public.rbac_scope_channel(), 'Promote bundle to channel'),
      (public.rbac_perm_channel_rollback_bundle(), public.rbac_scope_channel(), 'Rollback bundle on channel'),
      (public.rbac_perm_channel_manage_forced_devices(), public.rbac_scope_channel(), 'Manage forced devices'),
      (public.rbac_perm_channel_read_forced_devices(), public.rbac_scope_channel(), 'Read forced devices'),
      (public.rbac_perm_channel_read_audit(), public.rbac_scope_channel(), 'Read channel-level audit')
    ON CONFLICT (key) DO NOTHING;

    -- Attach permissions to roles
    -- org_super_admin: full org + app + channel control
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_org_read(), public.rbac_perm_org_create_app(), public.rbac_perm_org_update_settings(), public.rbac_perm_org_delete(), public.rbac_perm_org_read_members(), public.rbac_perm_org_invite_user(), public.rbac_perm_org_update_user_roles(), public.rbac_perm_org_manage_apikeys(),
      public.rbac_perm_org_read_billing(), public.rbac_perm_org_update_billing(), public.rbac_perm_org_read_invoices(), public.rbac_perm_org_read_audit(), public.rbac_perm_org_read_billing_audit(),
      public.rbac_perm_app_read(), public.rbac_perm_app_update_settings(), public.rbac_perm_app_delete(), public.rbac_perm_app_read_bundles(), public.rbac_perm_app_upload_bundle(),
      public.rbac_perm_app_create_channel(), public.rbac_perm_app_read_channels(), public.rbac_perm_app_read_logs(), public.rbac_perm_app_manage_devices(), public.rbac_perm_app_read_devices(),
      'app.manage_notifications',
      public.rbac_perm_app_build_native(), public.rbac_perm_app_read_audit(), public.rbac_perm_app_update_user_roles(), public.rbac_perm_app_manage_apikeys(), public.rbac_perm_app_transfer(), public.rbac_perm_bundle_delete(),
      public.rbac_perm_channel_read(), public.rbac_perm_channel_update_settings(), public.rbac_perm_channel_delete(), public.rbac_perm_channel_read_history(),
      public.rbac_perm_channel_promote_bundle(), public.rbac_perm_channel_rollback_bundle(), public.rbac_perm_channel_manage_forced_devices(), public.rbac_perm_channel_read_forced_devices(), public.rbac_perm_channel_read_audit()
    )
    WHERE r.name = public.rbac_role_org_super_admin()
    ON CONFLICT DO NOTHING;

    -- org_admin: org management without billing updates or deletions
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_org_read(), public.rbac_perm_org_create_app(), public.rbac_perm_org_update_settings(), public.rbac_perm_org_read_members(), public.rbac_perm_org_invite_user(), public.rbac_perm_org_update_user_roles(), public.rbac_perm_org_manage_apikeys(),
      public.rbac_perm_org_read_billing(), public.rbac_perm_org_read_invoices(), public.rbac_perm_org_read_audit(), public.rbac_perm_org_read_billing_audit(),
      public.rbac_perm_app_read(), public.rbac_perm_app_update_settings(), public.rbac_perm_app_read_bundles(), public.rbac_perm_app_upload_bundle(),
      public.rbac_perm_app_create_channel(), public.rbac_perm_app_read_channels(), public.rbac_perm_app_read_logs(), public.rbac_perm_app_manage_devices(), public.rbac_perm_app_read_devices(),
      'app.manage_notifications',
      public.rbac_perm_app_build_native(), public.rbac_perm_app_read_audit(), public.rbac_perm_app_update_user_roles(), public.rbac_perm_app_manage_apikeys(),
      public.rbac_perm_channel_read(), public.rbac_perm_channel_update_settings(), public.rbac_perm_channel_read_history(),
      public.rbac_perm_channel_promote_bundle(), public.rbac_perm_channel_rollback_bundle(), public.rbac_perm_channel_manage_forced_devices(), public.rbac_perm_channel_read_forced_devices(), public.rbac_perm_channel_read_audit()
    )
    WHERE r.name = public.rbac_role_org_admin()
    ON CONFLICT DO NOTHING;

    -- org_billing_admin: billing only
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_org_read(), public.rbac_perm_org_create_app(), public.rbac_perm_org_read_billing(), public.rbac_perm_org_update_billing(), public.rbac_perm_org_read_invoices(), public.rbac_perm_org_read_billing_audit()
    )
    WHERE r.name = public.rbac_role_org_billing_admin()
    ON CONFLICT DO NOTHING;

    -- org_member: org-only access (no app permissions).
    -- org.read_billing is default so members can see plan/usage; orgs can revoke it.
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_org_read(), public.rbac_perm_org_create_app(), public.rbac_perm_org_read_members(),
      public.rbac_perm_org_read_billing()
    )
    WHERE r.name = public.rbac_role_org_member()
    ON CONFLICT DO NOTHING;

    -- Legacy non-assignable billing-read role used by the backfill migration.
    INSERT INTO public.roles (name, scope_type, description, priority_rank, is_assignable, created_by)
    VALUES (
      'org_billing_reader',
      public.rbac_scope_org(),
      'Legacy billing read access preserved for users who already saw plan/usage before org.read_billing was enforced',
      5,
      false,
      NULL
    )
    ON CONFLICT (name) DO UPDATE
    SET
      scope_type = EXCLUDED.scope_type,
      description = EXCLUDED.description,
      priority_rank = EXCLUDED.priority_rank,
      is_assignable = EXCLUDED.is_assignable;

    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key = public.rbac_perm_org_read_billing()
    WHERE r.name = 'org_billing_reader'
    ON CONFLICT DO NOTHING;

    -- apikey_org_reader: compatibility org metadata read without org-wide app access
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key = public.rbac_perm_org_read()
    WHERE r.name = public.rbac_role_apikey_org_reader()
    ON CONFLICT DO NOTHING;

    -- app_admin: full app control
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_app_read(), public.rbac_perm_app_update_settings(), public.rbac_perm_app_read_bundles(), public.rbac_perm_app_upload_bundle(),
      public.rbac_perm_app_create_channel(), public.rbac_perm_app_read_channels(), public.rbac_perm_app_read_logs(), public.rbac_perm_app_manage_devices(),
      'app.manage_notifications',
      public.rbac_perm_app_read_devices(), public.rbac_perm_app_build_native(), public.rbac_perm_app_read_audit(), public.rbac_perm_app_update_user_roles(), public.rbac_perm_app_manage_apikeys(), public.rbac_perm_bundle_delete(),
      public.rbac_perm_channel_read(), public.rbac_perm_channel_update_settings(), public.rbac_perm_channel_delete(), public.rbac_perm_channel_read_history(),
      public.rbac_perm_channel_promote_bundle(), public.rbac_perm_channel_rollback_bundle(), public.rbac_perm_channel_manage_forced_devices(), public.rbac_perm_channel_read_forced_devices(), public.rbac_perm_channel_read_audit()
    )
    WHERE r.name = public.rbac_role_app_admin()
    ON CONFLICT DO NOTHING;

    -- app_developer: upload/promote bundles and manage devices, but no direct channel setting updates
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_app_read(), public.rbac_perm_app_read_bundles(), public.rbac_perm_app_upload_bundle(), public.rbac_perm_app_create_channel(), public.rbac_perm_app_read_channels(), public.rbac_perm_app_read_logs(),
      'app.manage_notifications',
      public.rbac_perm_app_manage_devices(), public.rbac_perm_app_read_devices(), public.rbac_perm_app_build_native(), public.rbac_perm_app_read_audit(),
      public.rbac_perm_channel_read(), public.rbac_perm_channel_read_history(),
      public.rbac_perm_channel_promote_bundle(), public.rbac_perm_channel_rollback_bundle(), public.rbac_perm_channel_manage_forced_devices(), public.rbac_perm_channel_read_forced_devices(), public.rbac_perm_channel_read_audit()
    )
    WHERE r.name = public.rbac_role_app_developer()
    ON CONFLICT DO NOTHING;

    -- app_notifications: notification send, recipient lookup, badge, campaign, and stats access only
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key = 'app.manage_notifications'
    WHERE r.name = 'app_notifications'
    ON CONFLICT DO NOTHING;

    -- app_uploader: upload only plus channel promote without settings writes
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_app_read(), public.rbac_perm_app_read_bundles(), public.rbac_perm_app_upload_bundle(), public.rbac_perm_app_read_channels(), public.rbac_perm_app_read_logs(), public.rbac_perm_app_read_devices(), public.rbac_perm_app_read_audit(),
      public.rbac_perm_channel_read(), public.rbac_perm_channel_promote_bundle()
    )
    WHERE r.name = public.rbac_role_app_uploader()
    ON CONFLICT DO NOTHING;

    -- app_preview: app-scoped bootstrap permissions. Channel lifecycle access is
    -- granted only through a system-managed channel_preview binding after creation.
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_app_read(), public.rbac_perm_app_read_bundles(), public.rbac_perm_app_upload_bundle(),
      public.rbac_perm_app_create_channel()
    )
    WHERE r.name = 'app_preview'
    ON CONFLICT DO NOTHING;

    INSERT INTO public.roles (name, scope_type, description, priority_rank, is_assignable, created_by)
    VALUES (
      public.rbac_role_apikey_manager(),
      public.rbac_scope_org(),
      'Manage API keys for CI/CD without org role assignment rights',
      78,
      true,
      NULL
    )
    ON CONFLICT (name) DO UPDATE
    SET
      scope_type = EXCLUDED.scope_type,
      description = EXCLUDED.description,
      priority_rank = EXCLUDED.priority_rank,
      is_assignable = EXCLUDED.is_assignable;

    -- apikey_manager: manage API keys and read org policy metadata without role assignment rights
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_org_manage_apikeys(),
      public.rbac_perm_org_read()
    )
    WHERE r.name = public.rbac_role_apikey_manager()
    ON CONFLICT DO NOTHING;

    INSERT INTO public.roles (name, scope_type, description, priority_rank, is_assignable, created_by)
    VALUES
      (
        'channel_preview',
        public.rbac_scope_channel(),
        'Preview deployment lifecycle for a channel created by an app-preview API key',
        68,
        false,
        NULL
      ),
      (
        public.rbac_role_channel_developer(),
        public.rbac_scope_channel(),
        'Developer access to a channel: promote and rollback bundles without settings writes',
        58,
        true,
        NULL
      ),
      (
        public.rbac_role_channel_uploader(),
        public.rbac_scope_channel(),
        'Upload-only access to a channel: read metadata and promote bundles',
        57,
        true,
        NULL
      )
    ON CONFLICT (name) DO UPDATE
    SET
      scope_type = EXCLUDED.scope_type,
      description = EXCLUDED.description,
      priority_rank = EXCLUDED.priority_rank,
      is_assignable = EXCLUDED.is_assignable;

    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_channel_read(), public.rbac_perm_channel_read_history(), public.rbac_perm_channel_promote_bundle(),
      public.rbac_perm_channel_rollback_bundle(), public.rbac_perm_channel_manage_forced_devices(), public.rbac_perm_channel_read_forced_devices(), public.rbac_perm_channel_read_audit()
    )
    WHERE r.name = public.rbac_role_channel_developer()
    ON CONFLICT DO NOTHING;

    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_channel_read(), public.rbac_perm_channel_promote_bundle()
    )
    WHERE r.name = public.rbac_role_channel_uploader()
    ON CONFLICT DO NOTHING;

    -- channel_preview: system-managed access for the channel its app_preview key created
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_channel_read(), public.rbac_perm_channel_promote_bundle(), public.rbac_perm_channel_delete()
    )
    WHERE r.name = 'channel_preview'
    ON CONFLICT DO NOTHING;

    -- app_reader: read-only app access plus read-only access to every channel in the app
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_app_read(), public.rbac_perm_app_read_bundles(), public.rbac_perm_app_read_channels(), public.rbac_perm_app_read_logs(), public.rbac_perm_app_read_devices(), public.rbac_perm_app_read_audit(),
      public.rbac_perm_channel_read(), public.rbac_perm_channel_read_history(), public.rbac_perm_channel_read_forced_devices(), public.rbac_perm_channel_read_audit()
    )
    WHERE r.name = public.rbac_role_app_reader()
    ON CONFLICT DO NOTHING;

    -- channel_admin: full channel control
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_channel_read(), public.rbac_perm_channel_update_settings(), public.rbac_perm_channel_delete(), public.rbac_perm_channel_read_history(),
      public.rbac_perm_channel_promote_bundle(), public.rbac_perm_channel_rollback_bundle(), public.rbac_perm_channel_manage_forced_devices(),
      public.rbac_perm_channel_read_forced_devices(), public.rbac_perm_channel_read_audit()
    )
    WHERE r.name = public.rbac_role_channel_admin()
    ON CONFLICT DO NOTHING;

    -- channel_reader: read-only
    INSERT INTO public.role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM public.roles r
    JOIN public.permissions p ON p.key IN (
      public.rbac_perm_channel_read(), public.rbac_perm_channel_read_history(), public.rbac_perm_channel_read_forced_devices(), public.rbac_perm_channel_read_audit()
    )
    WHERE r.name = public.rbac_role_channel_reader()
    ON CONFLICT DO NOTHING;


    -- Ensure dedicated apikey management test keys retain explicit RBAC bindings
    -- after permission repopulation (seed_key_roles insert can be skipped silently).
    DELETE FROM public.role_bindings rb
    USING public.apikeys ak
    WHERE rb.principal_type = public.rbac_principal_apikey()
      AND rb.principal_id = ak.rbac_id
      AND rb.scope_type = public.rbac_scope_org()
      AND ak.id IN (112, 113);

    INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      granted_by,
      reason,
      is_direct
    )
    SELECT
      public.rbac_principal_apikey(),
      ak.rbac_id,
      roles.id,
      public.rbac_scope_org(),
      'f1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a50'::uuid,
      ak.user_id,
      'Seeded apikey management test binding',
      true
    FROM public.apikeys ak
    JOIN (
      VALUES
        (112::bigint, public.rbac_role_org_super_admin()),
        (113::bigint, public.rbac_role_apikey_manager())
    ) AS management_keys (apikey_id, role_name)
      ON management_keys.apikey_id = ak.id
    JOIN public.roles roles
      ON roles.scope_type = public.rbac_scope_org()
      AND roles.name = management_keys.role_name
    WHERE ak.rbac_id IS NOT NULL;

    RAISE NOTICE 'RBAC permissions populated: % permissions, % role_permissions',
      (SELECT COUNT(*) FROM public.permissions),
      (SELECT COUNT(*) FROM public.role_permissions);

    RAISE NOTICE 'RBAC seed completed successfully';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Seeding failed: %', SQLERRM;
    RAISE;
END $$;
-- Repair dedicated apikey management test bindings after seed DO block completes.
DELETE FROM public.role_bindings rb
USING public.apikeys ak
WHERE rb.principal_type = public.rbac_principal_apikey()
  AND rb.principal_id = ak.rbac_id
  AND rb.scope_type = public.rbac_scope_org()
  AND ak.id IN (112, 113);

INSERT INTO public.role_bindings (
  principal_type,
  principal_id,
  role_id,
  scope_type,
  org_id,
  granted_by,
  reason,
  is_direct
)
SELECT
  public.rbac_principal_apikey(),
  ak.rbac_id,
  roles.id,
  public.rbac_scope_org(),
  'f1a2b3c4-d5e6-4f70-8a9b-0c1d2e3f4a50'::uuid,
  ak.user_id,
  'Seeded apikey management test binding',
  true
FROM public.apikeys ak
JOIN (
  VALUES
    (112::bigint, public.rbac_role_org_super_admin()),
    (113::bigint, public.rbac_role_apikey_manager())
) AS management_keys (apikey_id, role_name)
  ON management_keys.apikey_id = ak.id
JOIN public.roles roles
  ON roles.scope_type = public.rbac_scope_org()
  AND roles.name = management_keys.role_name
WHERE ak.rbac_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.apikeys ak
    JOIN public.role_bindings rb
      ON rb.principal_type = public.rbac_principal_apikey()
      AND rb.principal_id = ak.rbac_id
    JOIN public.roles r ON r.id = rb.role_id
    WHERE ak.id = 113
      AND r.name = public.rbac_role_apikey_manager()
  ) THEN
    RAISE EXCEPTION 'seed verification failed: apikey 113 missing apikey_manager binding';
  END IF;
END $$;

-- Demo customer account (Acme Mobile) for MCP, screenshots and directory reviewers.
-- Called from a DO block: the CLI parses every seed statement before running any.
DO $$
BEGIN
  PERFORM public.reset_and_seed_demo_customer_data();
END $$;
