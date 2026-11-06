import { describe, expect, it } from 'vitest'
import { readReplicaSchemaCatalog, REPLICA_TABLES, REPLICA_TYPES, replicaConfigPattern } from '../read_replicate/schema_catalog.ts'

describe('read-replica schema catalog', () => {
  it('keeps primary-only onboarding refresh state out of Cloud SQL replication', () => {
    expect(REPLICA_TABLES).not.toContain('app_onboarding')
  })

  it('does not export the removed legacy RBAC enum', () => {
    expect(REPLICA_TYPES).not.toContain('user_min_right')
    expect(replicaConfigPattern(REPLICA_TYPES)).not.toContain('user_min_right')
  })

  it.concurrent(
    'makes the post-DDL catalog read uncacheable in Hyperdrive',
    async () => {
      const queries: Array<{ text: string, values?: unknown[] }> = []
      const catalog = await readReplicaSchemaCatalog({
        query: async (text, values) => {
          queries.push({ text, values })
          return { rows: [{ catalog: { version: 1 } }] }
        },
      })

      expect(catalog).toEqual({ version: 1 })
      expect(queries).toHaveLength(1)
      expect(queries[0]?.text).toContain('CURRENT_TIMESTAMP')
      expect(queries[0]?.text).toContain(
        'fresh_catalog_read.checked_at IS NOT NULL',
      )
      // Catalog content is exercised against real Postgres in
      // read-replica-schema-catalog.test.ts and read-replica-manifest-exclusion.unit.test.ts.
    },
  )
})
