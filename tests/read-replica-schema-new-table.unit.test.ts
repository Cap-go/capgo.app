import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALLOWED_NEW_REPLICA_TABLES, planReadReplicaSchemaSync } from '../read_replicate/schema_additive_sync.ts'
import { REPLICA_TABLES } from '../read_replicate/schema_catalog.ts'
import {
  assertGoogleReadReplicaSchemaPlan,
  copyingReplicaTables,
  preflightCompatibilityIssues,
  READ_REPLICA_REFRESH_SUBSCRIPTION_SQL,
  readReplicaAnalyzeSql,
  renderReadReplicaImportTransaction,
  unsubscribedReplicaTables,
} from '../scripts/sync-read-replica-schema.ts'

const NEW_TABLES = ['delta_files', 'delta_sessions', 'version_files']

function snapshot() {
  return JSON.parse(readFileSync(new URL('../read_replicate/schema_replicate.catalog.json', import.meta.url), 'utf8'))
}

// The subscriber before the release: the replicated schema without the new tables.
function subscriberWithoutNewTables() {
  const catalog = snapshot()
  const isNew = (entry: { table?: string, name?: string, ownedTable?: string | null }) =>
    NEW_TABLES.includes(entry.table ?? '') || NEW_TABLES.includes(entry.ownedTable ?? '')
  catalog.tables = catalog.tables.filter((table: { name: string }) => !NEW_TABLES.includes(table.name))
  for (const key of ['columns', 'constraints', 'indexes', 'sequences'])
    catalog[key] = catalog[key].filter((entry: object) => !isNew(entry))
  return catalog
}

describe('read-replica new table provisioning', () => {
  it('creates the allowlisted delta storage tables with their exact SQL before migrations', () => {
    const expected = snapshot()
    const plan = planReadReplicaSchemaSync(expected, subscriberWithoutNewTables())

    expect(plan.skipped).toEqual([])
    const tables = plan.statements.filter(statement => statement.kind === 'table')
    expect(tables.map(statement => statement.table).sort()).toEqual(NEW_TABLES)
    for (const statement of tables)
      expect(statement.sql).toBe(ALLOWED_NEW_REPLICA_TABLES[statement.table].sql)
    // Columns, keys and identity sequences come with CREATE TABLE.
    expect(plan.statements.filter(statement => statement.kind !== 'table' && NEW_TABLES.includes(statement.table))).toEqual([])
    expect(plan.statements.some(statement => statement.name === 'delta_files_id_seq')).toBe(false)

    expect(() => assertGoogleReadReplicaSchemaPlan(plan)).not.toThrow()
    expect(preflightCompatibilityIssues(expected, subscriberWithoutNewTables(), plan)).toEqual([])
    expect(renderReadReplicaImportTransaction(tables)).toContain('CREATE TABLE public."delta_files"')
  })

  it('pins the allowlist to the replicated catalog snapshot', () => {
    const catalog = snapshot()
    for (const table of NEW_TABLES) {
      const allowed = ALLOWED_NEW_REPLICA_TABLES[table].catalog
      const columns = catalog.columns.filter((column: { table: string }) => column.table === table)
      expect(columns.map(({ position: _position, ...column }: { position: number }) => column)).toEqual(allowed.columns)
      expect(catalog.constraints.filter((entry: { table: string }) => entry.table === table)).toEqual(allowed.constraints)
      expect(catalog.indexes.filter((entry: { table: string }) => entry.table === table)).toEqual(allowed.indexes)
      expect(catalog.sequences.filter((entry: { ownedTable: string | null }) => entry.ownedTable === table)).toEqual(allowed.sequences)
    }
  })

  it('refuses to create a table whose migrated shape differs from the allowlist', () => {
    const expected = snapshot()
    const column = expected.columns.find((entry: { table: string, name: string }) => entry.table === 'version_files' && entry.name === 'file_ids')
    column.type = 'integer[]'
    const plan = planReadReplicaSchemaSync(expected, subscriberWithoutNewTables())

    expect(plan.statements.some(statement => statement.kind === 'table' && statement.table === 'version_files')).toBe(false)
    expect(plan.skipped).toContainEqual(expect.objectContaining({ kind: 'table', table: 'version_files', reason: 'unexpected_new_table_definition' }))
    expect(() => assertGoogleReadReplicaSchemaPlan(plan)).toThrow()
  })

  it('never creates an established replica table that went missing', () => {
    const expected = snapshot()
    const actual = snapshot()
    actual.tables = actual.tables.filter((table: { name: string }) => table.name !== 'channels')
    const plan = planReadReplicaSchemaSync(expected, actual)

    expect(plan.statements.some(statement => statement.kind === 'table')).toBe(false)
    expect(() => assertGoogleReadReplicaSchemaPlan({
      statements: [{ kind: 'table', table: 'channels', name: 'channels', sql: 'CREATE TABLE public."channels" ()' }],
      skipped: [],
    })).toThrow(/cannot create unsupported table channels/)
  })
})

describe('read-replica subscription refresh', () => {
  it('lists replicated tables the subscription does not stream yet', () => {
    const subscribed = REPLICA_TABLES.filter(table => !NEW_TABLES.includes(table))
    expect(unsubscribedReplicaTables(subscribed).sort()).toEqual(NEW_TABLES)
    expect(unsubscribedReplicaTables([...REPLICA_TABLES])).toEqual([])
  })

  it('waits until every replicated table finished its initial copy', () => {
    const ready = REPLICA_TABLES.map(table => ({ table_name: table, state: 'r' }))
    expect(copyingReplicaTables(ready)).toEqual([])
    const copying = ready.map(row => row.table_name === 'delta_files' ? { ...row, state: 'd' } : row)
    expect(copyingReplicaTables(copying)).toEqual(['delta_files'])
    expect(copyingReplicaTables(ready.filter(row => row.table_name !== 'version_files'))).toEqual(['version_files'])
  })

  it('refreshes with copy_data so new tables get their existing rows', () => {
    expect(READ_REPLICA_REFRESH_SUBSCRIPTION_SQL).toBe('ALTER SUBSCRIPTION capgo_google_eu_2_sub REFRESH PUBLICATION WITH (copy_data = true)')
  })

  it('analyzes only replicated tables after their initial copy', () => {
    expect(readReplicaAnalyzeSql(NEW_TABLES)).toBe('ANALYZE public."delta_files", public."delta_sessions", public."version_files"')
    expect(() => readReplicaAnalyzeSql(['pg_authid'])).toThrow('Not a replicated table: pg_authid')
  })

  it('runs the refresh after primary migrations in the release workflow', () => {
    const workflow = readFileSync(new URL('../.github/workflows/build_and_deploy.yml', import.meta.url), 'utf8')
    const job = workflow.slice(workflow.indexOf('  read_replica_subscription:'), workflow.indexOf('  build_webapp:'))
    expect(job).toContain('needs: [changes, supabase_deploy, read_replica_schema]')
    expect(job).toContain('bun scripts/sync-read-replica-schema.ts --refresh-subscription')
  })
})
