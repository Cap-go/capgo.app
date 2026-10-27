/*
 * Audit broken app_versions using export files only:
 * - Broken = missing zip AND missing manifest (from audit_storage exports)
 * - List broken versions connected to default channel
 * - List broken versions not referenced by any channel
 *
 * Usage: bun scripts/audit_unused_versions.ts
 */
import { createClient } from './db-client.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

const ENV_FILE = './internal/cloudflare/.env.prod'
const OUTPUT_DIR = './tmp/unused_versions'
const BROKEN_DEFAULT_OUT = `${OUTPUT_DIR}/broken_versions_default_channel.json`
const BROKEN_UNREFERENCED_OUT = `${OUTPUT_DIR}/broken_versions_unreferenced.json`
const SUMMARY_OUT = `${OUTPUT_DIR}/summary.json`
const MISSING_VERSIONS_IN = './tmp/r2_audit/missing_versions.json'
const MISSING_MANIFESTS_IN = './tmp/r2_audit/missing_manifests.json'

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

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
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

async function main() {
  const env = await loadEnv(ENV_FILE)
  const supabase = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL ?? env.DB_URL },
  )

  await Bun.write(`${OUTPUT_DIR}/.gitkeep`, '')

  const missingVersions = await loadJsonArray<{ id: number | string; app_id?: string; owner_org?: string; name?: string; r2_path?: string | null }>(MISSING_VERSIONS_IN)
  const missingManifests = await loadJsonArray<{ app_version_id: number | string }>(MISSING_MANIFESTS_IN)

  const missingVersionIds = new Set<number>()
  if (missingVersions) {
    for (const row of missingVersions) {
      const id = Number(row.id)
      if (!Number.isNaN(id)) missingVersionIds.add(id)
    }
  }

  const missingManifestVersionIds = new Set<number>()
  if (missingManifests) {
    for (const row of missingManifests) {
      const id = Number(row.app_version_id)
      if (!Number.isNaN(id)) missingManifestVersionIds.add(id)
    }
  }

  if (!missingVersions || !missingManifests) {
    console.log('\nWarning: missing audit inputs. Run scripts/audit_storage.ts first if you need broken-only filtering.')
  }

  // Process only broken versions derived from audit_storage exports.
  const brokenVersionIdList = Array.from(missingVersionIds)
  const versionMap = new Map<number, { app_id: string; owner_org: string; name: string; deleted: boolean; r2_path: string | null; manifest_count: number }>()
  let totalVersionsLoaded = 0
  const versionIdChunks = chunkArray(brokenVersionIdList, PAGE_SIZE)
  for (const idChunk of versionIdChunks) {
    const { data, error } = await supabase
      .from('app_versions')
      .select('id, app_id, owner_org, name, deleted, r2_path, manifest_count')
      .in('id', idChunk)

    if (error) {
      console.error('Error fetching broken app_versions:', error)
      process.exit(1)
    }
    if (!data || data.length === 0) continue

    for (const row of data) {
      versionMap.set(row.id, {
        app_id: row.app_id,
        owner_org: row.owner_org,
        name: row.name,
        deleted: row.deleted,
        r2_path: row.r2_path ?? null,
        manifest_count: row.manifest_count ?? 0,
      })
    }
    totalVersionsLoaded += data.length
  }

  const brokenAppIds = Array.from(new Set(Array.from(versionMap.values()).map(v => v.app_id)))

  const appMap = new Map<string, { owner_org: string; default_upload_channel: string }>()
  const appIdChunks = chunkArray(brokenAppIds, PAGE_SIZE)
  for (const appChunk of appIdChunks) {
    const { data, error } = await supabase
      .from('apps')
      .select('app_id, owner_org, default_upload_channel')
      .in('app_id', appChunk)

    if (error) {
      console.error('Error fetching apps:', error)
      process.exit(1)
    }
    if (!data || data.length === 0) continue

    for (const row of data) {
      appMap.set(row.app_id, {
        owner_org: row.owner_org,
        default_upload_channel: row.default_upload_channel,
      })
    }
  }

  const channelVersions = new Set<number>()
  const channelsByApp = new Map<string, Array<{ id: number; name: string; version: number; owner_org: string }>>()
  for (const appChunk of appIdChunks) {
    let from = 0
    while (true) {
      const to = from + PAGE_SIZE - 1
      const { data, error } = await supabase
        .from('channels')
        .select('id, app_id, owner_org, name, version')
        .in('app_id', appChunk)
        .range(from, to)

      if (error) {
        console.error('Error fetching channels:', error)
        process.exit(1)
      }
      if (!data || data.length === 0) break

      for (const row of data) {
        channelVersions.add(row.version)
        const list = channelsByApp.get(row.app_id) ?? []
        list.push({ id: row.id, name: row.name, version: row.version, owner_org: row.owner_org })
        channelsByApp.set(row.app_id, list)
      }

      from += PAGE_SIZE
      if (data.length < PAGE_SIZE) break
    }
  }

  const brokenDefaultChannelVersions: Array<{
    id: number
    app_id: string
    owner_org: string
    name: string
    r2_path: string | null
    channel_id: number
    channel_name: string
  }> = []

  const brokenUnreferencedVersions: Array<{ id: number; app_id: string; owner_org: string; name: string; r2_path: string | null }> = []

  for (const [id, version] of versionMap.entries()) {
    if (version.deleted) continue
    const hasManifest = version.manifest_count > 0
    const manifestMissing = missingManifestVersionIds.has(id)
    const isBroken = hasManifest ? manifestMissing : true
    if (!isBroken) continue
    const channels = channelsByApp.get(version.app_id) ?? []
    const defaultChannelName = appMap.get(version.app_id)?.default_upload_channel
    const defaultChannel = defaultChannelName
      ? channels.find(c => c.name === defaultChannelName)
      : null

    if (defaultChannel && defaultChannel.version === id) {
      brokenDefaultChannelVersions.push({
        id,
        app_id: version.app_id,
        owner_org: version.owner_org,
        name: version.name,
        r2_path: version.r2_path,
        channel_id: defaultChannel.id,
        channel_name: defaultChannel.name,
      })
      continue
    }

    if (!channelVersions.has(id)) {
      brokenUnreferencedVersions.push({
        id,
        app_id: version.app_id,
        owner_org: version.owner_org,
        name: version.name,
        r2_path: version.r2_path,
      })
    }
  }

  const appsWithBroken = new Set<string>()
  for (const row of brokenDefaultChannelVersions) appsWithBroken.add(row.app_id)
  for (const row of brokenUnreferencedVersions) appsWithBroken.add(row.app_id)

  const summary = {
    generatedAt: new Date().toISOString(),
    counts: {
      apps: appMap.size,
      channels: Array.from(channelsByApp.values()).reduce((acc, list) => acc + list.length, 0),
      versions: totalVersionsLoaded,
      brokenDefaultChannelVersions: brokenDefaultChannelVersions.length,
      brokenUnreferencedVersions: brokenUnreferencedVersions.length,
      appsWithBrokenVersions: appsWithBroken.size,
    },
  }

  await Bun.write(BROKEN_DEFAULT_OUT, JSON.stringify(brokenDefaultChannelVersions, null, 2))
  await Bun.write(BROKEN_UNREFERENCED_OUT, JSON.stringify(brokenUnreferencedVersions, null, 2))
  await Bun.write(SUMMARY_OUT, JSON.stringify(summary, null, 2))

  console.log('\n=== Done ===')
  console.log(`Broken versions on default channel: ${brokenDefaultChannelVersions.length}`)
  console.log(`Broken versions unreferenced by any channel: ${brokenUnreferencedVersions.length}`)
  console.log(`Apps with broken versions in lists: ${appsWithBroken.size}`)
  console.log('Outputs:')
  console.log(`  ${BROKEN_DEFAULT_OUT}`)
  console.log(`  ${BROKEN_UNREFERENCED_OUT}`)
  console.log(`  ${SUMMARY_OUT}`)
}

await main()
