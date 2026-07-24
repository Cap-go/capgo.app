/**
 * Reclaim ALL soft-deleted app_versions that still have public.manifest rows.
 *
 * Design for speed:
 *   - 6407 = deleted VERSIONS (bundles). Each can have thousands of files.
 *   - Per batch (parallel): indexed SELECT files → enqueue R2 trash → DELETE rows
 *     immediately (do NOT wait for R2 before DB wipe).
 *   - Global R2 worker pool drains the trash queue in parallel with DB.
 *   - Progress logs use newlines so terminals actually show updates.
 *
 * Usage:
 *   bun scripts/reclaim_deleted_version_manifests.ts
 */
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import pg from 'pg'

const ENV_FILE = './internal/cloudflare/.env.prod'
const TRASH_PREFIX = 'deleted-after-7-days/'
const R2_CONCURRENCY = 1500
const DB_POOL_SIZE = 32
const VERSION_BATCH = 50
const DB_URL_ENV_KEYS = [
  'MAIN_SUPABASE_DB_URL',
  'DATABASE_URL',
  'POSTGRES_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_DB_DIRECT_URL',
  'DIRECT_URL',
]

async function loadEnv(filePath: string) {
  const env: Record<string, string> = {}
  const text = await Bun.file(filePath).text()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0)
      continue
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && value !== '')
      env[key] = value
  }
  return env
}

function requireDbUrl(env: Record<string, string>) {
  for (const key of DB_URL_ENV_KEYS) {
    if (env[key])
      return env[key]
  }
  throw new Error(`Missing DB URL. Set one of: ${DB_URL_ENV_KEYS.join(', ')}`)
}

function sslForUrl(databaseUrl: string) {
  const host = new URL(databaseUrl).hostname
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  return local ? false as const : { rejectUnauthorized: false }
}

function cleanDbUrl(databaseUrl: string) {
  const parsed = new URL(databaseUrl)
  parsed.searchParams.delete('sslmode')
  parsed.searchParams.delete('sslrootcert')
  return parsed.toString()
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  if (items.length === 0)
    return
  let idx = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const current = items[idx++]
      await fn(current)
    }
  })
  await Promise.all(workers)
}

async function objectExists(s3: S3Client, bucket: string, key: string) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  }
  catch (error: any) {
    const status = error?.$metadata?.httpStatusCode ?? error?.statusCode ?? error?.status
    const code = error?.name ?? error?.Code ?? error?.code
    if (status === 404 || code === 'NotFound' || code === 'NoSuchKey')
      return false
    throw error
  }
}

async function moveToTrash(s3: S3Client, bucket: string, key: string) {
  if (key.startsWith(TRASH_PREFIX))
    return
  const exists = await objectExists(s3, bucket, key)
  if (!exists)
    return
  const encodedKey = key.split('/').map(segment => encodeURIComponent(segment)).join('/')
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${encodedKey}`,
    Key: `${TRASH_PREFIX}${key}`,
  }))
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

function formatRate(count: number, startedAt: number) {
  const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001)
  return `${Math.round(count / elapsedSec)}/s`
}

function createTrashQueue(s3: S3Client, bucket: string, concurrency: number) {
  const queue: string[] = []
  const seen = new Set<string>()
  let closed = false
  let pending = 0
  let done = 0
  const sleepers: Array<() => void> = []
  const progressWaiters: Array<() => void> = []

  const wakeAll = () => {
    while (sleepers.length)
      sleepers.shift()!()
  }

  const enqueue = (paths: string[]) => {
    for (const path of paths) {
      if (!path || seen.has(path))
        continue
      seen.add(path)
      queue.push(path)
      pending += 1
    }
    wakeAll()
  }

  const close = () => {
    closed = true
    wakeAll()
  }

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const path = queue.shift()
      if (!path) {
        if (closed && pending === done)
          return
        await new Promise<void>((resolve) => {
          sleepers.push(resolve)
        })
        continue
      }
      try {
        await moveToTrash(s3, bucket, path)
      }
      catch (error) {
        console.error(`R2 trash failed for ${path}:`, error)
      }
      finally {
        done += 1
        if (done % 500 === 0) {
          for (const w of progressWaiters)
            w()
        }
        // Wake siblings in case more work arrived / close completed.
        if (queue.length > 0 || (closed && pending === done))
          wakeAll()
      }
    }
  })

  return {
    enqueue,
    close,
    get stats() {
      return { queued: seen.size, done, inflight: pending - done, remaining: queue.length }
    },
    onProgress(cb: () => void) {
      progressWaiters.push(cb)
    },
    finished: Promise.all(workers).then(() => undefined),
  }
}

async function wipeDbBatch(pool: pg.Pool, ids: string[]): Promise<{ deletedRows: number, trashPaths: string[], files: number, selectMs: number, liveMs: number, deleteMs: number }> {
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    await client.query(`SET synchronous_commit = off`)

    const t0 = Date.now()
    const filesRes = await client.query<{ s3_path: string, file_hash: string }>(
      `SELECT DISTINCT m.s3_path, m.file_hash
       FROM public.manifest AS m
       WHERE m.app_version_id = ANY($1::bigint[])
         AND m.s3_path IS NOT NULL
         AND m.s3_path <> ''`,
      [ids],
    )
    const selectMs = Date.now() - t0

    const hashes = [...new Set(filesRes.rows.map(r => r.file_hash))]
    const liveHashes = new Set<string>()
    const t1 = Date.now()
    for (const hashChunk of chunk(hashes, 1000)) {
      const liveRes = await client.query<{ file_hash: string }>(
        `SELECT DISTINCT m.file_hash
         FROM public.manifest AS m
         INNER JOIN public.app_versions AS av
           ON av.id = m.app_version_id
          AND av.deleted = false
         WHERE m.file_hash = ANY($1::text[])`,
        [hashChunk],
      )
      for (const row of liveRes.rows)
        liveHashes.add(row.file_hash)
    }
    const liveMs = Date.now() - t1

    const trashPaths = [...new Set(
      filesRes.rows
        .filter(r => !liveHashes.has(r.file_hash))
        .map(r => r.s3_path),
    )]

    const t2 = Date.now()
    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = '0'`)
    await client.query(`SET LOCAL synchronous_commit = off`)
    await client.query(`SET LOCAL session_replication_role = 'replica'`)

    const deletedRes = await client.query(
      `DELETE FROM public.manifest WHERE app_version_id = ANY($1::bigint[])`,
      [ids],
    )

    await client.query(
      `WITH prev AS (
         SELECT av.id, av.app_id,
           CASE WHEN av.manifest_count > 0 OR av.manifest IS NOT NULL THEN 1 ELSE 0 END AS counted
         FROM public.app_versions AS av
         WHERE av.id = ANY($1::bigint[])
       ),
       cleared AS (
         UPDATE public.app_versions AS av
         SET manifest_count = 0,
             manifest = NULL
         FROM prev
         WHERE av.id = prev.id
         RETURNING prev.app_id, prev.counted
       ),
       per_app AS (
         SELECT app_id, SUM(counted)::int AS cleared_count
         FROM cleared
         GROUP BY app_id
         HAVING SUM(counted) > 0
       )
       UPDATE public.apps AS a
       SET manifest_bundle_count = GREATEST(a.manifest_bundle_count - per_app.cleared_count, 0),
           updated_at = now()
       FROM per_app
       WHERE a.app_id = per_app.app_id`,
      [ids],
    )
    await client.query('COMMIT')
    const deleteMs = Date.now() - t2

    return {
      deletedRows: deletedRes.rowCount ?? 0,
      trashPaths,
      files: filesRes.rows.length,
      selectMs,
      liveMs,
      deleteMs,
    }
  }
  catch (error) {
    try {
      await client.query('ROLLBACK')
    }
    catch {
      // ignore
    }
    throw error
  }
  finally {
    client.release()
  }
}

async function main() {
  const env = await loadEnv(ENV_FILE)
  const databaseUrl = cleanDbUrl(requireDbUrl(env))
  const ssl = sslForUrl(databaseUrl)

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl,
    max: DB_POOL_SIZE,
    allowExitOnIdle: true,
  })
  pool.on('connect', (client) => {
    client.query(`SET statement_timeout = '0'`).catch(() => {})
  })
  pool.on('error', (error) => {
    console.error('pool error', error)
  })

  {
    const client = await pool.connect()
    try {
      await client.query(`SET statement_timeout = '0'`)
      await client.query(`ALTER TABLE public.app_versions ENABLE TRIGGER enforce_encrypted_bundle_trigger`)
    }
    finally {
      client.release()
    }
  }

  const s3 = new S3Client({
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    endpoint: `https://${env.S3_ENDPOINT}`,
    region: env.S3_REGION || 'auto',
    forcePathStyle: true,
    maxAttempts: 5,
  })
  const bucket = env.S3_BUCKET || 'capgo'
  const trash = createTrashQueue(s3, bucket, R2_CONCURRENCY)

  const onSignal = () => {
    trash.close()
    pool.end().finally(() => process.exit(1))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const startedAt = Date.now()

  console.log('1/2 Listing doomed versions (indexed)...')
  const versionsRes = await pool.query<{ id: string }>(`
    SELECT av.id::text AS id
    FROM public.app_versions AS av
    WHERE av.deleted = true
      AND av.manifest_count > 0
      AND av.app_id NOT LIKE 'com.capdemo%'
    UNION
    SELECT av.id::text AS id
    FROM public.app_versions AS av
    WHERE av.deleted = true
      AND COALESCE(av.manifest_count, 0) = 0
      AND av.app_id NOT LIKE 'com.capdemo%'
      AND EXISTS (
        SELECT 1 FROM public.manifest AS m WHERE m.app_version_id = av.id
      )
  `)
  const versionIds = versionsRes.rows.map(r => r.id)
  console.log(`   deleted versions (bundles)=${versionIds.length}`)
  if (versionIds.length === 0) {
    trash.close()
    await trash.finished
    await pool.end()
    console.log('Nothing to do.')
    return
  }

  const batches = chunk(versionIds, VERSION_BATCH)
  console.log('2/2 DB wipe + R2 trash in parallel')
  console.log(`   versions=${versionIds.length} batches=${batches.length} db_pool=${DB_POOL_SIZE} r2_workers=${R2_CONCURRENCY}`)
  console.log('   DB does NOT wait for R2. Progress prints every batch (newlines).')

  let totalDeleted = 0
  let totalFilesSeen = 0
  let batchesDone = 0
  let versionsDone = 0
  const workStarted = Date.now()

  const logProgress = (extra = '') => {
    const r2 = trash.stats
    console.log(
      `   t+${((Date.now() - workStarted) / 1000).toFixed(1)}s versions ${versionsDone}/${versionIds.length} batches ${batchesDone}/${batches.length} db_rows=${totalDeleted} ${formatRate(totalDeleted, workStarted)} files_seen=${totalFilesSeen} r2_done=${r2.done}/${r2.queued} r2_q=${r2.remaining}${extra}`,
    )
  }

  trash.onProgress(() => logProgress())
  logProgress(' | starting workers')

  await mapPool(batches, DB_POOL_SIZE, async (ids) => {
    const batchStarted = Date.now()
    console.log(`   → batch start versions=${ids.length} (first_id=${ids[0]})`)
    const result = await wipeDbBatch(pool, ids)
    trash.enqueue(result.trashPaths)
    totalDeleted += result.deletedRows
    totalFilesSeen += result.files
    batchesDone += 1
    versionsDone += ids.length
    console.log(
      `   ← batch done in ${Date.now() - batchStarted}ms select=${result.selectMs}ms live=${result.liveMs}ms delete=${result.deleteMs}ms files=${result.files} trash_enqueued=${result.trashPaths.length}`,
    )
    logProgress()
  })

  console.log('DB wipe complete. Waiting for R2 queue to drain...')
  trash.close()
  await trash.finished
  logProgress(' | r2 drained')

  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await pool.end()

  console.log('Done.')
  console.log(`Versions (bundles): ${versionIds.length}`)
  console.log(`Manifest file rows deleted: ${totalDeleted}`)
  console.log(`Distinct file rows seen: ${totalFilesSeen}`)
  console.log(`R2 objects attempted: ${trash.stats.queued}`)
  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  console.log('Note: R2 alone can exceed 3min if hundreds of thousands of objects need HEAD/copy. DB wipe should be the fast part.')
}

await main()
