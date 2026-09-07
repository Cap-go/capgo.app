/**
 * Script 2: Delete orphaned R2 paths
 *
 * Default: dry-run (count only).
 * Execute: DRY_RUN=false moves orphans to deleted-after-7-days/ (7-day trash).
 * Permanent delete requires ALLOW_PERMANENT_R2_DELETE=true (ops-only).
 */

import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import {
  ConcurrencyLimiter,
  encodeS3CopySource,
  getR2TrashKey,
  isLiveR2Key,
  resolveR2CleanupDeleteMode,
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

let totalProcessed = 0
let totalErrors = 0
let totalToProcess = 0

function filterLiveKeys(keys: string[]): string[] {
  return keys.filter(isLiveR2Key)
}

async function countPrefix(prefix: string): Promise<number> {
  let continuationToken: string | undefined
  let count = 0

  while (true) {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
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
      const trashKey = getR2TrashKey(key)
      try {
        await s3.send(new CopyObjectCommand({
          Bucket: S3_BUCKET,
          CopySource: encodeS3CopySource(S3_BUCKET, key),
          Key: trashKey,
        }))
        await s3.send(new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
        }))
        totalProcessed += 1
      }
      catch {
        totalErrors += 1
      }
      return
    }

    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }))
      totalProcessed += 1
    }
    catch {
      totalErrors += 1
    }
  })
}

async function collectPrefixKeys(prefix: string): Promise<string[]> {
  const keys: string[] = []
  let continuationToken: string | undefined

  while (true) {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }))

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key && isLiveR2Key(obj.Key))
          keys.push(obj.Key)
      }
    }

    if (!response.IsTruncated)
      break
    continuationToken = response.NextContinuationToken
  }

  return keys
}

async function processFiles(keys: string[]): Promise<void> {
  const liveKeys = filterLiveKeys(keys)
  await Promise.all(liveKeys.map(processKey))
}

async function permanentDeleteBatch(keys: string[]): Promise<void> {
  if (deleteMode !== 'permanent')
    return

  const liveKeys = filterLiveKeys(keys)
  if (liveKeys.length === 0)
    return

  try {
    const response = await s3.send(new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: { Objects: liveKeys.map(k => ({ Key: k })), Quiet: true },
    }))
    const batchErrors = response.Errors ?? []
    totalErrors += batchErrors.length
    totalProcessed += liveKeys.length - batchErrors.length
  }
  catch {
    totalErrors += liveKeys.length
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

  const files = filterLiveKeys(allPaths.filter(p => p.path.endsWith('.zip')).map(p => p.path))
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
    if (deleteMode === 'permanent') {
      const batches: string[][] = []
      for (let i = 0; i < files.length; i += 999)
        batches.push(files.slice(i, i + 999))
      for (const batch of batches)
        await permanentDeleteBatch(batch)
    }
    else {
      await processFiles(files)
    }
  }

  if (folders.length > 0) {
    console.log(`\nProcessing ${folders.length} folders...`)
    for (let i = 0; i < folders.length; i++) {
      const folderKeys = await collectPrefixKeys(folders[i]!)
      if (deleteMode === 'permanent') {
        const batches: string[][] = []
        for (let j = 0; j < folderKeys.length; j += 999)
          batches.push(folderKeys.slice(j, j + 999))
        for (const batch of batches)
          await permanentDeleteBatch(batch)
      }
      else {
        await processFiles(folderKeys)
      }
      process.stdout.write(`\r  Progress: ${i + 1}/${folders.length} folders | ${totalProcessed} objects processed`)
    }
  }

  clearInterval(ticker)

  console.log('\n\n=== Done ===')
  console.log(`Total processed: ${totalProcessed}`)
  console.log(`Errors: ${totalErrors}`)
  if (deleteMode === 'trash')
    console.log(`Objects moved under ${R2_TRASH_PREFIX} (lifecycle deletes after ~7 days)`)
}

await main()
