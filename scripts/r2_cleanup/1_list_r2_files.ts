/**
 * Script 1: Efficiently find orphaned R2 folders/files using hierarchical listing
 *
 * Instead of listing all 4.8M files, we use S3 delimiter to list only folder names
 * at each level, then compare against the database.
 *
 * Hierarchy: orgs/{owner_org}/apps/{app_id}/{version}.zip (or version folder for manifests)
 *
 * Usage: bun scripts/r2_cleanup/1_list_r2_files.ts
 */

import type { Database } from '../../supabase/functions/_backend/utils/supabase.types.ts'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { createClient } from '../db-client.ts'

// Load environment from prod file
const envFile = await Bun.file('./internal/cloudflare/.env.prod').text()
const env: Record<string, string> = {}
for (const line of envFile.split('\n')) {
  const trimmed = line.trim()
  if (trimmed && !trimmed.startsWith('#')) {
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex)
      const value = trimmed.substring(eqIndex + 1)
      env[key] = value
    }
  }
}

const S3_BUCKET = env.S3_BUCKET || 'capgo'
const OUTPUT_FILE = './tmp/r2_cleanup/1_orphaned_paths.json'

const s3 = new S3Client({
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
  endpoint: `https://${env.S3_ENDPOINT}`,
  region: env.S3_REGION || 'auto',
  forcePathStyle: true,
})

const supabase = createClient<Database>(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }, databaseUrl: env.SUPABASE_DB_URL },
)

const PAGE_SIZE = 1000

async function fetchAll<T>(
  buildQuery: () => ReturnType<typeof supabase.from>,
  context: string,
): Promise<T[]> {
  const all: T[] = []
  let from = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error(`Error fetching ${context}:`, error)
      process.exit(1)
    }
    if (data && data.length > 0)
      all.push(...data as T[])
    if (!data || data.length < PAGE_SIZE)
      break
    from += PAGE_SIZE
  }

  return all
}

// List only folder names at a prefix level (not files inside)
async function listFolders(prefix: string): Promise<string[]> {
  const folders: string[] = []
  let continuationToken: string | undefined

  while (true) {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: continuationToken,
    }))

    if (response.CommonPrefixes) {
      for (const cp of response.CommonPrefixes) {
        if (cp.Prefix)
          folders.push(cp.Prefix)
      }
    }

    if (!response.IsTruncated)
      break
    continuationToken = response.NextContinuationToken
  }

  return folders
}

// List files AND folders at a prefix level (versions can be .zip or folder)
async function listVersions(prefix: string): Promise<{ files: string[], folders: string[] }> {
  const files: string[] = []
  const folders: string[] = []
  let continuationToken: string | undefined

  while (true) {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: continuationToken,
    }))

    // Files (zips)
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && obj.Key.endsWith('.zip'))
          files.push(obj.Key)
      }
    }

    // Folders (manifests)
    if (response.CommonPrefixes) {
      for (const cp of response.CommonPrefixes) {
        if (cp.Prefix)
          folders.push(cp.Prefix)
      }
    }

    if (!response.IsTruncated)
      break
    continuationToken = response.NextContinuationToken
  }

  return { files, folders }
}

async function main() {
  console.log('=== Hierarchical R2 Orphan Detection ===\n')
  console.log(`Bucket: ${S3_BUCKET}`)
  console.log(`Supabase: ${env.SUPABASE_URL}\n`)

  // Ensure output directory exists
  await Bun.write('./tmp/r2_cleanup/.gitkeep', '')

  const orphanedPaths: { path: string, type: 'org' | 'app' | 'version', reason: string }[] = []

  // ===== STEP 1: Get all org folders from R2 =====
  console.log('Step 1: Listing org folders from R2...')
  const r2OrgFolders = await listFolders('orgs/')
  const r2OrgIds = r2OrgFolders.map(f => f.replace('orgs/', '').replace('/', ''))
  console.log(`  Found ${r2OrgIds.length} org folders in R2`)

  // ===== STEP 2: Get all active orgs from database =====
  console.log('\nStep 2: Querying active orgs from database...')
  const dbOrgs = await fetchAll<{ owner_org: string }>(() => supabase
    .from('app_versions')
    .select('owner_org')
    .eq('deleted', false)
    .or('r2_path.not.is.null,manifest_count.gt.0'), 'orgs')

  const activeOrgIds = new Set(dbOrgs?.map(r => r.owner_org) ?? [])
  console.log(`  Found ${activeOrgIds.size} orgs with active versions in DB`)

  // ===== STEP 3: Find orphaned orgs (whole folders to delete) =====
  console.log('\nStep 3: Finding orphaned org folders...')
  const orphanedOrgIds: string[] = []
  for (const orgId of r2OrgIds) {
    if (!activeOrgIds.has(orgId)) {
      orphanedOrgIds.push(orgId)
      orphanedPaths.push({
        path: `orgs/${orgId}/`,
        type: 'org',
        reason: 'org_not_in_db',
      })
    }
  }
  console.log(`  Found ${orphanedOrgIds.length} orphaned org folders`)

  // ===== STEP 4: For active orgs, check app folders (parallel) =====
  const activeOrgIdsInR2 = r2OrgIds.filter(id => activeOrgIds.has(id))
  console.log(`\nStep 4: Checking ${activeOrgIdsInR2.length} active orgs for orphaned apps (parallel)...`)

  const CONCURRENCY = 10 // Process 10 orgs at a time
  let checkedOrgs = 0

  async function processOrg(orgId: string) {
    // List app folders under this org
    const appFolders = await listFolders(`orgs/${orgId}/apps/`)
    const r2AppIds = appFolders.map((f) => {
      const parts = f.split('/')
      return parts[parts.length - 2]
    })

    if (r2AppIds.length === 0) {
      checkedOrgs++
      return []
    }

    // Query DB for active apps in this org
    const dbApps = await fetchAll<{ app_id: string }>(() => supabase
      .from('app_versions')
      .select('app_id')
      .eq('owner_org', orgId)
      .eq('deleted', false)
      .or('r2_path.not.is.null,manifest_count.gt.0'), `apps for org ${orgId}`)

    const activeAppIds = new Set(dbApps?.map(r => r.app_id) ?? [])
    const results: typeof orphanedPaths = []

    // Find orphaned apps
    for (const appId of r2AppIds) {
      if (!activeAppIds.has(appId)) {
        results.push({
          path: `orgs/${orgId}/apps/${appId}/`,
          type: 'app',
          reason: 'app_not_in_db',
        })
      }
    }

    // For active apps, check version files/folders
    const activeAppIdsInR2 = r2AppIds.filter(id => activeAppIds.has(id))
    for (const appId of activeAppIdsInR2) {
      const { files, folders } = await listVersions(`orgs/${orgId}/apps/${appId}/`)

      if (files.length === 0 && folders.length === 0)
        continue

      const dbVersions = await fetchAll<{ id: number, r2_path: string | null, manifest_count: number }>(() => supabase
        .from('app_versions')
        .select('id, r2_path, manifest_count')
        .eq('app_id', appId)
        .eq('owner_org', orgId)
        .eq('deleted', false), `versions for app ${appId} (${orgId})`)

      const activeR2Paths = new Set(dbVersions?.map(r => r.r2_path).filter(Boolean) ?? [])
      const manifestVersionIds = dbVersions
        ?.filter(v => (v.manifest_count ?? 0) > 0)
        .map(v => v.id) ?? []

      const activeManifestPaths = new Set<string>()
      if (manifestVersionIds.length > 0) {
        const CHUNK_SIZE = 500
        for (let i = 0; i < manifestVersionIds.length; i += CHUNK_SIZE) {
          const chunk = manifestVersionIds.slice(i, i + CHUNK_SIZE)
          const manifestEntries = await fetchAll<{ s3_path: string }>(() => supabase
            .from('manifest')
            .select('s3_path')
            .in('app_version_id', chunk), `manifest entries for app ${appId} (${orgId})`)

          for (const entry of manifestEntries ?? []) {
            if (entry.s3_path)
              activeManifestPaths.add(entry.s3_path)
          }
        }
      }

      for (const filePath of files) {
        if (!activeR2Paths.has(filePath)) {
          results.push({
            path: filePath,
            type: 'version',
            reason: 'version_zip_not_in_db',
          })
        }
      }

      for (const folderPath of folders) {
        const folderPathNormalized = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath
        let isActive = false
        const isDeltaFolder = folderPath.endsWith('/delta/')
        if (!isDeltaFolder) {
          for (const activePath of activeR2Paths) {
            if (activePath && (activePath === folderPathNormalized || activePath.startsWith(folderPath))) {
              isActive = true
              break
            }
          }
          if (!isActive) {
            const zipPath = `${folderPathNormalized}.zip`
            if (activeR2Paths.has(zipPath))
              isActive = true
          }
        }
        if (!isActive) {
          for (const manifestPath of activeManifestPaths) {
            if (manifestPath.startsWith(folderPath)) {
              isActive = true
              break
            }
          }
        }
        if (!isActive) {
          results.push({
            path: folderPath,
            type: 'version',
            reason: 'version_folder_not_in_db',
          })
        }
      }
    }

    checkedOrgs++
    process.stdout.write(`\r  Progress: ${checkedOrgs}/${activeOrgIdsInR2.length} orgs | ${orphanedPaths.length} orphans found`)
    return results
  }

  // Process in batches of CONCURRENCY
  for (let i = 0; i < activeOrgIdsInR2.length; i += CONCURRENCY) {
    const batch = activeOrgIdsInR2.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(processOrg))
    for (const r of results) {
      orphanedPaths.push(...r)
    }
  }

  // ===== STEP 6: Check legacy 'apps/' prefix if exists =====
  console.log('\n\nStep 5: Checking legacy apps/ prefix...')
  const legacyAppFolders = await listFolders('apps/')
  if (legacyAppFolders.length > 0) {
    console.log(`  Found ${legacyAppFolders.length} folders under legacy apps/ prefix`)
    for (const folder of legacyAppFolders) {
      orphanedPaths.push({
        path: folder,
        type: 'app',
        reason: 'legacy_apps_prefix',
      })
    }
  }
  else {
    console.log('  No legacy apps/ folders found')
  }

  // ===== Summary =====
  console.log('\n\n=== Summary ===')
  const orgCount = orphanedPaths.filter(p => p.type === 'org').length
  const appCount = orphanedPaths.filter(p => p.type === 'app').length
  const versionCount = orphanedPaths.filter(p => p.type === 'version').length

  console.log(`Orphaned org folders: ${orgCount}`)
  console.log(`Orphaned app folders: ${appCount}`)
  console.log(`Orphaned version files/folders: ${versionCount}`)
  console.log(`Total orphaned paths: ${orphanedPaths.length}`)

  // Save output
  const output = {
    generatedAt: new Date().toISOString(),
    bucket: S3_BUCKET,
    summary: {
      totalR2Orgs: r2OrgIds.length,
      activeOrgsInDb: activeOrgIds.size,
      orphanedOrgs: orgCount,
      orphanedApps: appCount,
      orphanedVersions: versionCount,
      totalOrphanedPaths: orphanedPaths.length,
    },
    orphanedPaths,
  }

  await Bun.write(OUTPUT_FILE, JSON.stringify(output, null, 2))
  console.log(`\nSaved to ${OUTPUT_FILE}`)
}

await main()
