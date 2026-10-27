/*
 * Apply downgrade for broken default channels.
 *
 * Default is dry-run. To apply updates:
 *   bun scripts/apply_broken_default_downgrade.ts --apply
 *
 * Optional:
 *   --input=./tmp/unused_versions/broken_default_downgrade_candidates.json
 */
import { createClient } from './db-client.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

const ENV_FILE = './internal/cloudflare/.env.prod'
const DEFAULT_INPUT = './tmp/unused_versions/broken_default_downgrade_candidates.json'
const CHUNK_SIZE = 200

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
  return JSON.parse(text) as Array<{
    app_id: string
    owner_org: string
    channel_id: number
    channel_name: string
    broken_version_id: number
    broken_version_name: string
    candidate_version_id: number
    candidate_version_name: string
    candidate_deployed_at: string | null
  }>
}

async function main() {
  const apply = Bun.argv.includes('--apply') || Bun.env.APPLY_DOWNGRADE === 'true'
  const inputPath = getArgValue('--input') ?? DEFAULT_INPUT

  const items = await loadInput(inputPath)
  if (items.length === 0) {
    console.log('No candidates found. Nothing to do.')
    return
  }

  console.log(`Loaded ${items.length} candidates from ${inputPath}`)
  if (!apply) {
    console.log('\nDry run (no updates). Use --apply to perform downgrade.')
    return
  }

  const env = await loadEnv(ENV_FILE)
  const supabase = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL ?? env.DB_URL },
  )

  const chunks = chunkArray(items, CHUNK_SIZE)
  let updated = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    for (const row of chunk) {
      const { error } = await supabase
        .from('channels')
        .update({ version: row.candidate_version_id })
        .eq('id', row.channel_id)

      if (error) {
        console.error('Error updating channel:', { channel_id: row.channel_id, error })
        process.exit(1)
      }
      updated += 1
      process.stdout.write(`\rUpdated ${updated}/${items.length}`)
    }
  }

  process.stdout.write('\n')
  console.log('Done.')
}

await main()
