/*
 * Find downgrade candidates for broken default channels using deploy_history.
 * Broken is computed from audit_storage exports only.
 *
 * Usage: bun scripts/audit_broken_default_downgrade.ts
 */
import { createClient } from './db-client.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

const ENV_FILE = './internal/cloudflare/.env.prod'
const OUTPUT_DIR = './tmp/unused_versions'
const INPUT_BROKEN_DEFAULT = `${OUTPUT_DIR}/broken_versions_default_channel.json`
const MISSING_VERSIONS_IN = './tmp/r2_audit/missing_versions.json'
const MISSING_MANIFESTS_IN = './tmp/r2_audit/missing_manifests.json'
const CANDIDATES_OUT = `${OUTPUT_DIR}/broken_default_downgrade_candidates.json`
const NO_CANDIDATE_OUT = `${OUTPUT_DIR}/broken_default_no_candidate.json`
const SUMMARY_OUT = `${OUTPUT_DIR}/broken_default_downgrade_summary.json`

const PAGE_SIZE = 1000

type BrokenDefaultRow = {
  id: number
  app_id: string
  owner_org: string
  name: string
  r2_path: string | null
  channel_id: number
  channel_name: string
}

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
  const env = await loadEnv(ENV_FILE)
  const supabase = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL },
  )

  const brokenDefault = await loadJsonArray<BrokenDefaultRow>(INPUT_BROKEN_DEFAULT)
  if (!brokenDefault || brokenDefault.length === 0) {
    console.log('No broken default channel versions found. Exiting.')
    return
  }

  const missingVersions = await loadJsonArray<{ id: number | string }>(MISSING_VERSIONS_IN) ?? []
  const missingManifests = await loadJsonArray<{ app_version_id: number | string }>(MISSING_MANIFESTS_IN) ?? []

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

  const versionCache = new Map<number, {
    id: number
    app_id: string
    name: string
    deleted: boolean
    manifest_count: number
  }>()

  async function fetchVersions(ids: number[]) {
    const unknown = ids.filter(id => !versionCache.has(id))
    if (unknown.length === 0) return
    const chunks = chunkArray(unknown, PAGE_SIZE)
    for (const chunk of chunks) {
      const { data, error } = await supabase
        .from('app_versions')
        .select('id, app_id, name, deleted, manifest_count')
        .in('id', chunk)
      if (error) {
        console.error('Error fetching app_versions:', error)
        process.exit(1)
      }
      for (const row of data ?? []) {
        versionCache.set(row.id, {
          id: row.id,
          app_id: row.app_id,
          name: row.name,
          deleted: row.deleted,
          manifest_count: row.manifest_count ?? 0,
        })
      }
    }
  }

  function isBroken(versionId: number, manifestCount: number) {
    if (!missingVersionIds.has(versionId)) return false
    if (manifestCount === 0) return true
    return missingManifestVersionIds.has(versionId)
  }

  const candidates: Array<{
    app_id: string
    owner_org: string
    channel_id: number
    channel_name: string
    broken_version_id: number
    broken_version_name: string
    candidate_version_id: number
    candidate_version_name: string
    candidate_deployed_at: string | null
  }> = []

  const noCandidate: Array<{
    app_id: string
    owner_org: string
    channel_id: number
    channel_name: string
    broken_version_id: number
    broken_version_name: string
    reason: string
  }> = []

  for (const row of brokenDefault) {
    let from = 0
    let found = false

    while (true) {
      const to = from + PAGE_SIZE - 1
      const { data, error } = await supabase
        .from('deploy_history')
        .select('version_id, deployed_at')
        .eq('channel_id', row.channel_id)
        .order('deployed_at', { ascending: false })
        .range(from, to)

      if (error) {
        console.error('Error fetching deploy_history:', error)
        process.exit(1)
      }
      if (!data || data.length === 0) break

      const versionIds = data.map(d => d.version_id)
      await fetchVersions(versionIds)

      for (const entry of data) {
        if (entry.version_id === row.id) continue
        const version = versionCache.get(entry.version_id)
        if (!version) continue
        if (version.deleted) continue
        if (isBroken(version.id, version.manifest_count)) continue

        candidates.push({
          app_id: row.app_id,
          owner_org: row.owner_org,
          channel_id: row.channel_id,
          channel_name: row.channel_name,
          broken_version_id: row.id,
          broken_version_name: row.name,
          candidate_version_id: version.id,
          candidate_version_name: version.name,
          candidate_deployed_at: entry.deployed_at ?? null,
        })
        found = true
        break
      }

      if (found) break
      from += PAGE_SIZE
      if (data.length < PAGE_SIZE) break
    }

    if (!found) {
      noCandidate.push({
        app_id: row.app_id,
        owner_org: row.owner_org,
        channel_id: row.channel_id,
        channel_name: row.channel_name,
        broken_version_id: row.id,
        broken_version_name: row.name,
        reason: 'no_valid_deploy_history_version',
      })
    }
  }

  const appsWithCandidates = new Set(candidates.map(c => c.app_id))
  const appsWithoutCandidates = new Set(noCandidate.map(c => c.app_id))

  const noCandidateOrgIds = Array.from(new Set(noCandidate.map(c => c.owner_org)))
  const orgChunks = chunkArray(noCandidateOrgIds, PAGE_SIZE)
  let paidNoCandidate = 0
  let totalNoCandidateOrgs = 0

  for (const chunk of orgChunks) {
    if (chunk.length === 0) continue
    const { data, error } = await supabase
      .from('orgs')
      .select('id, customer_id, stripe_info(status, trial_at)')
      .in('id', chunk)

    if (error) {
      console.error('Error fetching orgs for paid count:', error)
      process.exit(1)
    }
    for (const row of data ?? []) {
      totalNoCandidateOrgs += 1
      const stripeInfo = Array.isArray(row.stripe_info) ? row.stripe_info[0] : row.stripe_info
      const status = stripeInfo?.status
      const isPaid = status === 'succeeded'
      if (isPaid) paidNoCandidate += 1
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    counts: {
      brokenDefault: brokenDefault.length,
      candidates: candidates.length,
      noCandidate: noCandidate.length,
      appsWithCandidates: appsWithCandidates.size,
      appsWithoutCandidates: appsWithoutCandidates.size,
      noCandidateOrgs: totalNoCandidateOrgs,
      paidNoCandidateOrgs: paidNoCandidate,
    },
  }

  await Bun.write(CANDIDATES_OUT, JSON.stringify(candidates, null, 2))
  await Bun.write(NO_CANDIDATE_OUT, JSON.stringify(noCandidate, null, 2))
  await Bun.write(SUMMARY_OUT, JSON.stringify(summary, null, 2))

  console.log('Done.')
  console.log(`Candidates: ${candidates.length}`)
  console.log(`No candidate: ${noCandidate.length}`)
  console.log(`Paid orgs with no candidate: ${paidNoCandidate}/${totalNoCandidateOrgs}`)
  console.log(`Outputs:`)
  console.log(`  ${CANDIDATES_OUT}`)
  console.log(`  ${NO_CANDIDATE_OUT}`)
  console.log(`  ${SUMMARY_OUT}`)
}

await main()
