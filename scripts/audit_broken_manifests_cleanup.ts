/*
 * List versions where a manifest is broken but zip exists.
 * Broken manifests are derived ONLY from audit_storage exports.
 *
 * Criteria:
 * - version_id in missing_manifests.json
 * - version_id NOT in missing_versions.json (zip exists)
 * - manifest_count > 0
 *
 * Usage: bun scripts/audit_broken_manifests_cleanup.ts
 */
import { createClient } from './db-client.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

const ENV_FILE = './internal/cloudflare/.env.prod'
const OUTPUT_DIR = './tmp/unused_versions'
const MISSING_VERSIONS_IN = './tmp/r2_audit/missing_versions.json'
const MISSING_MANIFESTS_IN = './tmp/r2_audit/missing_manifests.json'
const CANDIDATES_OUT = `${OUTPUT_DIR}/broken_manifest_cleanup_candidates.json`
const SUMMARY_OUT = `${OUTPUT_DIR}/broken_manifest_cleanup_summary.json`

const PAGE_SIZE = 1000

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

async function loadJsonArray<T>(path: string): Promise<T[] | null> {
  try {
    const text = await Bun.file(path).text()
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

async function main() {
  const missingVersions = await loadJsonArray<{ id: number | string }>(MISSING_VERSIONS_IN)
  const missingManifests = await loadJsonArray<{ app_version_id: number | string }>(MISSING_MANIFESTS_IN)

  if (!missingVersions || !missingManifests) {
    console.log('Missing audit inputs. Run scripts/audit_storage.ts first.')
    return
  }

  const missingVersionIds = new Set<number>()
  for (const row of missingVersions) {
    const id = Number(row.id)
    if (!Number.isNaN(id)) missingVersionIds.add(id)
  }

  const missingManifestVersionIds = new Set<number>()
  for (const row of missingManifests) {
    const id = Number(row.app_version_id)
    if (!Number.isNaN(id)) missingManifestVersionIds.add(id)
  }

  const candidateIds = Array.from(missingManifestVersionIds).filter(id => !missingVersionIds.has(id))
  if (candidateIds.length === 0) {
    console.log('No candidate versions found (missing manifest but zip present).')
    return
  }

  const env = await loadEnv(ENV_FILE)
  const supabase = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL ?? env.DB_URL },
  )

  const candidates: Array<{
    id: number
    app_id: string
    owner_org: string
    name: string
    manifest_count: number
  }> = []

  const chunks = chunkArray(candidateIds, PAGE_SIZE)
  for (const chunk of chunks) {
    const { data, error } = await supabase
      .from('app_versions')
      .select('id, app_id, owner_org, name, manifest_count, deleted')
      .in('id', chunk)

    if (error) {
      console.error('Error fetching app_versions:', error)
      process.exit(1)
    }

    for (const row of data ?? []) {
      if (row.deleted) continue
      if (row.app_id.startsWith('com.capdemo')) continue
      const manifestCount = row.manifest_count ?? 0
      if (manifestCount > 0) {
        candidates.push({
          id: row.id,
          app_id: row.app_id,
          owner_org: row.owner_org,
          name: row.name,
          manifest_count: manifestCount,
        })
      }
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    counts: {
      candidates: candidates.length,
    },
  }

  await Bun.write(CANDIDATES_OUT, JSON.stringify(candidates, null, 2))
  await Bun.write(SUMMARY_OUT, JSON.stringify(summary, null, 2))

  console.log(`Candidates: ${candidates.length}`)
  console.log(`Outputs: ${CANDIDATES_OUT}, ${SUMMARY_OUT}`)
}

await main()
