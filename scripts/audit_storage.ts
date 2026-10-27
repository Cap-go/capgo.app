/*
 * Audit storage consistency:
 * - Checks every app_versions.r2_path (non-deleted) exists in R2
 * - Checks every manifest.s3_path exists in R2
 * - Outputs missing versions + app IDs with issues
 *
 * Usage: bun scripts/audit_storage.ts
 */
import { HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { createClient } from './db-client.ts'
import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'

const ENV_FILE = './internal/cloudflare/.env.prod'
const OUTPUT_DIR = './tmp/r2_audit'
const VERSIONS_OUT = `${OUTPUT_DIR}/missing_versions.json`
const MANIFESTS_OUT = `${OUTPUT_DIR}/missing_manifests.json`
const APPS_OUT = `${OUTPUT_DIR}/apps_with_issues.json`
const SUMMARY_OUT = `${OUTPUT_DIR}/summary.json`
const STATE_OUT = `${OUTPUT_DIR}/state.json`

const PAGE_SIZE = 1000
const CONCURRENCY = 20000
const USE_LISTING = true
const R2_PREFIX = ''
const FILTER_PAID_TRIAL = true
const ORG_CHUNK = 2000
const VERSION_ID_CHUNK = 1000
const MANIFEST_COUNT_CHUNK = 1000

let versionsWithManifestEnabled = 0
let versionsWithMissingManifest = 0
let backupZipAvailable = 0
let missingVersionButManifestOk = 0
let missingVersionAndManifestMissing = 0
let brokenVersionCount = 0
let brokenAppCount = 0
let totalVersionsToCheck = 0
let totalManifestsToCheck = 0

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

function isMissingError(err: any) {
  const status = err?.$metadata?.httpStatusCode
  const name = err?.name
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey'
}

function normalizeKey(key: string) {
  if (!key) return key
  return key.startsWith('/') ? key.slice(1) : key
}

async function asyncPool<T, R>(limit: number, items: T[], iterator: (item: T) => Promise<R>) {
  const ret: R[] = []
  const executing: Promise<void>[] = []

  for (const item of items) {
    const p = iterator(item).then((result) => {
      ret.push(result)
    })

    let e: Promise<void>
    e = p.then(() => {
      const idx = executing.indexOf(e)
      if (idx >= 0) executing.splice(idx, 1)
    })
    executing.push(e)

    if (executing.length >= limit) {
      await Promise.race(executing)
    }
  }

  await Promise.all(executing)
  return ret
}

async function main() {
  const env = await loadEnv(ENV_FILE)
  const s3 = new S3Client({
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    endpoint: `https://${env.S3_ENDPOINT}`,
    region: env.S3_REGION || 'auto',
    forcePathStyle: true,
  })
  const bucket = env.S3_BUCKET || 'capgo'

  const supabase = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL ?? env.DB_URL },
  )

  await Bun.write(`${OUTPUT_DIR}/.gitkeep`, '')

  const state = await loadState()
  if (state) {
    console.log(`Resuming from state: ${STATE_OUT}`)
    if (state.phase === 'versions' && state.versions)
      console.log(`  versions: orgIndex=${state.versions.orgIndex}, offset=${state.versions.offset}`)
    if (state.phase === 'manifests' && state.manifests)
      console.log(`  manifests: chunkIndex=${state.manifests.chunkIndex}, offset=${state.manifests.offset}`)
  }

  console.log('=== Storage Audit ===')
  console.log(`Bucket: ${bucket}`)
  console.log(`Supabase: ${env.SUPABASE_URL}`)
  console.log(`Page size: ${PAGE_SIZE}, Concurrency: ${CONCURRENCY}`)
  console.log(`Use listing: ${USE_LISTING ? 'yes' : 'no'}`)
  console.log(`Filter paid/trial orgs: ${FILTER_PAID_TRIAL ? 'yes' : 'no'}`)
  if (R2_PREFIX) console.log(`R2 prefix: ${R2_PREFIX}`)

  let r2KeySet: Set<string> | null = null
  if (USE_LISTING) {
    console.log('\nListing R2 keys (this can take a while on very large buckets)...')
    r2KeySet = await listAllKeysParallel(s3, bucket, R2_PREFIX)
    console.log(`  Loaded ${r2KeySet.size} keys into memory`)
  }

  const versionMap = new Map<string, {
    app_id: string
    owner_org: string | null
    deleted: boolean
    r2_path: string | null
    manifest_count: number
  }>()

  let allowedOrgIds: string[] | null = null
  if (FILTER_PAID_TRIAL) {
    allowedOrgIds = await getPaidOrTrialOrgIds(supabase)
    console.log(`\nPaid/trial orgs found: ${allowedOrgIds.length}`)
    if (allowedOrgIds.length === 0) {
      console.log('No paid/trial orgs found. Exiting.')
      return
    }
  }

  console.log('\nLoading app_versions map (filtered)...')
  let totalVersionsLoaded = 0
  const orgChunks = allowedOrgIds ? chunkArray(allowedOrgIds, ORG_CHUNK) : [null]
  for (const orgChunk of orgChunks) {
    let from = 0
    while (true) {
      const to = from + PAGE_SIZE - 1
      let query = supabase
        .from('app_versions')
        .select('id, app_id, owner_org, deleted, r2_path, manifest_count')
        .range(from, to)

      if (orgChunk) query = query.in('owner_org', orgChunk)

      const { data, error } = await query
      if (error) {
        console.error('Error fetching app_versions:', error)
        process.exit(1)
      }
      if (!data || data.length === 0) break

      for (const row of data) {
        versionMap.set(row.id, {
          app_id: row.app_id,
          owner_org: row.owner_org,
          deleted: row.deleted,
          r2_path: row.r2_path,
          manifest_count: row.manifest_count ?? 0,
        })
      }

      totalVersionsLoaded += data.length
      from += PAGE_SIZE
      if (data.length < PAGE_SIZE) break
    }
  }
  console.log(`Loaded ${totalVersionsLoaded} app_versions into map`)

  const missingVersions: Array<{ id: string; app_id: string; owner_org: string | null; name: string; r2_path: string }> =
    (await loadJsonArray(VERSIONS_OUT)) ?? []
  const missingManifests: Array<{ id: string; app_version_id: string; app_id: string | null; owner_org: string | null; s3_path: string }> =
    (await loadJsonArray(MANIFESTS_OUT)) ?? []
  const appIdsWithIssues = new Set<string>(await loadJsonArray(APPS_OUT) ?? [])

  let currentState: AuditState = state ?? {
    phase: 'versions',
    versions: { orgIndex: 0, offset: 0 },
    manifests: { chunkIndex: 0, offset: 0 },
  }

  const handleExit = async (signal: string) => {
    console.log(`\nReceived ${signal}, saving progress...`)
    await saveState(currentState)
    await persistOutputs(missingVersions, missingManifests, appIdsWithIssues, bucket)
    process.exit(signal === 'SIGINT' ? 130 : 1)
  }
  process.on('SIGINT', () => { void handleExit('SIGINT') })
  process.on('SIGTERM', () => { void handleExit('SIGTERM') })

  console.log('\nCounting total versions/manifests to check...')
  for (const orgChunk of orgChunks) {
    let query = supabase
      .from('app_versions')
      .select('id', { count: 'exact', head: true })
      .eq('deleted', false)
      .not('r2_path', 'is', null)
    if (orgChunk) query = query.in('owner_org', orgChunk)
    const { count, error } = await query
    if (error) {
      console.error('Error counting app_versions:', error)
      process.exit(1)
    }
    totalVersionsToCheck += count ?? 0
  }

  const versionIds = Array.from(versionMap.keys())
  const versionIdChunks = chunkArray(versionIds, VERSION_ID_CHUNK)
  const manifestCountChunks = chunkArray(versionIds, MANIFEST_COUNT_CHUNK)
  totalManifestsToCheck = 0
  for (let i = 0; i < manifestCountChunks.length; i++) {
    const idChunk = manifestCountChunks[i]
    const { count, error } = await supabase
      .from('manifest')
      .select('id', { count: 'exact', head: true })
      .in('app_version_id', idChunk)
      .not('s3_path', 'is', null)
    if (error) {
      console.error(`Error counting manifest (chunk ${i + 1}/${manifestCountChunks.length}, size=${idChunk.length}):`, error)
      process.exit(1)
    }
    totalManifestsToCheck += count ?? 0
  }
  console.log(`Total versions to check: ${totalVersionsToCheck}`)
  console.log(`Total manifests to check: ${totalManifestsToCheck}`)

  console.log('\nChecking app_versions.r2_path...')
  let checkedVersions = 0
  for (let orgIndex = state?.versions?.orgIndex ?? 0; orgIndex < orgChunks.length; orgIndex++) {
    const orgChunk = orgChunks[orgIndex]
    const orgLabel = orgChunk ? `${orgIndex + 1}/${orgChunks.length}` : 'all'
    console.log(`\n[versions] Org chunk ${orgLabel} starting at offset ${orgIndex === (state?.versions?.orgIndex ?? 0) ? (state?.versions?.offset ?? 0) : 0}`)
    let from = orgIndex === (state?.versions?.orgIndex ?? 0) ? (state?.versions?.offset ?? 0) : 0
    while (true) {
      const to = from + PAGE_SIZE - 1
      let query = supabase
        .from('app_versions')
        .select('id, app_id, owner_org, name, r2_path, deleted')
        .eq('deleted', false)
        .not('r2_path', 'is', null)
        .range(from, to)

      if (orgChunk) query = query.in('owner_org', orgChunk)

      const { data, error } = await query
      if (error) {
        console.error('Error fetching app_versions for audit:', error)
        process.exit(1)
      }
      if (!data || data.length === 0) break

      await asyncPool(CONCURRENCY, data, async (row) => {
        const key = normalizeKey(row.r2_path as string)
        try {
          await assertExists(s3, bucket, key, r2KeySet)
        }
        catch (err) {
          if (isMissingError(err)) {
            missingVersions.push({
              id: row.id,
              app_id: row.app_id,
              owner_org: row.owner_org,
              name: row.name,
              r2_path: key,
            })
            appIdsWithIssues.add(row.app_id)
          }
          else {
            throw err
          }
        }
      })

      checkedVersions += data.length
      const vPercent = totalVersionsToCheck > 0 ? Math.min(100, Math.round((checkedVersions / totalVersionsToCheck) * 100)) : 100
      process.stdout.write(`\r  [versions] ${checkedVersions}/${totalVersionsToCheck} (${vPercent}%) missing=${missingVersions.length} orgChunk=${orgLabel} offset=${from}`)

      from += PAGE_SIZE
      currentState = {
        phase: 'versions',
        versions: { orgIndex, offset: from },
        manifests: state?.manifests ?? null,
      }
      await saveState(currentState)
      await persistOutputs(missingVersions, missingManifests, appIdsWithIssues, bucket)
      if (data.length < PAGE_SIZE) break
    }
  }
  process.stdout.write('\n')
  console.log('\n=== Versions Check Summary ===')
  console.log(`Total versions checked: ${checkedVersions}/${totalVersionsToCheck}`)
  console.log(`Missing versions: ${missingVersions.length}`)
  console.log(`Apps with issues so far: ${appIdsWithIssues.size}`)
  await persistOutputs(missingVersions, missingManifests, appIdsWithIssues, bucket)

  console.log('\nChecking manifest.s3_path...')
  let checkedManifests = 0
  for (let chunkIndex = state?.manifests?.chunkIndex ?? 0; chunkIndex < versionIdChunks.length; chunkIndex++) {
    const idChunk = versionIdChunks[chunkIndex]
    console.log(`\n[manifests] Chunk ${chunkIndex + 1}/${versionIdChunks.length} starting at offset ${chunkIndex === (state?.manifests?.chunkIndex ?? 0) ? (state?.manifests?.offset ?? 0) : 0}`)
    let from = chunkIndex === (state?.manifests?.chunkIndex ?? 0) ? (state?.manifests?.offset ?? 0) : 0
    while (true) {
      const to = from + PAGE_SIZE - 1
      const { data, error } = await supabase
        .from('manifest')
        .select('id, app_version_id, s3_path')
        .in('app_version_id', idChunk)
        .not('s3_path', 'is', null)
        .range(from, to)

      if (error) {
        console.error('Error fetching manifest for audit:', error)
        process.exit(1)
      }
      if (!data || data.length === 0) break

      await asyncPool(CONCURRENCY, data, async (row) => {
        const key = normalizeKey(row.s3_path as string)
        const versionInfo = versionMap.get(row.app_version_id)
        try {
          await assertExists(s3, bucket, key, r2KeySet)
        }
        catch (err) {
          if (isMissingError(err)) {
            missingManifests.push({
              id: row.id,
              app_version_id: row.app_version_id,
              app_id: versionInfo?.app_id ?? null,
              owner_org: versionInfo?.owner_org ?? null,
              s3_path: key,
            })
            if (versionInfo?.app_id) appIdsWithIssues.add(versionInfo.app_id)
          }
          else {
            throw err
          }
        }
      })

      checkedManifests += data.length
      const mPercent = totalManifestsToCheck > 0 ? Math.min(100, Math.round((checkedManifests / totalManifestsToCheck) * 100)) : 100
      process.stdout.write(`\r  [manifests] ${checkedManifests}/${totalManifestsToCheck} (${mPercent}%) missing=${missingManifests.length} chunk=${chunkIndex + 1}/${versionIdChunks.length} offset=${from}`)

      from += PAGE_SIZE
      currentState = {
        phase: 'manifests',
        versions: { orgIndex: orgChunks.length, offset: 0 },
        manifests: { chunkIndex, offset: from },
      }
      await saveState(currentState)
      await persistOutputs(missingVersions, missingManifests, appIdsWithIssues, bucket)
      if (data.length < PAGE_SIZE) break
    }
  }
  process.stdout.write('\n')
  console.log('\n=== Manifests Check Summary ===')
  console.log(`Total manifests checked: ${checkedManifests}/${totalManifestsToCheck}`)
  console.log(`Missing manifests: ${missingManifests.length}`)
  console.log(`Apps with issues so far: ${appIdsWithIssues.size}`)
  await persistOutputs(missingVersions, missingManifests, appIdsWithIssues, bucket)

  // Extra manifest/backup stats
  versionsWithManifestEnabled = Array.from(versionMap.values()).filter(v => (v.manifest_count ?? 0) > 0).length
  const missingManifestVersionIds = new Set(missingManifests.map(m => m.app_version_id))
  versionsWithMissingManifest = missingManifestVersionIds.size

  const missingManifestVersions = Array.from(missingManifestVersionIds)
  await asyncPool(CONCURRENCY, missingManifestVersions, async (versionId) => {
    const info = versionMap.get(versionId)
    if (!info?.r2_path) return
    const key = normalizeKey(info.r2_path)
    try {
      await assertExists(s3, bucket, key, r2KeySet)
      backupZipAvailable += 1
    }
    catch {
      // ignore missing backup zips
    }
  })

  console.log('\n=== Manifest Integrity / Backup Stats ===')
  console.log(`Versions with manifest enabled: ${versionsWithManifestEnabled}`)
  console.log(`Versions with missing manifest entries: ${versionsWithMissingManifest}`)
  console.log(`Missing manifest rows (safe to delete from DB): ${missingManifests.length}`)
  console.log(`Versions with missing manifest but zip still present: ${backupZipAvailable}`)

  const missingVersionIds = new Set(missingVersions.map(v => v.id))
  for (const versionId of missingVersionIds) {
    const info = versionMap.get(versionId)
    const hasManifestEnabled = (info?.manifest_count ?? 0) > 0
    const hasMissingManifest = missingManifestVersionIds.has(versionId)
    if (hasManifestEnabled && !hasMissingManifest) {
      missingVersionButManifestOk += 1
    }
    else if (hasMissingManifest) {
      missingVersionAndManifestMissing += 1
    }
  }
  console.log('\n=== Missing Version Breakdown ===')
  console.log(`Missing version zip but manifest OK: ${missingVersionButManifestOk}`)
  console.log(`Missing version zip and manifest missing: ${missingVersionAndManifestMissing}`)

  const brokenVersionIds = new Set<string>()
  for (const versionId of missingVersionIds) {
    const info = versionMap.get(versionId)
    const hasManifestEnabled = (info?.manifest_count ?? 0) > 0
    const hasMissingManifest = missingManifestVersionIds.has(versionId)
    if (!hasManifestEnabled || hasMissingManifest) {
      brokenVersionIds.add(versionId)
    }
  }
  const brokenAppIds = new Set<string>()
  for (const versionId of brokenVersionIds) {
    const info = versionMap.get(versionId)
    if (info?.app_id) brokenAppIds.add(info.app_id)
  }
  brokenVersionCount = brokenVersionIds.size
  brokenAppCount = brokenAppIds.size
  console.log('\n=== Totally Broken Versions ===')
  console.log(`Totally broken versions (no usable zip or manifest): ${brokenVersionCount}`)
  console.log(`Apps with totally broken versions: ${brokenAppCount}`)

  const appsList = Array.from(appIdsWithIssues).sort()

  const summary = {
    generatedAt: new Date().toISOString(),
    bucket,
    counts: {
      missingVersions: missingVersions.length,
      missingManifests: missingManifests.length,
      appsWithIssues: appsList.length,
    },
  }

  await persistOutputs(missingVersions, missingManifests, appIdsWithIssues, bucket)
  await Bun.write(SUMMARY_OUT, JSON.stringify(summary, null, 2))
  await Bun.write(STATE_OUT, JSON.stringify({ phase: 'done' }, null, 2))

  console.log('\n=== Done ===')
  console.log(`Missing versions: ${missingVersions.length}`)
  console.log(`Missing manifests: ${missingManifests.length}`)
  console.log(`Apps with issues: ${appsList.length}`)
  console.log(`Outputs:`)
  console.log(`  ${VERSIONS_OUT}`)
  console.log(`  ${MANIFESTS_OUT}`)
  console.log(`  ${APPS_OUT}`)
  console.log(`  ${SUMMARY_OUT}`)
}

async function listAllKeys(s3: S3Client, bucket: string, prefix: string) {
  let continuationToken: string | undefined
  const keys = new Set<string>()
  let pages = 0
  const startedAt = Date.now()
  const label = prefix || 'all'

  while (true) {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    }))
    pages += 1

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key) keys.add(obj.Key)
      }
    }

    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    const rate = Math.round(keys.size / seconds)
    process.stdout.write(`\r  [listing] prefix=${label} pages=${pages} keys=${keys.size} rate=${rate}/s elapsed=${seconds}s`)

    if (!response.IsTruncated) break
    continuationToken = response.NextContinuationToken
  }

  if (pages >= 1) process.stdout.write('\n')
  return keys
}

async function listAllKeysParallel(s3: S3Client, bucket: string, prefix: string) {
  // If we can filter to paid/trial orgs, parallelize listing per org prefix.
  const envFile = await Bun.file(ENV_FILE).text()
  const env: Record<string, string> = {}
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex > 0) env[trimmed.substring(0, eqIndex)] = trimmed.substring(eqIndex + 1)
    }
  }
  const supabase = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL ?? env.DB_URL },
  )

  if (!FILTER_PAID_TRIAL || prefix) {
    return listAllKeys(s3, bucket, prefix)
  }

  const orgIds = await getPaidOrTrialOrgIds(supabase)
  const prefixes = orgIds.map(id => `orgs/${id}/`)
  const allKeys = new Set<string>()

  let done = 0
  const startedAt = Date.now()

  await asyncPool(CONCURRENCY, prefixes, async (pfx) => {
    const keys = await listAllKeys(s3, bucket, pfx)
    for (const k of keys) allKeys.add(k)
    done += 1
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    const rate = Math.round(done / seconds)
    process.stdout.write(`\r  [listing-parallel] orgs=${done}/${prefixes.length} rate=${rate}/s keys=${allKeys.size}`)
  })

  process.stdout.write('\n')
  return allKeys
}

async function assertExists(s3: S3Client, bucket: string, key: string, keySet: Set<string> | null) {
  if (keySet) {
    if (!keySet.has(key)) throw { name: 'NotFound', $metadata: { httpStatusCode: 404 } }
    return
  }
  await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
}

async function getPaidOrTrialOrgIds(supabase: ReturnType<typeof createClient<Database>>) {
  const paidOrTrial: string[] = []
  let from = 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await supabase
      .from('orgs')
      .select('id, customer_id, stripe_info(status, trial_at)')
      .not('customer_id', 'is', null)
      .range(from, to)

    if (error) {
      console.error('Error fetching orgs for paid/trial filter:', error)
      process.exit(1)
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      const stripeInfo = Array.isArray(row.stripe_info) ? row.stripe_info[0] : row.stripe_info
      const status = stripeInfo?.status
      const trialAt = stripeInfo?.trial_at ? new Date(stripeInfo.trial_at) : null
      const isPaid = status === 'succeeded'
      const isTrial = status !== 'succeeded' && trialAt !== null && trialAt >= today
      if (isPaid || isTrial) paidOrTrial.push(row.id)
    }

    from += PAGE_SIZE
    if (data.length < PAGE_SIZE) break
  }

  return paidOrTrial
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

async function persistOutputs(
  missingVersions: Array<{ id: string; app_id: string; owner_org: string | null; name: string; r2_path: string }>,
  missingManifests: Array<{ id: string; app_version_id: string; app_id: string | null; owner_org: string | null; s3_path: string }>,
  appIdsWithIssues: Set<string>,
  bucket: string,
) {
  await Bun.write(VERSIONS_OUT, JSON.stringify(missingVersions, null, 2))
  await Bun.write(MANIFESTS_OUT, JSON.stringify(missingManifests, null, 2))
  await Bun.write(APPS_OUT, JSON.stringify(Array.from(appIdsWithIssues).sort(), null, 2))
  const summary = {
    generatedAt: new Date().toISOString(),
    bucket,
    counts: {
      missingVersions: missingVersions.length,
      missingManifests: missingManifests.length,
      appsWithIssues: appIdsWithIssues.size,
      versionsToCheck: totalVersionsToCheck,
      manifestsToCheck: totalManifestsToCheck,
      versionsWithManifestEnabled,
      versionsWithMissingManifest,
      missingManifestRows: missingManifests.length,
      versionsWithMissingManifestButZipPresent: backupZipAvailable,
      missingVersionButManifestOk,
      missingVersionAndManifestMissing,
      totallyBrokenVersions: brokenVersionCount,
      appsWithTotallyBrokenVersions: brokenAppCount,
    },
  }
  await Bun.write(SUMMARY_OUT, JSON.stringify(summary, null, 2))
}

type AuditState = {
  phase: 'versions' | 'manifests' | 'done'
  versions: { orgIndex: number; offset: number } | null
  manifests: { chunkIndex: number; offset: number } | null
}

async function loadState(): Promise<AuditState | null> {
  try {
    const text = await Bun.file(STATE_OUT).text()
    return JSON.parse(text)
  }
  catch {
    return null
  }
}

async function saveState(state: AuditState) {
  await Bun.write(STATE_OUT, JSON.stringify(state, null, 2))
}

await main()
