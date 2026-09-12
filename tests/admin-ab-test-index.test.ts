import { afterAll, describe, expect, it } from 'vitest'
import { cleanupPostgresClient, executeSQL } from './test-utils.ts'

describe('admin A/B test distribution index', () => {
  afterAll(async () => {
    await cleanupPostgresClient()
  })

  it.concurrent('indexes the onboarding A/B assignment object with GIN', async () => {
    const rows = await executeSQL(
      `SELECT
         index_definition.indexdef
       FROM pg_catalog.pg_indexes AS index_definition
       WHERE index_definition.schemaname = 'public'
         AND index_definition.tablename = 'users'
         AND index_definition.indexname = 'users_onboarding_abtests_gin_idx'`,
    )

    expect(rows).toHaveLength(1)
    expect(String(rows[0]?.indexdef).toLowerCase()).toContain('using gin')
    expect(String(rows[0]?.indexdef)).toContain("(onboarding -> 'abtests'::text)")
  })
})
