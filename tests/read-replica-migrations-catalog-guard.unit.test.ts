import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readReplicaSchemaCompatibilityIssues } from '../read_replicate/schema_compatibility.ts'

const committedCatalog = () => JSON.parse(
  readFileSync(new URL('../read_replicate/schema_replicate.catalog.json', import.meta.url), 'utf8'),
)

describe('read-replica migrations catalog guard', () => {
  it('passes when the committed snapshot matches itself', () => {
    const catalog = committedCatalog()
    expect(readReplicaSchemaCompatibilityIssues(catalog, catalog)).toEqual([])
  })

  it('blocks an apps NOT NULL column present only in migration-shaped catalog', () => {
    const expected = committedCatalog()
    expected.columns.push({
      default: "'default'::text",
      generated: '',
      identity: '',
      name: 'read_replica_guard_fixture',
      notNull: true,
      position: 999,
      table: 'apps',
      type: 'text',
    })
    expected.constraints.push({
      definition: "CHECK (read_replica_guard_fixture = ANY (ARRAY['default'::text, 'all'::text]))",
      name: 'apps_read_replica_guard_fixture_check',
      table: 'apps',
      type: 'c',
      valid: true,
    })

    const issues = readReplicaSchemaCompatibilityIssues(expected, committedCatalog())
    expect(issues.some(issue => issue.kind === 'column' && issue.object === 'apps.read_replica_guard_fixture')).toBe(true)
  })
})