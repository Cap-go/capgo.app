import process from 'node:process'
import { createPgliteEngine, Database } from 'tinbase'
import { loadSupabaseProject } from 'tinbase/node'
import { readReplicaSchemaCatalog } from './schema_catalog.ts'

export async function readReplicaSchemaCatalogFromMigrations(): Promise<unknown> {
  const project = await loadSupabaseProject(process.cwd())
  const database = await Database.create(await createPgliteEngine())

  try {
    await database.runMigrations(project.migrations)
    return await readReplicaSchemaCatalog(database)
  }
  finally {
    await database.close()
  }
}
