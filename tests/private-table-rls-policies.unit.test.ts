import { createPgliteEngine, Database } from 'tinbase'
import { loadSupabaseProject } from 'tinbase/node'
import { describe, expect, it } from 'vitest'

describe('public table RLS protection', () => {
  it('enables RLS and defines a policy on every migration-owned public table', async () => {
    const project = await loadSupabaseProject(process.cwd())
    const database = await Database.create(await createPgliteEngine())

    try {
      await database.runMigrations(project.migrations)
      const missingRlsProtection = await database.query(`
        SELECT
          c.relname AS table_name,
          c.relrowsecurity AS rls_enabled,
          EXISTS (
            SELECT 1
            FROM pg_policy p
            WHERE p.polrelid = c.oid
          ) AS has_policy
        FROM pg_class c
        INNER JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND (
            NOT c.relrowsecurity
            OR NOT EXISTS (
              SELECT 1
              FROM pg_policy p
              WHERE p.polrelid = c.oid
            )
          )
        ORDER BY c.relname
      `)

      expect(missingRlsProtection.rows).toEqual([])

      const denyPolicies = await database.query(`
        WITH target_tables(table_name) AS (
          VALUES
            ('app_onboarding'),
            ('app_stats_refresh_state'),
            ('manifest_per_version'),
            ('manifest_trash_restore_pending'),
            ('mcp_oauth_clients'),
            ('mcp_oauth_requests'),
            ('org_stats_refresh_state'),
            ('updates_cache_purge_pending'),
            ('updates_cache_purge_state')
        )
        SELECT
          target_tables.table_name,
          count(p.oid)::integer AS policy_count,
          COALESCE(bool_and(
            c.relrowsecurity
            AND NOT p.polpermissive
            AND p.polcmd = '*'
            AND p.polroles = ARRAY[0::oid]
            AND pg_get_expr(p.polqual, p.polrelid) = 'false'
            AND pg_get_expr(p.polwithcheck, p.polrelid) = 'false'
          ), false) AS denies_all_direct_access
        FROM target_tables
        INNER JOIN pg_class c ON c.relname = target_tables.table_name
        INNER JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
        GROUP BY target_tables.table_name
        ORDER BY target_tables.table_name
      `)

      expect(denyPolicies.rows).toEqual([
        { table_name: 'app_onboarding', policy_count: 1, denies_all_direct_access: true },
        { table_name: 'app_stats_refresh_state', policy_count: 1, denies_all_direct_access: true },
        { table_name: 'manifest_per_version', policy_count: 1, denies_all_direct_access: true },
        { table_name: 'manifest_trash_restore_pending', policy_count: 1, denies_all_direct_access: true },
        { table_name: 'mcp_oauth_clients', policy_count: 1, denies_all_direct_access: true },
        { table_name: 'mcp_oauth_requests', policy_count: 1, denies_all_direct_access: true },
        { table_name: 'org_stats_refresh_state', policy_count: 1, denies_all_direct_access: true },
        { table_name: 'updates_cache_purge_pending', policy_count: 1, denies_all_direct_access: true },
        { table_name: 'updates_cache_purge_state', policy_count: 1, denies_all_direct_access: true },
      ])
    }
    finally {
      await database.close()
    }
  }, 30_000)
})
