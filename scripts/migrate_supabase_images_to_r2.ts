/*
 * Move every object of the Supabase Storage `images` bucket (avatars, org logos,
 * app icons) into R2 under `images/<same path>`, deleting each Supabase copy
 * once it is in R2. Run once when the backend switches image storage to R2;
 * re-running only moves what is still left in Supabase. A Supabase copy that is
 * newer than R2 replaces it; an older one is removed without being copied.
 *
 * The backend no longer deletes from the Supabase bucket, so copies left there
 * would outlive account, org and app deletion: only keep them (--keep-source)
 * for a trial run, then run again without it.
 *
 * Dry run:
 *   bun run admin:migrate-supabase-images-to-r2
 *
 * Apply:
 *   bun run admin:migrate-supabase-images-to-r2 --apply
 *
 * Optional:
 *   --prefix=org/<uuid>     only copy one folder
 *   --concurrency=32
 *   --overwrite             replace objects that already exist in R2
 *   --keep-source           copy only; leave the Supabase objects in place
 *   --env-file=./internal/cloudflare/.env.preprod
 *
 * Objects are listed from `storage.objects` in one query when a Postgres URL is
 * set (MAIN_SUPABASE_DB_URL, DATABASE_URL, SUPABASE_DB_URL or
 * SUPABASE_DB_DIRECT_URL). Without one, folders are listed through the Storage
 * API in parallel, which takes one request per folder.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { Client } from 'pg'
import { createImageStore } from './admin_image_storage.ts'
import { asyncPool, createSupabaseServiceClient, DEFAULT_ENV_FILE, getArgValue, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const BUCKET = 'images'
const PAGE_SIZE = 1000
const MAX_FOLDER_DEPTH = 6
const DEFAULT_CONCURRENCY = 32
// Supabase Storage accepts up to 1000 paths per remove call.
const REMOVE_BATCH_SIZE = 500
const LIST_CONCURRENCY = 16
const PROGRESS_INTERVAL_MS = 5000
const DB_URL_ENV_KEYS = ['MAIN_SUPABASE_DB_URL', 'DATABASE_URL', 'SUPABASE_DB_URL', 'SUPABASE_DB_DIRECT_URL']
const FAILURE_OUTPUT = './tmp/supabase_images_to_r2_failures.json'

type SupabaseClient = ReturnType<typeof createSupabaseServiceClient>

interface LegacyObject {
  path: string
  /** Epoch ms of the last Supabase write, NaN when Storage did not report it. */
  updatedAt: number
}

// Supabase's pooler presents a certificate signed by Supabase's own CA, so a
// remote connection is encrypted without CA verification, like the other admin
// scripts. `sslmode` is dropped from the URL because pg lets it override `ssl`.
function databaseClient(databaseUrl: string) {
  const url = new URL(databaseUrl)
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  url.searchParams.delete('sslmode')
  return new Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false } })
}

async function listFromDatabase(databaseUrl: string, prefix: string): Promise<LegacyObject[]> {
  const pg = databaseClient(databaseUrl)
  await pg.connect()
  try {
    const { rows } = await pg.query<{ name: string, updated_at: Date | null, created_at: Date | null }>(
      `SELECT name, updated_at, created_at
       FROM storage.objects
       WHERE bucket_id = $1
         AND ($2 = '' OR starts_with(name, $2 || '/'))
         AND name NOT LIKE '%/.emptyFolderPlaceholder'
       ORDER BY name`,
      [BUCKET, prefix],
    )
    return rows.map(row => ({ path: row.name, updatedAt: (row.updated_at ?? row.created_at)?.getTime() ?? Number.NaN }))
  }
  finally {
    await pg.end()
  }
}

async function listFolderPage(supabase: SupabaseClient, folder: string) {
  const entries: { name: string, id: string | null, updated_at?: string, created_at?: string }[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase.storage.from(BUCKET).list(folder, { limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error)
      throw error
    entries.push(...(data ?? []))
    if ((data ?? []).length < PAGE_SIZE)
      return entries
  }
}

// One Storage API request per folder, LIST_CONCURRENCY folders at a time.
async function listThroughStorageApi(supabase: SupabaseClient, prefix: string): Promise<LegacyObject[]> {
  const objects: LegacyObject[] = []
  let pending: { folder: string, depth: number }[] = [{ folder: prefix, depth: 0 }]
  let listedFolders = 0
  const progress = setInterval(() => console.log(`Listing: ${listedFolders} folders, ${objects.length} objects so far`), PROGRESS_INTERVAL_MS)
  try {
    while (pending.length > 0) {
      const next: { folder: string, depth: number }[] = []
      await asyncPool(LIST_CONCURRENCY, pending, async ({ folder, depth }) => {
        for (const entry of await listFolderPage(supabase, folder)) {
          const path = folder ? `${folder}/${entry.name}` : entry.name
          // Folders come back as placeholder entries without an id.
          if (entry.id === null) {
            if (depth < MAX_FOLDER_DEPTH)
              next.push({ folder: path, depth: depth + 1 })
            else
              console.warn(`Skipping folder deeper than ${MAX_FOLDER_DEPTH}: ${path}`)
          }
          else if (entry.name !== '.emptyFolderPlaceholder') {
            objects.push({ path, updatedAt: Date.parse(entry.updated_at ?? entry.created_at ?? '') })
          }
        }
        listedFolders++
      })
      pending = next
    }
  }
  finally {
    clearInterval(progress)
  }
  return objects
}

function getDatabaseUrl(env: Record<string, string | undefined>) {
  for (const key of DB_URL_ENV_KEYS) {
    const value = env[key]?.trim()
    if (value)
      return value
  }
  return null
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const overwrite = args.includes('--overwrite')
  const deleteSource = !args.includes('--keep-source')
  const prefix = (getArgValue(args, '--prefix') ?? '').replace(/^\/+|\/+$/g, '')
  const concurrency = parsePositiveInteger(getArgValue(args, '--concurrency'), '--concurrency', DEFAULT_CONCURRENCY)
  const envFile = getArgValue(args, '--env-file') ?? DEFAULT_ENV_FILE

  const env = { ...await loadEnv(envFile), ...process.env }
  const supabase = createSupabaseServiceClient(env)
  const images = createImageStore(env)

  console.log(apply ? 'Mode: APPLY' : 'Mode: DRY RUN')
  console.log(`Env file: ${envFile}`)
  console.log(`Target: s3://${images.bucket}/images/${prefix ? `${prefix}/` : ''}`)

  const databaseUrl = getDatabaseUrl(env)
  console.log(databaseUrl ? 'Listing Supabase images from storage.objects…' : 'No Postgres URL set: listing Supabase images through the Storage API (slow)…')
  const listStartedAt = Date.now()
  const paths = databaseUrl ? await listFromDatabase(databaseUrl, prefix) : await listThroughStorageApi(supabase, prefix)
  console.log(`Found ${paths.length} Supabase image objects in ${Math.round((Date.now() - listStartedAt) / 1000)}s`)
  // One R2 listing (1000 keys per request) instead of a HEAD per object.
  console.log('Listing R2 images…')
  const r2Index = await images.listLastModified(prefix)
  console.log(`Found ${r2Index.size} R2 image objects`)
  if (!deleteSource)
    console.warn('--keep-source: Supabase copies stay and will not be removed by account, org or app deletion. Run again without it.')

  let copied = 0
  let skipped = 0
  let kept = 0
  let removed = 0
  const failures: { path: string, error: string }[] = []
  let processed = 0
  const toRemove: string[] = []
  async function flushRemovals() {
    const batch = toRemove.splice(0, toRemove.length)
    if (batch.length === 0)
      return
    const { error } = await supabase.storage.from(BUCKET).remove(batch)
    if (error) {
      for (const path of batch)
        failures.push({ path, error: `remove from Supabase failed: ${error.message}` })
      return
    }
    removed += batch.length
  }
  const startedAt = Date.now()
  const progress = setInterval(() => {
    const seconds = (Date.now() - startedAt) / 1000
    const rate = processed / Math.max(seconds, 1)
    const remaining = rate > 0 ? Math.round((paths.length - processed) / rate) : 0
    console.log(`Progress: ${processed}/${paths.length} (${rate.toFixed(1)}/s, ~${remaining}s left) copied=${copied} skipped=${skipped} removed=${removed} failed=${failures.length}`)
  }, PROGRESS_INTERVAL_MS)

  await asyncPool(concurrency, paths, async ({ path, updatedAt }) => {
    try {
      // Same rule as the backend legacy import: a Supabase copy newer than R2
      // (an old CLI re-upload) replaces it; an older one is a leftover.
      const r2ModifiedAt = r2Index.get(path) ?? null
      const comparable = Number.isFinite(updatedAt)
      const supabaseIsNewer = !r2ModifiedAt || (comparable && updatedAt > r2ModifiedAt.getTime())
      const copy = overwrite || supabaseIsNewer

      if (!copy && !comparable) {
        // R2 has it but the age cannot be compared: keep the Supabase copy for review.
        kept++
        return
      }

      if (copy) {
        if (apply) {
          const { data: blob, error } = await supabase.storage.from(BUCKET).download(path)
          if (error || !blob)
            throw error ?? new Error('empty download')
          await images.upload(path, blob, { contentType: blob.type || undefined, upsert: true })
        }
        copied++
      }
      else {
        skipped++
      }

      // Only objects now safely in R2 are queued for removal from Supabase.
      if (apply && deleteSource) {
        toRemove.push(path)
        if (toRemove.length >= REMOVE_BATCH_SIZE)
          await flushRemovals()
      }
    }
    catch (error) {
      failures.push({ path, error: error instanceof Error ? error.message : String(error) })
    }
    finally {
      processed++
    }
  })
  await flushRemovals()
  clearInterval(progress)

  console.log(`${apply ? 'Copied' : 'Would copy'}: ${copied}`)
  console.log(`Already in R2 (same or newer): ${skipped}`)
  if (kept > 0)
    console.log(`Kept in Supabase (in R2 but age unknown; re-run with --overwrite to replace R2): ${kept}`)
  if (deleteSource)
    console.log(`${apply ? 'Removed from Supabase' : 'Would remove from Supabase (with --apply)'}: ${apply ? removed : paths.length - kept}`)
  if (failures.length > 0) {
    await mkdir('./tmp', { recursive: true })
    await writeFile(FAILURE_OUTPUT, JSON.stringify(failures, null, 2))
    console.error(`${failures.length} failures written to ${FAILURE_OUTPUT}`)
    process.exitCode = 1
  }
}

await main()
