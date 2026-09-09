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
import { asS3LiteTrashClient, ConcurrencyLimiter, isLiveR2Key, moveS3LiteObjectToTrash, resolveOpsDeleteMode, R2_TRASH_PREFIX } from './r2_trash_utils.ts'

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

const rawS3client = new S3Client({
  endPoint: '***.r2.cloudflarestorage.com',
  useSSL: true,
  region: 'auto',
  accessKey: '***',
  secretKey: '***',
  bucket: 'backuptmp',
})

const s3client = asS3LiteTrashClient(rawS3client)

const limiter = new ConcurrencyLimiter(CONCURRENCY)

async function processKey(key: string): Promise<void> {
  return limiter.run(async () => {
    if (deleteMode === 'trash') {
      console.log(`Moving to trash: ${key}`)
      const result = await moveS3LiteObjectToTrash(s3client, key)
      if (result === 'skipped_missing') {
        console.log(`Already absent: ${key}`)
        return
      }
      if (result === 'skipped_changed')
        throw new Error(`Copied ${key} to trash but live object changed before delete; source key retained`)
      return
    }

    console.log(`Permanently deleting: ${key}`)
    await rawS3client.deleteObject(key)
  })
}

async function processKeyBatch(keys: string[]): Promise<{ succeeded: number, failed: number }> {
  let succeeded = 0
  let failed = 0

  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    const batch = keys.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(key => processKey(key)))
    const batchFailures: unknown[] = []
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        succeeded += 1
        continue
      }

      failed += 1
      batchFailures.push(result.reason)
      console.error(`Failed to process ${batch[index]}:`, result.reason)
    }
    if (batchFailures.length > 0 && deleteMode === 'trash')
      throw batchFailures[0]
  }

  return { succeeded, failed }
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

    const { succeeded, failed } = await processKeyBatch(batch)
    processedCount += succeeded
    errorCount += failed
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
