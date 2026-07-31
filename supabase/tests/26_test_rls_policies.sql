-- Test RLS Policies
-- This file tests all Row Level Security policies in the database
BEGIN;
SELECT plan(70);
SELECT
    policies_are(
        'public',
        'app_versions',
        ARRAY[
            'Allow RBAC app_versions super-admin access',
            'Allow for auth, api keys (read+)',
            'Allow RBAC app_versions insert',
            'Allow RBAC app_versions update',
            'Prevent non 2FA access'
        ],
        'app_versions should have correct policies'
    );

-- Test apps policies
SELECT
    policies_are(
        'public',
        'apps',
        ARRAY[
            'Allow RBAC apps super-admin access',
            'Allow for auth, api keys (read+)',
            'Allow RBAC apps insert',
            'Allow RBAC apps update',
            'Prevent non 2FA access'
        ],
        'apps should have correct policies'
    );

-- Test global_stats policies
SELECT
    policies_are(
        'public',
        'global_stats',
        ARRAY['Allow none to select']::text [],
        'global_stats should have correct policies'
    );

-- Test stats policies
SELECT
    policies_are(
        'public',
        'stats',
        ARRAY[
            'Allow read for auth (read+)'
        ],
        'stats should have correct policies'
    );

-- Test channel_devices policies
SELECT
    policies_are(
        'public',
        'channel_devices',
        ARRAY[
            'Allow RBAC channel_devices delete',
            'Allow RBAC channel_devices insert',
            'Allow read for auth, api keys (read+)',
            'Allow RBAC channel_devices update',
            'Prevent non 2FA access'
        ],
        'channel_devices should have correct policies'
    );
SELECT
    is(
        (
            SELECT confdeltype::text
            FROM pg_constraint
            WHERE conrelid = 'public.channel_devices'::regclass
              AND conname = 'channel_devices_channel_id_fkey'
        ),
        'c',
        'channel_devices should cascade when a channel is deleted'
    );

SELECT
    is(
        (
            SELECT array_agg(policy_role::text ORDER BY policy_role::text)
            FROM pg_policies
            CROSS JOIN unnest(roles) AS policy_role
            WHERE schemaname = 'public'
              AND tablename = 'channel_devices'
              AND policyname = 'Allow RBAC channel_devices insert'
        ),
        ARRAY['anon', 'authenticated']::text[],
        'channel_devices insert should allow anon API-key and authenticated JWT traffic'
    );


-- Test channel_permission_overrides policies
SELECT
    policies_are(
        'public',
        'channel_permission_overrides',
        ARRAY[
            'channel_permission_overrides_admin_delete',
            'channel_permission_overrides_admin_insert',
            'channel_permission_overrides_admin_select',
            'channel_permission_overrides_admin_update'
        ],
        'channel_permission_overrides should have split write policies and one select policy'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_policies
            WHERE
                schemaname = 'public'
                AND tablename = 'channel_permission_overrides'
                AND permissive = 'PERMISSIVE'
                AND 'authenticated' = any(roles)
                AND cmd IN ('SELECT', 'ALL')
        ),
        1::bigint,
        'channel_permission_overrides should expose only one permissive SELECT path for authenticated'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM (
                SELECT
                    schemaname,
                    tablename,
                    cmd
                FROM pg_policies
                WHERE
                    schemaname = 'public'
                    AND permissive = 'PERMISSIVE'
                GROUP BY
                    schemaname,
                    tablename,
                    cmd
                HAVING count(*) > 1
            ) duplicate_public_policies
        ),
        0::bigint,
        'public RLS should not have duplicate permissive policies for the same table operation'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM (
                SELECT role_name
                FROM pg_policies
                CROSS JOIN LATERAL unnest(roles) AS role_name
                WHERE schemaname = 'public'
                  AND tablename = 'channel_devices'
                  AND permissive = 'PERMISSIVE'
                  AND cmd = 'SELECT'
                  AND role_name IN ('anon', 'authenticated')
                GROUP BY role_name
                HAVING count(*) > 1
            ) duplicate_channel_devices_select_roles
        ),
        0::bigint,
        'channel_devices should have one permissive SELECT policy per API role'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM (
                SELECT role_name
                FROM pg_policies
                CROSS JOIN LATERAL unnest(roles) AS role_name
                WHERE schemaname = 'public'
                  AND tablename = 'sso_providers'
                  AND permissive = 'PERMISSIVE'
                  AND cmd = 'SELECT'
                  AND role_name IN ('anon', 'authenticated')
                GROUP BY role_name
                HAVING count(*) > 1
            ) duplicate_sso_provider_select_roles
        ),
        0::bigint,
        'sso_providers should have one permissive SELECT policy per API role'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'manifest'
              AND indexname IN ('manifest_file_hash_idx', 'manifest_file_name_idx')
        ),
        0::bigint,
        'manifest should not retain redundant single-column indexes'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename = 'manifest'
              AND indexname IN ('idx_manifest_file_hash', 'idx_manifest_file_name')
        ),
        2::bigint,
        'manifest should retain the supported single-column indexes'
    );

-- Test orgs policies
SELECT
    policies_are(
        'public',
        'orgs',
        ARRAY[
            'Allow insert org for user',
            'Allow org delete for super_admin',
            'Allow select for auth, api keys (read+)',
            'Allow org settings update via RBAC',
            'Prevent non 2FA access'
        ],
        'orgs should have correct policies'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'orgs'
              AND column_name = 'use_new_rbac'
        ),
        0::bigint,
        'orgs should not keep the old RBAC opt-in column'
    );

SELECT
    is(
        (
            SELECT (COALESCE(qual, '') || COALESCE(with_check, '')) !~ 'key_mode|all,write'
            FROM pg_policies
            WHERE
                schemaname = 'public'
                AND tablename = 'orgs'
                AND policyname = 'Allow org settings update via RBAC'
        ),
        true,
        'orgs update policy should use named RBAC instead of legacy key modes'
    );

SELECT
    is(
        COALESCE(
            (
                SELECT roles @> ARRAY['anon'::name, 'authenticated'::name]
                FROM pg_policies
                WHERE
                    schemaname = 'public'
                    AND tablename = 'orgs'
                    AND policyname = 'Allow org settings update via RBAC'
            ),
            false
        ),
        true,
        'orgs update policy should support API-key anon RLS and authenticated users'
    );

-- Test apikey_global_permissions policies
SELECT
    policies_are(
        'public',
        'apikey_global_permissions',
        ARRAY[
            'Deny delete on apikey_global_permissions',
            'Deny insert on apikey_global_permissions',
            'Deny select on apikey_global_permissions',
            'Deny update on apikey_global_permissions'
        ],
        'apikey_global_permissions should have correct restrictive policies'
    );

-- Test devices policies
SELECT
    policies_are(
        'public',
        'devices',
        ARRAY[
            'Allow org member to insert devices',
            'Allow org member to select devices',
            'Allow org member to update devices'
        ],
        'devices should have correct policies'
    );

-- Test app_versions_meta policies
SELECT
    policies_are(
        'public',
        'app_versions_meta',
        ARRAY['Allow read for auth (read+)'],
        'app_versions_meta should have correct policies'
    );

-- Test daily_bandwidth policies
SELECT
    policies_are(
        'public',
        'daily_bandwidth',
        ARRAY['Allow read for auth (read+)'],
        'daily_bandwidth should have correct policies'
    );

-- Test daily_mau policies
SELECT
    policies_are(
        'public',
        'daily_mau',
        ARRAY['Allow read for auth (read+)'],
        'daily_mau should have correct policies'
    );

-- Test daily_storage policies
SELECT
    policies_are(
        'public',
        'daily_storage',
        ARRAY['Allow read for auth (read+)'],
        'daily_storage should have correct policies'
    );

-- Test daily_version policies
SELECT
    policies_are(
        'public',
        'daily_version',
        ARRAY['Allow read for auth (read+)'],
        'daily_version should have correct policies'
    );

-- Test users policies
SELECT
    policies_are(
        'public',
        'users',
        ARRAY[
            'Allow owner to insert own users',
            'Allow owner to select own user',
            'Allow owner to update own users',
            'Disallow owner to delete own users'
        ],
        'users should have correct policies'
    );

-- Test org_users policies
SELECT
    policies_are(
        'public',
        'org_users',
        ARRAY[
            'Allow org admin to update',
            'Allow to self delete',
            'Allow org admin to insert',
            'Prevent non 2FA access',
            'Allow member and owner to select'
        ],
        'org_users should have correct policies'
    );

-- Test channels policies
SELECT
    policies_are(
        'public',
        'channels',
        ARRAY[
            'Allow RBAC channels delete',
            'Allow RBAC channels insert',
            'Allow select for auth, api keys (read+)',
            'Allow RBAC channels update',
            'Prevent non 2FA access'
        ],
        'channels should have correct policies'
    );

SELECT
    ok(
        (
            SELECT (
                COALESCE(qual, '')
                || ' '
                || COALESCE(with_check, '')
            ) ~ 'rbac_perm_channel_update_settings'
            AND (
                COALESCE(qual, '')
                || ' '
                || COALESCE(with_check, '')
            ) !~ 'rbac_perm_app_update_settings'
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'channels'
              AND policyname = 'Allow RBAC channels update'
        ),
        'channels update policy should honor channel-scoped update permission'
    );

SELECT
    ok(
        NOT EXISTS (
            SELECT 1
            FROM
                public.role_permissions
            JOIN public.roles
                ON roles.id = role_permissions.role_id
            JOIN public.permissions
                ON permissions.id = role_permissions.permission_id
            WHERE
                roles.name = public.rbac_role_app_developer()
                AND permissions.key = public.rbac_perm_channel_update_settings()
        ),
        'app developer role should not mutate channel settings through direct RLS'
    );

-- Test stripe_info policies
SELECT
    policies_are(
        'public',
        'stripe_info',
        ARRAY['Allow org member to select stripe_info'],
        'stripe_info should have correct policies'
    );

-- Test daily_revenue_metrics policies
SELECT
    policies_are(
        'public',
        'daily_revenue_metrics',
        ARRAY['Deny all access'],
        'daily_revenue_metrics should deny all user-context access'
    );

-- Test processed_stripe_events policies
SELECT
    policies_are(
        'public',
        'processed_stripe_events',
        ARRAY['Deny all access'],
        'processed_stripe_events should deny all user-context access'
    );

SELECT
    ok(
        (
            SELECT c.relrowsecurity
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = 'daily_revenue_metrics'
        ),
        'daily_revenue_metrics should have RLS enabled'
    );

SELECT
    ok(
        (
            SELECT c.relrowsecurity
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = 'processed_stripe_events'
        ),
        'processed_stripe_events should have RLS enabled'
    );

-- Test manifest policies
SELECT
    policies_are(
        'public',
        'manifest',
        ARRAY[
            'Allow select for auth, api keys (read+)',
            'Prevent users from deleting manifest entries',
            'Prevent users from inserting manifest entries',
            'Prevent users from updating manifest entries'
        ],
        'manifest should have correct policies'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_policies
            WHERE
                schemaname = 'public'
                AND tablename = 'manifest'
                AND policyname = 'Prevent users from updating manifest entries'
                AND permissive = 'RESTRICTIVE'
                AND cmd = 'UPDATE'
                AND roles @> ARRAY['anon', 'authenticated']::name []
                AND array_length(roles, 1) = 2
                AND qual = 'false'
                AND with_check = 'false'
        ),
        1::bigint,
        'manifest update deny policy should match restrictive role shape'
    );

-- Test deploy_history policies
SELECT
    policies_are(
        'public',
        'deploy_history',
        ARRAY[
            'Allow users to view deploy history for their org',
            'Deny insert via RBAC',
            'Deny delete on deploy history',
            'Prevent update on deploy history'
        ],
        'deploy_history should have correct policies'
    );

-- Test bandwidth_usage policies
SELECT
    policies_are(
        'public',
        'bandwidth_usage',
        ARRAY['Disable for all'],
        'bandwidth_usage should have correct policies'
    );

-- Test device_usage policies
SELECT
    policies_are(
        'public',
        'device_usage',
        ARRAY['Disable for all'],
        'device_usage should have correct policies'
    );

-- Test notifications policies
SELECT
    policies_are(
        'public',
        'notifications',
        ARRAY['Disable for all'],
        'notifications should have correct policies'
    );

-- Test storage_usage policies
SELECT
    policies_are(
        'public',
        'storage_usage',
        ARRAY['Disable for all'],
        'storage_usage should have correct policies'
    );

-- Test version_meta policies
SELECT
    policies_are(
        'public',
        'version_meta',
        ARRAY['Disable for all'],
        'version_meta should have correct policies'
    );

-- Test version_usage policies
SELECT
    policies_are(
        'public',
        'version_usage',
        ARRAY['Disable for all'],
        'version_usage should have correct policies'
    );

-- Test apikeys policies
SELECT
    policies_are(
        'public',
        'apikeys',
        ARRAY[
            'Allow owner to delete own apikeys',
            'Allow owner to select own apikeys',
            'Deny anon delete on apikeys',
            'Deny anon select on apikeys',
            'Deny client update on apikeys',
            'Deny client insert on apikeys',
            'Prevent non 2FA access'
        ],
        'apikeys should have correct policies'
    );

-- usage_credit_ledger should respect caller RLS and allow authenticated reads
SELECT
    ok(
        has_table_privilege(
            'authenticated',
            'public.usage_credit_ledger',
            'SELECT'
        ),
        'usage_credit_ledger grants SELECT to authenticated'
    );

SELECT
    ok(
        EXISTS (
            SELECT 1
            FROM
                pg_class AS c
            WHERE
                c.relname = 'usage_credit_ledger'
                AND c.relkind = 'v'
                AND EXISTS (
                    SELECT 1
                    FROM
                        unnest(c.reloptions) AS opt
                    WHERE
                        opt LIKE 'security_invoker%'
                )
        ),
        'usage_credit_ledger runs with security_invoker to enforce base table RLS'
    );

-- Test plans policies
SELECT
    policies_are(
        'public',
        'plans',
        ARRAY['Enable select for anyone'],
        'plans should have correct policies'
    );

-- Test deleted_account policies
SELECT
    policies_are(
        'public',
        'deleted_account',
        ARRAY['Enable update for users based on email'],
        'deleted_account should have correct policies'
    );

-- Test deleted_apps policies
SELECT
    policies_are(
        'public',
        'deleted_apps',
        ARRAY['deny_all_access'],
        'deleted_apps should have correct policies'
    );

-- Test storage.objects policies
SELECT
    policies_are(
        'storage',
        'objects',
        ARRAY[
            'Allow user or apikey to delete they own folder in apps',
            'Allow user or apikey to delete they own folder in images',
            'Allow user or apikey to insert they own folder in apps',
            'Allow user or apikey to insert they own folder in images',
            'Allow user or apikey to read they own folder in apps',
            'Allow user or apikey to read they own folder in images',
            'Allow user or apikey to update they own folder in apps',
            'Allow user or apikey to update they own folder in images'
        ],
        'storage.objects should have correct policies'
    );

-- Test storage.buckets policies
SELECT
    policies_are(
        'storage',
        'buckets',
        ARRAY['Disable act bucket for users'],
        'storage.buckets should have correct policies'
    );

-- Additional tests for policy roles and commands
-- Test that restrictive policies are marked as restrictive
SELECT
    is(
        (
            SELECT count(*)
            FROM
                pg_policies
            WHERE
                schemaname = 'public'
                AND tablename = 'apikeys'
                AND policyname = 'Prevent non 2FA access'
                AND permissive = 'RESTRICTIVE'
        ),
        1::bigint,
        'Prevent non 2FA access policy on apikeys should be restrictive'
    );

-- Test policy commands for specific policies
SELECT
    policy_cmd_is(
        'public',
        'app_versions',
        'Allow RBAC app_versions super-admin access',
        'DELETE',
        'Delete policy on app_versions should be for DELETE command'
    );

SELECT
    policy_cmd_is(
        'public',
        'apps',
        'Allow for auth, api keys (read+)',
        'SELECT',
        'Read policy on apps should be for SELECT command'
    );

SELECT
    policy_cmd_is(
        'public',
        'channel_devices',
        'Allow RBAC channel_devices insert',
        'INSERT',
        'Insert policy on channel_devices should be for INSERT command'
    );

SELECT
    policy_cmd_is(
        'public',
        'orgs',
        'Allow org settings update via RBAC',
        'UPDATE',
        'Update policy on orgs should be for UPDATE command'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_policies
            WHERE schemaname IN ('public', 'storage')
              AND (
                COALESCE(qual, '')
                || ' '
                || COALESCE(with_check, '')
              ) ~ 'check_min_rights|get_identity|has_app_right|matches_app_storage_apikey_owner|rbac_legacy|rbac_org_role_for_legacy|rbac_permission_for_legacy|key_mode'
        ),
        0::bigint,
        'user-facing RLS policies should not call old rights helpers or key-mode checks'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'capgo_private')
              AND p.proname IN (
                'app_versions_has_app_permission',
                'matches_app_storage_apikey_owner',
                'check_min_rights',
                'check_min_rights_legacy',
                'check_min_rights_legacy_no_password_policy',
                'get_identity',
                'get_identity_apikey_only',
                'get_identity_for_apikey_creation',
                'get_identity_org_allowed',
                'get_identity_org_allowed_apikey_only',
                'get_identity_org_appid',
                'get_org_owner_id',
                'has_app_right',
                'has_app_right_apikey',
                'has_app_right_userid',
                'force_org_rbac_enabled',
                'invite_user_to_org',
                'modify_permissions_tmp',
                'rbac_legacy_right_for_org_role',
                'rbac_legacy_right_for_permission',
                'rbac_legacy_role_hint',
                'rbac_org_role_for_legacy_right',
                'rbac_permission_for_legacy',
                'request_read_key_modes',
                'transform_role_to_invite',
                'transform_role_to_non_invite',
                'apikey_permission_for_keymode',
                'rbac_migrate_org_users_to_bindings',
                'rbac_preview_migration',
                'rbac_enable_for_org',
                'rbac_rollback_org',
                'rbac_is_enabled_for_org'
              )
        ),
        0::bigint,
        'old rights helper functions should be deleted'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND (
                (table_name = 'org_users' AND column_name = 'user_right')
                OR (table_name = 'tmp_users' AND column_name = 'role')
              )
        ),
        0::bigint,
        'old org membership rights columns should be deleted'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public'
              AND t.typname IN ('key_mode', 'user_min_right')
        ),
        0::bigint,
        'old API key mode and org right enum types should be deleted'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.prokind = 'f'
              AND n.nspname IN ('public', 'capgo_private')
              AND pg_get_functiondef(p.oid) ~ 'check_min_rights|get_identity|has_app_right|rbac_legacy|rbac_org_role_for_legacy|rbac_permission_for_legacy|transform_role_to|request_read_key_modes|apikey_permission_for_keymode|user_right|key_mode'
        ),
        0::bigint,
        'SQL functions should not reference old rights helpers, key modes, or org rights columns'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.prokind = 'f'
              AND n.nspname = 'public'
              AND p.proname IN (
                'audit_logs_allowed_orgs',
                'get_user_main_org_id_by_app_id',
                'request_has_app_read_access',
                'request_has_org_read_access',
                'usage_credit_readable_org_ids'
              )
              AND pg_get_functiondef(p.oid) ~ 'check_min_rights|get_identity|has_app_right|rbac_legacy|rbac_org_role_for_legacy|rbac_permission_for_legacy|key_mode|user_min_right'
        ),
        0::bigint,
        'RLS helper functions should be RBAC-only'
    );

SELECT
    is(
        (
            SELECT permissive
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'apikeys'
              AND policyname = 'Deny client update on apikeys'
        ),
        'RESTRICTIVE',
        'apikeys direct update deny should be restrictive'
    );

SELECT
    is(
        (
            SELECT permissive
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'apikeys'
              AND policyname = 'Deny anon select on apikeys'
        ),
        'RESTRICTIVE',
        'apikeys anon select deny should be restrictive'
    );

SELECT
    is(
        (
            SELECT permissive
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'apikeys'
              AND policyname = 'Deny anon delete on apikeys'
        ),
        'RESTRICTIVE',
        'apikeys anon delete deny should be restrictive'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = 'apikeys'
              AND cmd IN ('UPDATE', 'ALL')
              AND permissive = 'PERMISSIVE'
              AND roles && ARRAY['anon', 'authenticated']::name[]
        ),
        0::bigint,
        'apikeys should have no permissive user-facing update policy'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_namespace
            WHERE nspname = 'capgo_private'
        ),
        0::bigint,
        'capgo_private schema should not exist'
    );

SELECT
    is(
        (
            SELECT
                has_function_privilege('anon', 'public.get_orgs_v7(uuid)'::regprocedure, 'EXECUTE')::text
                || ','
                || has_function_privilege('authenticated', 'public.get_orgs_v7(uuid)'::regprocedure, 'EXECUTE')::text
                || ','
                || has_function_privilege('service_role', 'public.get_orgs_v7(uuid)'::regprocedure, 'EXECUTE')::text
        ),
        'false,false,true',
        'get_orgs_v7(userid) should be executable only by service_role'
    );

SELECT
    is(
        (
            SELECT count(*)
            FROM pg_proc proc
            JOIN LATERAL unnest(proc.proallargtypes, proc.proargmodes, proc.proargnames)
              WITH ORDINALITY AS args(type_oid, arg_mode, arg_name, ordinality) ON true
            WHERE proc.oid IN ('public.get_orgs_v7()'::regprocedure, 'public.get_orgs_v7(uuid)'::regprocedure)
              AND args.arg_mode = 't'
              AND args.arg_name = 'is_invite'
        ),
        2::bigint,
        'get_orgs_v7 overloads should expose explicit invite state'
    );

-- Complete the tests
SELECT *
FROM
    finish();

ROLLBACK;
