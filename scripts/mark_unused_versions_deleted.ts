/*
 * Mark unused app_versions as deleted (soft delete).
 *
 * Default is dry-run. To apply updates:
 *   bun scripts/mark_unused_versions_deleted.ts --apply
 *
 * Optional:
 *   --input=./tmp/unused_versions/unused_versions.json
 */
import { createClient } from './db-client.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

const ENV_FILE = './internal/cloudflare/.env.prod'
const DEFAULT_INPUT = './tmp/unused_versions/broken_versions_unreferenced.json'
const CHUNK_SIZE = 500

function loadEnv(filePath: string) {
  const envText = Bun.file(filePath).text()
  return envText.then((text) => {
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx <= 0) continue
      const key = trimmed.slice(0, idx)
      const value = trimmed.slice(idx + 1)
      env[key] = value
    }
    return env
  })
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function getArgValue(prefix: string) {
  const arg = Bun.argv.find(a => a.startsWith(`${prefix}=`))
  if (!arg) return null
  return arg.slice(prefix.length + 1)
}

async function loadInput(path: string) {
  const text = await Bun.file(path).text()
  return JSON.parse(text) as Array<{ id: number; app_id: string; owner_org: string; name: string }>
}

async function main() {
  const apply = Bun.argv.includes('--apply') || Bun.env.APPLY_DELETE === 'true'
  const inputPath = getArgValue('--input') ?? DEFAULT_INPUT

  const items = await loadInput(inputPath)
  const ids = items.map(i => i.id)

  console.log(`Loaded ${ids.length} unused versions from ${inputPath}`)
  if (ids.length === 0) {
    console.log('Nothing to do.')
    return
  }

  if (!apply) {
    console.log('\nDry run (no updates). Use --apply to mark deleted.')
    console.log(`Sample ids: ${ids.slice(0, 10).join(', ')}`)
    return
  }

  const env = await loadEnv(ENV_FILE)
  const supabase = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL ?? env.DB_URL },
  )

  const chunks = chunkArray(ids, CHUNK_SIZE)
  let updated = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const { error } = await supabase
      .from('app_versions')
      .update({ deleted: true })
      .in('id', chunk)

    if (error) {
      console.error(`Error updating chunk ${i + 1}/${chunks.length}:`, error)
      process.exit(1)
    }

    updated += chunk.length
    process.stdout.write(`\rUpdated ${updated}/${ids.length}`)
  }

  process.stdout.write('\n')
  console.log('Done.')
}

await main()
