import type { ScanOptions } from './r2_inventory/scan.ts'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { Client } from 'pg'
import { loadInventoryConfig, normalizeEtag } from '../supabase/functions/_backend/utils/r2_inventory.ts'
import { writeFailureReport } from './r2_inventory/report.ts'
import { collectInventoryTombstones, InventoryScanFailure, restartCompletedScan, scanInventory } from './r2_inventory/scan.ts'

export async function main() {
  const { values } = parseArgs({ options: {
    'bucket': { type: 'string' },
    'prefix': { type: 'string', default: '' },
    'job': { type: 'string', default: 'initial' },
    'mode': { type: 'string', default: 'backfill' },
    'write': { type: 'boolean', default: false },
    'restart': { type: 'boolean', default: false },
    'max-pages': { type: 'string', default: '1000' },
    'interval-ms': { type: 'string', default: '1000' },
    'report': { type: 'string', default: '.context/r2-inventory-failures.jsonl' },
    'help': { type: 'boolean', default: false },
  }, allowPositionals: false })
  if (values.help) {
    console.log('Usage: bun scripts/backfill-r2-inventory.ts --bucket <bucket> [--prefix <prefix>] [--job <name>] [--mode backfill|reconcile|gc] [--write] [--restart] [--max-pages 1000] [--interval-ms 1000] [--report <local JSONL>]')
    return
  }
  if (!values.bucket || !['backfill', 'reconcile', 'gc'].includes(values.mode!))
    throw new Error('An explicit bucket and valid mode are required; use --help')
  const databaseUrl = process.env.R2_INVENTORY_DATABASE_URL
  if (!databaseUrl)
    throw new Error('Set R2_INVENTORY_DATABASE_URL to an internal writer connection')
  const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 15000 })
  const shutdown = new AbortController()
  let stopping = false
  const stop = () => {
    stopping = true
    shutdown.abort()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    await db.connect()
    const config = await loadInventoryConfig(db)
    if (values.write && !config.enabled)
      throw new Error('Enable r2_inventory_config in Vault after checking queue health before writing inventory')
    if (values.mode === 'gc') {
      if (!values.write || values.prefix || values.restart)
        throw new Error('GC requires --write and full-bucket checkpoints')
      console.log(JSON.stringify({ mode: 'gc', deletedRows: await collectInventoryTombstones(db, values.bucket, values.job!, config) }))
      return
    }
    const endpoint = process.env.R2_ENDPOINT
    const accessKeyId = process.env.R2_ACCESS_KEY_ID
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
    if (!endpoint || !accessKeyId || !secretAccessKey)
      throw new Error('Set R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (LIST permission only)')
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.r2.cloudflarestorage.com'))
      throw new Error('R2_ENDPOINT must be a Cloudflare R2 S3 endpoint')
    const s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 5 })
    try {
      const options: ScanOptions = { bucket: values.bucket, prefix: values.prefix!, job: values.job!, mode: values.mode as 'backfill' | 'reconcile', write: values.write!, maxPages: Number(values['max-pages']), intervalMs: Number(values['interval-ms']) }
      if (values.restart) {
        if (!values.write)
          throw new Error('Restarting a completed checkpoint requires --write')
        await restartCompletedScan(db, options)
      }
      const result = await scanInventory(db, async (request) => {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: values.bucket, Prefix: request.prefix, MaxKeys: 1000, ContinuationToken: request.token, StartAfter: request.token ? undefined : request.startAfter }), { abortSignal: AbortSignal.timeout(30_000) })
        if (typeof page.IsTruncated !== 'boolean')
          throw new Error('R2 LIST did not report truncation status')
        return { truncated: page.IsTruncated, token: page.NextContinuationToken, objects: (page.Contents ?? []).map((object) => {
          if (object.Key === undefined || object.Size === undefined || object.ETag === undefined || !object.LastModified)
            throw new Error('R2 LIST returned incomplete object metadata')
          return { key: object.Key, size: object.Size, etag: normalizeEtag(object.ETag), lastModified: object.LastModified.toISOString() }
        }) }
      }, options, config, progress => console.log(JSON.stringify({ mode: values.mode, dryRun: !values.write, ...progress })), () => stopping, shutdown.signal)
      console.log(JSON.stringify({ event: stopping ? 'stopped' : result.complete ? 'complete' : 'page_budget_reached', dryRun: !values.write }))
    }
    finally {
      s3.destroy()
    }
  }
  catch (error) {
    // The report stays local and may contain private storage keys. Never commit it.
    await writeFailureReport(values.report!, { time: new Date().toISOString(), bucket: values.bucket, prefix: values.prefix, job: values.job, mode: values.mode, progress: error instanceof InventoryScanFailure ? error.progress : undefined, keys: error instanceof InventoryScanFailure ? error.keys : undefined, error: error instanceof InventoryScanFailure && error.originalError instanceof Error ? error.originalError.message : error instanceof Error ? error.message : 'Unknown failure' })
    throw new Error(`Inventory scan failed; inspect local report ${values.report}`)
  }
  finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await db.end()
  }
}
if (import.meta.main)
  await main()
