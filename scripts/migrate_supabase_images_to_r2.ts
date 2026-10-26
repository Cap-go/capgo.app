/*
 * Move every object of the Supabase Storage `images` bucket (avatars, org logos,
 * app icons) into R2 under `images/<same path>`, deleting each Supabase copy
 * once it is in R2. Run once when the backend switches image storage to R2;
 * re-running only moves what is still left in Supabase.
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
 *   --concurrency=8
 *   --overwrite             replace objects that already exist in R2
 *   --keep-source           copy only; leave the Supabase objects in place
 *   --env-file=./internal/cloudflare/.env.preprod
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createImageStore } from './admin_image_storage.ts'
import { asyncPool, createSupabaseServiceClient, DEFAULT_ENV_FILE, getArgValue, loadEnv, parsePositiveInteger } from './admin_stripe_backfill_utils.ts'

const BUCKET = 'images'
const PAGE_SIZE = 1000
const MAX_FOLDER_DEPTH = 6
const DEFAULT_CONCURRENCY = 8
const FAILURE_OUTPUT = './tmp/supabase_images_to_r2_failures.json'

type SupabaseClient = ReturnType<typeof createSupabaseServiceClient>

async function listAllObjects(supabase: SupabaseClient, prefix: string, depth = 0): Promise<string[]> {
  const paths: string[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error)
      throw error
    const entries = data ?? []
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      // Folders come back as placeholder entries without an id.
      if (entry.id === null) {
        if (depth < MAX_FOLDER_DEPTH)
          paths.push(...await listAllObjects(supabase, path, depth + 1))
        else
          console.warn(`Skipping folder deeper than ${MAX_FOLDER_DEPTH}: ${path}`)
      }
      else if (entry.name !== '.emptyFolderPlaceholder') {
        paths.push(path)
      }
    }
    if (entries.length < PAGE_SIZE)
      return paths
  }
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

  const paths = await listAllObjects(supabase, prefix)
  console.log(`Found ${paths.length} Supabase image objects`)
  if (!deleteSource)
    console.warn('--keep-source: Supabase copies stay and will not be removed by account, org or app deletion. Run again without it.')

  let copied = 0
  let skipped = 0
  let removed = 0
  const failures: { path: string, error: string }[] = []

  await asyncPool(concurrency, paths, async (path) => {
    try {
      const alreadyInR2 = await images.exists(path)
      if (alreadyInR2 && !overwrite) {
        skipped++
      }
      else if (apply) {
        const { data: blob, error } = await supabase.storage.from(BUCKET).download(path)
        if (error || !blob)
          throw error ?? new Error('empty download')
        await images.upload(path, blob, { contentType: blob.type || undefined, upsert: true })
        copied++
      }
      else {
        copied++
      }

      if (apply && deleteSource) {
        const { error } = await supabase.storage.from(BUCKET).remove([path])
        if (error)
          throw error
        removed++
      }
    }
    catch (error) {
      failures.push({ path, error: error instanceof Error ? error.message : String(error) })
    }
  })

  console.log(`${apply ? 'Copied' : 'Would copy'}: ${copied}`)
  console.log(`Already in R2: ${skipped}`)
  if (deleteSource)
    console.log(`${apply ? 'Removed from Supabase' : 'Would remove from Supabase (with --apply)'}: ${apply ? removed : paths.length}`)
  if (failures.length > 0) {
    await mkdir('./tmp', { recursive: true })
    await writeFile(FAILURE_OUTPUT, JSON.stringify(failures, null, 2))
    console.error(`${failures.length} failures written to ${FAILURE_OUTPUT}`)
    process.exitCode = 1
  }
}

await main()
