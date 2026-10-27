/*
 * Delete all manifest rows for candidate versions and set manifest_count = 0.
 *
 * Usage:
 *   bun scripts/apply_broken_manifests_cleanup.ts
 *   bun scripts/apply_broken_manifests_cleanup.ts --apply
 *
 * Optional:
 *   --input=./tmp/unused_versions/broken_manifest_cleanup_candidates.json
 */
import { createClient } from './db-client.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

const ENV_FILE = './internal/cloudflare/.env.prod'
const DEFAULT_INPUT = './tmp/unused_versions/broken_manifest_cleanup_candidates.json'
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
    id: number
    app_id: string
    owner_org: string
    name: string
    manifest_count: number
  }>
}

async function main() {
  const apply = Bun.argv.includes('--apply') || Bun.env.APPLY_CLEANUP === 'true'
  const inputPath = getArgValue('--input') ?? DEFAULT_INPUT

  const items = await loadInput(inputPath)
  if (items.length === 0) {
    console.log('No candidates found. Nothing to do.')
    return
  }

  console.log(`Loaded ${items.length} candidates from ${inputPath}`)
  if (!apply) {
    console.log('\nDry run (no updates). Use --apply to perform cleanup.')
    return
  }

  const env = await loadEnv(ENV_FILE)
  const supabase = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL },
  )

  const chunks = chunkArray(items, CHUNK_SIZE)
  let updated = 0
  let updatedApps = 0

  for (const chunk of chunks) {
    for (const row of chunk) {
      if (row.app_id.startsWith('com.capdemo')) {
        continue
      }
      const { error: deleteError } = await supabase
        .from('manifest')
        .delete()
        .eq('app_version_id', row.id)

      if (deleteError) {
        console.error('Error deleting manifest rows:', { version_id: row.id, error: deleteError })
        process.exit(1)
      }

      const { error: updateError } = await supabase
        .from('app_versions')
        .update({ manifest_count: 0 })
        .eq('id', row.id)

      if (updateError) {
        console.error('Error updating manifest_count:', { version_id: row.id, error: updateError })
        process.exit(1)
      }

      const { data: appData, error: appReadError } = await supabase
        .from('apps')
        .select('manifest_bundle_count')
        .eq('app_id', row.app_id)
        .single()

      if (appReadError) {
        console.error('Error reading app manifest_bundle_count:', { app_id: row.app_id, error: appReadError })
        process.exit(1)
      }

      const currentCount = appData?.manifest_bundle_count ?? 0
      const nextCount = Math.max(currentCount - 1, 0)

      const { error: appError } = await supabase
        .from('apps')
        .update({ manifest_bundle_count: nextCount })
        .eq('app_id', row.app_id)

      if (appError) {
        console.error('Error updating app manifest_bundle_count:', { app_id: row.app_id, error: appError })
        process.exit(1)
      }
      updatedApps += 1

      updated += 1
      process.stdout.write(`\rUpdated ${updated}/${items.length}`)
    }
  }

  process.stdout.write('\n')
  console.log('Done.')
  console.log(`Updated apps: ${updatedApps}`)
}

await main()
