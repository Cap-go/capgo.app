import { readFile } from 'node:fs/promises'
import { createPgliteEngine, Database } from 'tinbase'
import { loadSupabaseProject } from 'tinbase/node'
import { describe, expect, it } from 'vitest'
import { planReadReplicaSchemaSync } from '../read_replicate/schema_additive_sync.ts'
import { readReplicaSchemaCatalog, REPLICA_TABLES } from '../read_replicate/schema_catalog.ts'
import { readReplicaSubscriberCompatibilityIssues } from '../read_replicate/schema_compatibility.ts'

const migrationUrl = new URL(
  '../supabase/migrations/20260930105947_stop_manifest_per_version_replication.sql',
  import.meta.url,
)

describe('manifest-per-version replication exclusion', () => {
  it('does not select the primary-only table for subscriber schema reconciliation', async () => {
    const project = await loadSupabaseProject(process.cwd())
    const database = await Database.create(await createPgliteEngine())

    try {
      await database.runMigrations(project.migrations)
      expect(REPLICA_TABLES).not.toContain('manifest_per_version')
      const catalog = await readReplicaSchemaCatalog(database) as { tables: Array<{ name: string }> }
      expect(catalog.tables.map(table => table.name)).not.toContain('manifest_per_version')
      expect(planReadReplicaSchemaSync(catalog, catalog)).toEqual({ statements: [], skipped: [] })
      expect(readReplicaSubscriberCompatibilityIssues(catalog, catalog)).toEqual([])
    }
    finally {
      await database.close()
    }
  }, 30_000)

  it('removes only manifest_per_version from an existing publication, idempotently', async () => {
    const database = await Database.create(await createPgliteEngine())

    try {
      await database.query('CREATE TABLE public.manifest_per_version (version_id bigint PRIMARY KEY)')
      await database.query('CREATE TABLE public.apps (id bigint PRIMARY KEY)')
      await database.query('INSERT INTO public.manifest_per_version VALUES (1)')
      await database.query('CREATE PUBLICATION capgo_google_eu_2_pub FOR TABLE public.manifest_per_version, public.apps')
      await database.query('CREATE PUBLICATION capgo_google_replicate FOR TABLE public.manifest_per_version, public.apps')
      const migration = await readFile(migrationUrl, 'utf8')

      await database.query(migration)
      await database.query(migration)

      const publication = await database.query("SELECT pubname, tablename FROM pg_catalog.pg_publication_tables WHERE pubname IN ('capgo_google_eu_2_pub', 'capgo_google_replicate') ORDER BY pubname, tablename")
      expect(publication.rows.map(row => [row.pubname, row.tablename])).toEqual([
        ['capgo_google_eu_2_pub', 'apps'],
        ['capgo_google_replicate', 'apps'],
      ])
      const primaryRows = await database.query('SELECT version_id FROM public.manifest_per_version')
      expect(primaryRows.rows.map(row => Number(row.version_id))).toEqual([1])
    }
    finally {
      await database.close()
    }
  })

  it('succeeds when the production publication does not exist', async () => {
    const database = await Database.create(await createPgliteEngine())

    try {
      await database.query(await readFile(migrationUrl, 'utf8'))
    }
    finally {
      await database.close()
    }
  })
})
