import { describe, expect, it } from 'vitest'
import { REPLICA_TYPES, readReplicaSchemaCatalog, replicaConfigPattern } from '../read_replicate/schema_catalog.ts'

describe('read-replica schema catalog', () => {
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
      expect(queries[0]?.text).toContain(
        'constraint_owner.conindid = ix.indexrelid',
      )
      expect(queries[0]?.text).toContain(
        "constraint_owner.contype IN ('p', 'u', 'x')",
      )
      expect(queries[0]?.text).toContain('con.convalidated AS is_valid')
      expect(queries[0]?.text).toContain('dep.deptype IN (\'a\', \'i\')')
      expect(queries[0]?.text).toContain("'valid', is_valid")
      expect(queries[0]?.text).toContain("'constraintOwned', constraint_owned")
      expect(queries[0]?.text).toContain('WITH RECURSIVE')
      expect(queries[0]?.text).toContain('referenced_types(type_oid)')
      expect(queries[0]?.text).toContain(
        'JOIN pg_type typ ON typ.oid = referenced.type_oid',
      )
      expect(queries[0]?.text).toContain('selected_sequence_oids(sequence_oid)')
      expect(queries[0]?.text).toContain(
        'JOIN selected_sequence_oids selected_sequence',
      )
      expect(queries[0]?.text).toContain('JOIN selected_type_names rt')
    },
  )
})
