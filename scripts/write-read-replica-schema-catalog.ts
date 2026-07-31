import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Pool } from 'pg'
import { readReplicaSchemaCatalog, stableStringify } from '../read_replicate/schema_catalog.ts'

const firstArg = process.argv[2]
const secondArg = process.argv[3]
const defaultOutputPath = 'read_replicate/schema_replicate.catalog.json'
const firstArgIsPostgresUrl = Boolean(firstArg?.startsWith('postgres://') || firstArg?.startsWith('postgresql://'))
const connectionString = firstArgIsPostgresUrl ? firstArg : process.env.MAIN_SUPABASE_DB_URL
const outputPath = firstArgIsPostgresUrl
  ? (secondArg || defaultOutputPath)
  : (firstArg || defaultOutputPath)
if (!connectionString) {
  console.error('Usage: MAIN_SUPABASE_DB_URL=<postgres-url> bun scripts/write-read-replica-schema-catalog.ts [output-path]')
  console.error('   or: bun scripts/write-read-replica-schema-catalog.ts <postgres-url> [output-path]')
  process.exit(1)
}

const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 10000,
})

try {
  const catalog = await readReplicaSchemaCatalog(pool)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${stableStringify(catalog)}\n`)
  console.log(`Wrote read-replica schema catalog to ${outputPath}`)
}
finally {
  await pool.end()
}
