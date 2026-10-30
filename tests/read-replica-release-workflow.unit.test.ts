import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { REPLICA_TABLES } from '../read_replicate/schema_catalog.ts'
import { readReplicaSchemaCatalogFromMigrations } from '../read_replicate/schema_catalog_from_migrations.ts'

const workflowUrl = new URL(
  '../.github/workflows/build_and_deploy.yml',
  import.meta.url,
)

async function readReleaseWorkflow(): Promise<string> {
  return readFile(workflowUrl, 'utf8')
}

describe('production read-replica release gate', () => {
  it.concurrent(
    'does not run read-replica schema sync in the deploy workflow',
    async () => {
      const workflow = await readReleaseWorkflow()

      expect(workflow).not.toContain('read_replica_schema:')
      expect(workflow).not.toContain('read_replica_subscription:')
      expect(workflow).not.toContain('sync-read-replica-schema.ts')
      expect(workflow).not.toContain('read_replica_schema')
      expect(workflow).toContain('supabase_deploy:\n    needs: [changes]')
      expect(workflow).toContain('sync_schema_types:\n    needs: [changes, supabase_deploy]')
    },
  )

  it(
    'builds the release catalog from all local migrations through PGlite',
    async () => {
      const catalog = await readReplicaSchemaCatalogFromMigrations() as {
        tables: Array<{ name: string }>
      }

      expect(catalog.tables.map(table => table.name)).toEqual(
        [...REPLICA_TABLES].sort(),
      )
    },
    30_000,
  )
})
