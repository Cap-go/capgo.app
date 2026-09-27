import { createPgliteEngine, Database } from 'tinbase'
import { loadSupabaseProject } from 'tinbase/node'
import { describe, expect, it } from 'vitest'
import {
  MANIFEST_PER_VERSION_TABLE_SQL,
  planReadReplicaSchemaSync,
} from '../read_replicate/schema_additive_sync.ts'
import { readReplicaSchemaCatalog } from '../read_replicate/schema_catalog.ts'
import { readReplicaSubscriberCompatibilityIssues } from '../read_replicate/schema_compatibility.ts'
import {
  assertGoogleReadReplicaSchemaPlan,
  preflightCompatibilityIssues,
  renderReadReplicaImportTransaction,
} from '../scripts/sync-read-replica-schema.ts'

interface MutableCatalog {
  tables: Array<{ name: string }>
  columns: Array<{ table: string, name: string, type: string }>
  constraints: Array<{ table: string }>
  indexes: Array<{ table: string }>
}

describe('read-replica manifest-per-version table creation', () => {
  it('creates the exact missing subscriber table before the publisher migration', async () => {
    const project = await loadSupabaseProject(process.cwd())
    const database = await Database.create(await createPgliteEngine())

    try {
      await database.runMigrations(project.migrations)
      const expected = await readReplicaSchemaCatalog(database)
      await database.query('DROP TABLE public.manifest_per_version')
      const actual = await readReplicaSchemaCatalog(database)

      const plan = planReadReplicaSchemaSync(expected, actual)
      expect(plan.skipped).toEqual([])
      expect(plan.statements).toEqual([{
        kind: 'table',
        table: 'manifest_per_version',
        name: 'manifest_per_version',
        sql: MANIFEST_PER_VERSION_TABLE_SQL,
      }])
      expect(preflightCompatibilityIssues(expected, actual, plan)).toEqual([])
      expect(() => assertGoogleReadReplicaSchemaPlan(plan)).not.toThrow()
      expect(renderReadReplicaImportTransaction(plan.statements)).toContain(
        MANIFEST_PER_VERSION_TABLE_SQL,
      )

      await database.query(MANIFEST_PER_VERSION_TABLE_SQL)
      const after = await readReplicaSchemaCatalog(database)
      expect(readReplicaSubscriberCompatibilityIssues(expected, after)).toEqual([])
      expect(planReadReplicaSchemaSync(expected, after).statements).toEqual([])
    }
    finally {
      await database.close()
    }
  })

  it('refuses changed definitions and missing established tables', async () => {
    const project = await loadSupabaseProject(process.cwd())
    const database = await Database.create(await createPgliteEngine())

    try {
      await database.runMigrations(project.migrations)
      const expected = await readReplicaSchemaCatalog(database)
      const actual = structuredClone(expected) as MutableCatalog
      actual.tables = actual.tables.filter(table => table.name !== 'manifest_per_version' && table.name !== 'apps')
      actual.columns = actual.columns.filter(column => column.table !== 'manifest_per_version' && column.table !== 'apps')
      actual.constraints = actual.constraints.filter(constraint => constraint.table !== 'manifest_per_version' && constraint.table !== 'apps')
      actual.indexes = actual.indexes.filter(index => index.table !== 'manifest_per_version' && index.table !== 'apps')

      const changed = structuredClone(expected) as MutableCatalog
      const payloadColumn = changed.columns.find(column => column.table === 'manifest_per_version' && column.name === 'manifest')
      expect(payloadColumn).toBeDefined()
      payloadColumn!.type = 'text'

      const plan = planReadReplicaSchemaSync(changed, actual)
      expect(plan.statements).not.toContainEqual(expect.objectContaining({ kind: 'table' }))
      expect(plan.skipped).toContainEqual(expect.objectContaining({
        kind: 'table',
        table: 'manifest_per_version',
        reason: 'unexpected_manifest_per_version_definition',
      }))
      expect(() => assertGoogleReadReplicaSchemaPlan(plan)).toThrow('cannot reconcile skipped table')
    }
    finally {
      await database.close()
    }
  })
})
