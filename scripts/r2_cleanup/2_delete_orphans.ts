/**
 * Script 2: Delete orphaned R2 paths
 *
 * Default: dry-run (count only).
 * Execute: DRY_RUN=false moves orphans to deleted-after-7-days/ (7-day trash).
 * Permanent delete requires ALLOW_PERMANENT_R2_DELETE=true (ops-only).
 */

import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { permanentDeleteAwsLiveKey } from './aws_permanent_delete.ts'
import {
  applyR2ConditionalDeleteMiddleware,
  ConcurrencyLimiter,
  createAwsTrashDestinationResolver,
  encodeS3CopySource,
  isAlreadyMovedToTrash,
  isLiveR2Key,
  isObjectNotFoundError,
  isPreconditionFailedError,
  resolveR2CleanupDeleteMode,
  resolveTrashDestinationKey,
  R2_TRASH_PREFIX,
} from './delete_mode.ts'

// Load environment from prod file
const envFile = await Bun.file('./internal/cloudflare/.env.prod').text()
const env: Record<string, string> = {}
for (const line of envFile.split('\n')) {
  const trimmed = line.trim()
  if (trimmed && !trimmed.startsWith('#')) {
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex > 0)
      env[trimmed.substring(0, eqIndex)] = trimmed.substring(eqIndex + 1)
  }
}

const INPUT_FILE = './tmp/r2_cleanup/1_orphaned_paths.json'
const S3_BUCKET = env.S3_BUCKET || 'capgo'
const CONCURRENCY = 50
const LIST_PAGE_SIZE = 1000

const deleteMode = resolveR2CleanupDeleteMode({
  DRY_RUN: process.env.DRY_RUN,
  ALLOW_PERMANENT_R2_DELETE: process.env.ALLOW_PERMANENT_R2_DELETE,
})

const s3 = new S3Client({
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  endpoint: `https://${env.S3_ENDPOINT}`,
  region: env.S3_REGION || 'auto',
  forcePathStyle: true,
})

const limiter = new ConcurrencyLimiter(CONCURRENCY)

const trashDestinationResolver = createAwsTrashDestinationResolver(async (objectKey) => {
  const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: objectKey }))
  return { etag: head.ETag }
})

let totalProcessed = 0
let totalErrors = 0
let totalToProcess = 0

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    return true
  }
  catch (error) {
    if (isObjectNotFoundError(error))
      return false
    throw error
  }
}

async function countPrefix(prefix: string): Promise<number> {
  let continuationToken: string | undefined
  let count = 0

  while (true) {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: LIST_PAGE_SIZE,
    }))

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && isLiveR2Key(obj.Key))
          count += 1
      }
    }

    if (!response.IsTruncated)
      break
    continuationToken = response.NextContinuationToken
  }

  return count
}

async function processKey(key: string): Promise<void> {
  return limiter.run(async () => {
    if (!isLiveR2Key(key))
      return

    if (deleteMode === 'dry_run') {
      totalProcessed += 1
      return
    }

    if (deleteMode === 'trash') {
      let sourceEtag: string | undefined
      let sourceLastModified: Date | undefined
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }))
        sourceEtag = head.ETag
        sourceLastModified = head.LastModified
      }
      catch (headError) {
        if (isObjectNotFoundError(headError)) {
          totalProcessed += 1
          return
        }
        console.error(`Failed to head ${key} before trash:`, headError)
        totalErrors += 1
        return
      }

      if (!sourceEtag || !sourceLastModified) {
        console.error(`Failed to trash ${key}: missing ETag or Last-Modified from HeadObject; source retained`)
        totalErrors += 1
        return
      }

      let trashKey: string
      try {
        trashKey = await resolveTrashDestinationKey(trashDestinationResolver, key, sourceEtag)
      }
      catch (headError) {
        console.error(`Failed to allocate trash destination for ${key}:`, headError)
        totalErrors += 1
        return
      }

      try {
        await s3.send(new CopyObjectCommand({
          Bucket: S3_BUCKET,
          CopySource: encodeS3CopySource(S3_BUCKET, key),
          CopySourceIfMatch: sourceEtag,
          Key: trashKey,
        }))
      }
      catch (copyError) {
        if (isPreconditionFailedError(copyError)) {
          console.warn(`Skipped trash copy for ${key}: live object changed before copy`)
          totalErrors += 1
          return
        }
        try {
          const trashExists = await objectExists(trashKey)
          const sourceExists = await objectExists(key)
          if (isAlreadyMovedToTrash(trashExists, sourceExists) || !sourceExists) {
            totalProcessed += 1
            return
          }
        }
        catch (verifyError) {
          console.error(`Failed to verify trash resume state for ${key}:`, verifyError)
          totalErrors += 1
          return
        }
        console.error(`Failed to trash ${key}:`, copyError)
        totalErrors += 1
        return
      }

      try {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          IfMatch: sourceEtag,
        })
        applyR2ConditionalDeleteMiddleware(deleteCommand.middlewareStack, { etag: sourceEtag, lastModified: sourceLastModified })
        await s3.send(deleteCommand)
        totalProcessed += 1
      }
      catch (deleteError) {
        if (isObjectNotFoundError(deleteError)) {
          totalProcessed += 1
          return
        }
        if (isPreconditionFailedError(deleteError)) {
          console.warn(`Skipped delete for ${key}: live object changed after copy; source key retained`)
          totalErrors += 1
          return
        }
        console.error(`Copied ${key} to trash but failed to delete source:`, deleteError)
        totalErrors += 1
      }
      return
    }

    // permanent mode is handled by permanentDeleteBatch in streamProcessPrefix
  })
}

async function processKeyBatch(keys: string[]): Promise<void> {
  // Work-conserving pool: ConcurrencyLimiter inside processKey keeps CONCURRENCY slots busy.
  await Promise.all(keys.map(key => processKey(key)))
}

async function permanentDeleteKey(key: string): Promise<void> {
  return limiter.run(async () => {
    const outcome = await permanentDeleteAwsLiveKey(s3, S3_BUCKET, key)
    switch (outcome) {
      case 'deleted':
      case 'skipped_missing':
        totalProcessed += 1
        return
      case 'skipped_changed':
        console.warn(`Skipped permanent delete for ${key}: live object changed since discovery; source retained`)
        totalErrors += 1
        return
      case 'failed':
        console.error(`Failed to permanently delete ${key}: missing guards or transport error; source retained`)
        totalErrors += 1
        return
    }
  })
}

async function permanentDeleteBatch(keys: string[]): Promise<void> {
  if (deleteMode !== 'permanent')
    return

  const liveKeys = keys.filter(isLiveR2Key)
  if (liveKeys.length === 0)
    return

  await Promise.all(liveKeys.map(key => permanentDeleteKey(key)))
}

async function listPrefixKeys(prefix: string): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined

  while (true) {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: LIST_PAGE_SIZE,
    }))

    for (const obj of response.Contents ?? []) {
      if (obj.Key && isLiveR2Key(obj.Key))
        keys.push(obj.Key)
    }

    if (!response.IsTruncated)
      break
    continuationToken = response.NextContinuationToken
  }

  return keys
}

async function streamProcessPrefix(prefix: string): Promise<void> {
  const liveKeys = await listPrefixKeys(prefix)

  if (deleteMode === 'permanent')
    await permanentDeleteBatch(liveKeys)
  else {
    await processKeyBatch(liveKeys)
  }
}

async function main() {
  console.log('\n=== Orphaned R2 Cleanup ===')
  console.log(`Mode: ${deleteMode}`)
  console.log(`Concurrency: ${CONCURRENCY}`)
  if (deleteMode === 'permanent') {
    console.warn('WARNING: ALLOW_PERMANENT_R2_DELETE=true — objects will be permanently deleted')
  }
  console.log()

  const inputFile = Bun.file(INPUT_FILE)
  if (!await inputFile.exists()) {
    console.error('Run script 1 first')
    process.exit(1)
  }

  const data = await inputFile.json()
  const allPaths = data.orphanedPaths as { path: string, type: string }[]

  const files = allPaths
    .filter(p => p.path.endsWith('.zip'))
    .map(p => p.path)
    .filter(isLiveR2Key)
  const folders = allPaths.filter(p => !p.path.endsWith('.zip')).map(p => p.path)

  console.log(`Files to process: ${files.length}`)
  console.log(`Folders to process: ${folders.length}`)

  console.log('\nCounting total objects (this can take time)...')
  let folderObjects = 0
  if (folders.length > 0) {
    for (let i = 0; i < folders.length; i += CONCURRENCY) {
      const batch = folders.slice(i, i + CONCURRENCY)
      const counts = await Promise.all(batch.map(f => countPrefix(f)))
      folderObjects += counts.reduce((a, b) => a + b, 0)
      process.stdout.write(`\r  Counted folders: ${Math.min(i + CONCURRENCY, folders.length)}/${folders.length} | Objects so far: ${folderObjects}`)
    }
    process.stdout.write('\n')
  }

  totalToProcess = files.length + folderObjects
  console.log(`\nTotal objects to process: ${totalToProcess}`)

  if (deleteMode === 'dry_run') {
    console.log('\nDry run complete — no objects changed. Set DRY_RUN=false to move orphans to trash.')
    return
  }

  const ticker = setInterval(() => {
    process.stdout.write(`\r  Processed: ${totalProcessed} | Errors: ${totalErrors}`)
  }, 500)

  if (files.length > 0) {
    console.log(`\nProcessing ${files.length} files...`)
    if (deleteMode === 'permanent')
      await permanentDeleteBatch(files)
    else {
      await processKeyBatch(files)
    }
  }

  if (folders.length > 0) {
    console.log(`\nProcessing ${folders.length} folders...`)
    for (let i = 0; i < folders.length; i++) {
      await streamProcessPrefix(folders[i]!)
      process.stdout.write(`\r  Progress: ${i + 1}/${folders.length} folders | ${totalProcessed} objects processed`)
    }
  }

  clearInterval(ticker)

  console.log('\n\n=== Done ===')
  console.log(`Total processed: ${totalProcessed}`)
  console.log(`Errors: ${totalErrors}`)
  if (deleteMode === 'trash')
    console.log(`Objects moved under ${R2_TRASH_PREFIX} (lifecycle deletes after ~7 days)`)
  if (totalErrors > 0)
    process.exit(1)
}

await main()
