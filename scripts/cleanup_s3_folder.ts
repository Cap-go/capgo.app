/**
 * Ops utility: process objects under an S3/R2 prefix.
 *
 * Default: dry-run (list/count only, no changes).
 * Trash (recommended execute mode): DRY_RUN=false
 * Permanent delete (dangerous): DRY_RUN=false ALLOW_PERMANENT_R2_DELETE=true
 *
 * Trash copies each live key under deleted-after-7-days/ then removes the source key.
 */
/// <reference lib="deno.ns" />
import { S3Client } from 'https://deno.land/x/s3_lite_client@0.7.0/mod.ts'
import { ConcurrencyLimiter, getR2TrashKey, isLiveR2Key, resolveOpsDeleteMode, R2_TRASH_PREFIX } from './r2_trash_utils.ts'

const folderToDelete = 'orgs'
if (!folderToDelete) {
  console.error('Please provide a folder path as argument')
  Deno.exit(1)
}

const CONCURRENCY = 20
const LIST_BATCH_SIZE = 200

const deleteMode = resolveOpsDeleteMode({
  DRY_RUN: Deno.env.get('DRY_RUN'),
  ALLOW_PERMANENT_R2_DELETE: Deno.env.get('ALLOW_PERMANENT_R2_DELETE'),
})

const s3client = new S3Client({
  endPoint: '***.r2.cloudflarestorage.com',
  useSSL: true,
  region: 'auto',
  accessKey: '***',
  secretKey: '***',
  bucket: 'backuptmp',
})

const limiter = new ConcurrencyLimiter(CONCURRENCY)

async function moveObjectToTrash(key: string): Promise<void> {
  const trashKey = getR2TrashKey(key)
  await s3client.copyObject({ sourceKey: key }, trashKey)
  await s3client.deleteObject(key)
}

async function processKey(key: string): Promise<void> {
  return limiter.run(async () => {
    if (deleteMode === 'trash') {
      console.log(`Moving to trash: ${key}`)
      await moveObjectToTrash(key)
      return
    }

    console.log(`Permanently deleting: ${key}`)
    await s3client.deleteObject(key)
  })
}

async function processKeyBatch(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    const batch = keys.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(key => processKey(key)))
  }
}

async function processFolder() {
  console.log(`Listing objects in folder: ${folderToDelete}`)
  console.log(`Mode: ${deleteMode}`)
  if (deleteMode === 'permanent')
    console.warn('WARNING: ALLOW_PERMANENT_R2_DELETE=true — objects will be permanently deleted')

  let processedCount = 0
  let errorCount = 0
  let pendingKeys: string[] = []

  const flushBatch = async () => {
    if (pendingKeys.length === 0)
      return

    const batch = pendingKeys
    pendingKeys = []

    if (deleteMode === 'dry_run') {
      for (const key of batch)
        console.log(`Would process: ${key}`)
      processedCount += batch.length
      return
    }

    for (const key of batch) {
      try {
        await processKey(key)
        processedCount += 1
      }
      catch (error) {
        errorCount += 1
        console.error(`Failed to process ${key}:`, error)
        if (deleteMode === 'trash')
          throw error
      }
    }
  }

  try {
    for await (const obj of s3client.listObjects({ prefix: folderToDelete })) {
      if (!isLiveR2Key(obj.key))
        continue

      pendingKeys.push(obj.key)
      if (pendingKeys.length >= LIST_BATCH_SIZE)
        await flushBatch()
    }

    await flushBatch()

    console.log(`Processed ${processedCount} files from ${folderToDelete}`)
    if (errorCount > 0) {
      console.error(`Errors: ${errorCount}`)
      Deno.exit(1)
    }
    if (deleteMode === 'trash')
      console.log(`Live keys moved under ${R2_TRASH_PREFIX} (lifecycle deletes after ~7 days)`)
    if (deleteMode === 'dry_run')
      console.log('Dry run complete — set DRY_RUN=false to move objects to trash.')
  }
  catch (error) {
    console.error('Error processing folder:', error)
    Deno.exit(1)
  }
}

await processFolder()
