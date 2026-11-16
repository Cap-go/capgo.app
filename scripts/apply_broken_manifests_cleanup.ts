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
import { connectScriptDb, getDatabaseUrl } from './script_db.ts'

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
  const db = await connectScriptDb(getDatabaseUrl(env))

  const chunks = chunkArray(items, CHUNK_SIZE)
  let updated = 0
  let updatedApps = 0

  for (const chunk of chunks) {
    for (const row of chunk) {
      if (row.app_id.startsWith('com.capdemo')) {
        continue
      }
      await db.query('DELETE FROM public.manifest WHERE app_version_id = $1', [row.id]).catch((error) => {
        console.error('Error deleting manifest rows:', { version_id: row.id, error })
        process.exit(1)
      })

      await db.query('UPDATE public.app_versions SET manifest_count = 0 WHERE id = $1', [row.id]).catch((error) => {
        console.error('Error updating manifest_count:', { version_id: row.id, error })
        process.exit(1)
      })

      const { rows: appRows } = await db.query('SELECT manifest_bundle_count FROM public.apps WHERE app_id = $1', [row.app_id]).catch((error) => {
        console.error('Error reading app manifest_bundle_count:', { app_id: row.app_id, error })
        process.exit(1)
      })
      if (appRows.length !== 1) {
        console.error('Error reading app manifest_bundle_count:', { app_id: row.app_id, error: `expected 1 app row, got ${appRows.length}` })
        process.exit(1)
      }

      const currentCount = appRows[0].manifest_bundle_count ?? 0
      const nextCount = Math.max(currentCount - 1, 0)

      await db.query('UPDATE public.apps SET manifest_bundle_count = $1 WHERE app_id = $2', [nextCount, row.app_id]).catch((error) => {
        console.error('Error updating app manifest_bundle_count:', { app_id: row.app_id, error })
        process.exit(1)
      })
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
process.exit(0)
