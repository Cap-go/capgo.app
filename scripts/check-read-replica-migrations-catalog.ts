import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { readReplicaSchemaCompatibilityIssues } from '../read_replicate/schema_compatibility.ts'
import { readReplicaSchemaCatalogFromMigrations } from '../read_replicate/schema_catalog_from_migrations.ts'

const COMMITTED_CATALOG_PATH = 'read_replicate/schema_replicate.catalog.json'

async function main() {
  const [expected, committedRaw] = await Promise.all([
    readReplicaSchemaCatalogFromMigrations(),
    readFile(COMMITTED_CATALOG_PATH, 'utf8'),
  ])
  const committed = JSON.parse(committedRaw)
  const issues = readReplicaSchemaCompatibilityIssues(expected, committed)

  if (!issues.length) {
    console.log('Migrations match read_replica/schema_replicate.catalog.json for replicated tables.')
    return
  }

  console.error(
    '::error title=Read-replica schema snapshot out of date::A pending migration changes replicated tables but read_replicate/schema_replicate.sql and read_replicate/schema_replicate.catalog.json were not updated.',
  )
  console.error('')
  console.error('Before primary Supabase migrations ship, run:')
  console.error('  bun run readreplicate:prepare')
  console.error('  commit read_replicate/schema_replicate.sql and read_replicate/schema_replicate.catalog.json')
  console.error('')
  console.error('Incompatible objects:')
  for (const issue of issues)
    console.error(`- ${issue.kind} ${issue.object}: ${issue.reason}`)
  process.exitCode = 1
}

await main()