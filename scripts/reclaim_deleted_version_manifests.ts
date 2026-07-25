/**
 * Reclaim soft-deleted app_versions leftover public.manifest rows.
 *
 * Time model (local → Supabase/R2):
 *   N ≈ versions × ~400 files (measured earlier ~16k rows / 40 versions).
 *   R2 wall ≈ N × latency / maxSockets.
 *   Default AWS SDK maxSockets≈50 → tens of minutes (TOO SLOW).
 *   This script sets maxSockets=R2_CONCURRENCY (1500) so HEAD-miss path
 *   for ~2.5M objects is ~1–2 min; copy-heavy path ~5–8 min. >10 min = fail.
 *
 * Flow:
 *   DB batches DELETE immediately (session_replication_role=replica).
 *   Paths enqueued for R2 move to deleted-after-7-days/ (not hard-wipe).
 *   Heartbeat every 2s so the terminal never looks stuck.
 */
import { Agent as HttpsAgent } from 'node:https'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import pg from 'pg'

const ENV_FILE = './internal/cloudflare/.env.prod'
const TRASH_PREFIX = 'deleted-after-7-days/'
const R2_CONCURRENCY = 1500
const DB_POOL_SIZE = 32
const VERSION_BATCH = 25
const HEARTBEAT_MS = 2000
const ASSUMED_FILES_PER_VERSION = 400
const MAX_OK_MINUTES = 10
const DB_URL_ENV_KEYS = [
  'MAIN_SUPABASE_DB_URL',
  'DATABASE_URL',
  'POSTGRES_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_DB_DIRECT_URL',
  'DIRECT_URL',
]

type Stats = {
  versionsTotal: number
  versionsDone: number
  batchesTotal: number
  batchesDone: number
  batchesInFlight: number
  dbRowsDeleted: number
  filesSeen: number
  phase: string
  lastBatch: string
  r2Queued: number
  r2Done: number
  r2Remaining: number
  startedAt: number
}

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

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T, workerId: number) => Promise<void>) {
  if (items.length === 0)
    return
  let idx = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async (_, workerId) => {
    while (idx < items.length) {
      const current = items[idx++]
      await fn(current, workerId)
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
    return 'skip_trash_prefix' as const
  const exists = await objectExists(s3, bucket, key)
  if (!exists)
    return 'missing' as const
  const encodedKey = key.split('/').map(segment => encodeURIComponent(segment)).join('/')
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${encodedKey}`,
    Key: `${TRASH_PREFIX}${key}`,
  }))
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  return 'moved' as const
}

function formatRate(count: number, startedAt: number) {
  const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001)
  return `${Math.round(count / elapsedSec)}/s`
}

function printEta(versions: number) {
  const n = versions * ASSUMED_FILES_PER_VERSION
  const headMissMin = (n * 0.03) / R2_CONCURRENCY / 60
  const mixedMin = (n * 0.12) / R2_CONCURRENCY / 60
  const brokenMin = (n * 0.05) / 50 / 60
  console.log('=== time model ===')
  console.log(`  assumed files ≈ ${n.toLocaleString()} (${versions} versions × ${ASSUMED_FILES_PER_VERSION})`)
  console.log(`  R2 sockets = ${R2_CONCURRENCY} (must be real, not SDK default 50)`)
  console.log(`  if mostly missing (HEAD 30ms): ~${headMissMin.toFixed(1)} min`)
  console.log(`  if mixed copy/HEAD (avg 120ms): ~${mixedMin.toFixed(1)} min`)
  console.log(`  if sockets stuck at 50: ~${brokenMin.toFixed(1)} min ← UNACCEPTABLE`)
  console.log(`  budget: ≤ ${MAX_OK_MINUTES} min`)
  if (mixedMin > MAX_OK_MINUTES) {
    console.log(`  WARNING: mixed-case estimate ${mixedMin.toFixed(1)} min > ${MAX_OK_MINUTES} min`)
  }
  console.log('==================')
}

function createTrashQueue(s3: S3Client, bucket: string, concurrency: number) {
  const queue: string[] = []
  const seen = new Set<string>()
  let closed = false
  let pending = 0
  let done = 0
  let moved = 0
  let missing = 0
  let failed = 0
  const sleepers: Array<() => void> = []

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
        const result = await moveToTrash(s3, bucket, path)
        if (result === 'moved')
          moved += 1
        else if (result === 'missing')
          missing += 1
      }
      catch (error) {
        failed += 1
        if (failed <= 20)
          console.error(`R2 trash failed for ${path}:`, error)
      }
      finally {
        done += 1
        if (queue.length > 0 || (closed && pending === done))
          wakeAll()
      }
    }
  })

  return {
    enqueue,
    close,
    get stats() {
      return {
        queued: seen.size,
        done,
        moved,
        missing,
        failed,
        remaining: queue.length,
        inflight: Math.max(pending - done, 0),
      }
    },
    finished: Promise.all(workers).then(() => undefined),
  }
}

async function wipeDbBatch(
  pool: pg.Pool,
  ids: string[],
  stats: Stats,
  workerId: number,
): Promise<{ deletedRows: number, trashPaths: string[], files: number }> {
  stats.batchesInFlight += 1
  stats.phase = `worker${workerId}: connect`
  stats.lastBatch = `first_id=${ids[0]} n=${ids.length}`
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    await client.query(`SET synchronous_commit = off`)

    stats.phase = `worker${workerId}: SELECT files`
    const filesRes = await client.query<{ s3_path: string, file_hash: string }>(
      `SELECT DISTINCT m.s3_path, m.file_hash
       FROM public.manifest AS m
       WHERE m.app_version_id = ANY($1::bigint[])
         AND m.s3_path IS NOT NULL
         AND m.s3_path <> ''`,
      [ids],
    )

    const hashes = [...new Set(filesRes.rows.map(r => r.file_hash))]
    const liveHashes = new Set<string>()
    stats.phase = `worker${workerId}: live-hash check (${hashes.length} hashes)`
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

    const trashPaths = [...new Set(
      filesRes.rows
        .filter(r => !liveHashes.has(r.file_hash))
        .map(r => r.s3_path),
    )]

    stats.phase = `worker${workerId}: DELETE+clear (${filesRes.rows.length} file rows)`
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

    return {
      deletedRows: deletedRes.rowCount ?? 0,
      trashPaths,
      files: filesRes.rows.length,
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
    stats.batchesInFlight -= 1
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
    requestHandler: new NodeHttpHandler({
      httpsAgent: new HttpsAgent({
        keepAlive: true,
        maxSockets: R2_CONCURRENCY,
        maxFreeSockets: 256,
      }),
      connectionTimeout: 10_000,
      requestTimeout: 60_000,
    }),
  })
  const bucket = env.S3_BUCKET || 'capgo'
  const trash = createTrashQueue(s3, bucket, R2_CONCURRENCY)

  const stats: Stats = {
    versionsTotal: 0,
    versionsDone: 0,
    batchesTotal: 0,
    batchesDone: 0,
    batchesInFlight: 0,
    dbRowsDeleted: 0,
    filesSeen: 0,
    phase: 'init',
    lastBatch: '',
    r2Queued: 0,
    r2Done: 0,
    r2Remaining: 0,
    startedAt: Date.now(),
  }

  const heartbeat = setInterval(() => {
    const r2 = trash.stats
    stats.r2Queued = r2.queued
    stats.r2Done = r2.done
    stats.r2Remaining = r2.remaining
    const elapsed = ((Date.now() - stats.startedAt) / 1000).toFixed(1)
    console.log(
      `[hb t+${elapsed}s] phase=${stats.phase} | versions ${stats.versionsDone}/${stats.versionsTotal} | batches ${stats.batchesDone}/${stats.batchesTotal} in_flight=${stats.batchesInFlight} | db_rows=${stats.dbRowsDeleted} ${formatRate(stats.dbRowsDeleted, stats.startedAt)} | files_seen=${stats.filesSeen} | r2 moved=${r2.moved} missing=${r2.missing} done=${r2.done}/${r2.queued} q=${r2.remaining} fail=${r2.failed} | last=${stats.lastBatch}`,
    )
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const onSignal = () => {
    clearInterval(heartbeat)
    trash.close()
    pool.end().finally(() => process.exit(1))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  console.log('1/2 Listing doomed versions...')
  stats.phase = 'list versions'
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
  stats.versionsTotal = versionIds.length
  console.log(`   deleted versions (bundles)=${versionIds.length}`)
  printEta(versionIds.length)

  if (versionIds.length === 0) {
    clearInterval(heartbeat)
    trash.close()
    await trash.finished
    await pool.end()
    console.log('Nothing to do.')
    return
  }

  const batches = chunk(versionIds, VERSION_BATCH)
  stats.batchesTotal = batches.length
  console.log('2/2 DB delete + R2 move-to-trash (parallel)')
  console.log(`   batches=${batches.length} db_pool=${DB_POOL_SIZE} version_batch=${VERSION_BATCH} r2_sockets=${R2_CONCURRENCY}`)
  console.log('   R2 = COPY to deleted-after-7-days/ then delete live key (lifecycle GC later)')
  console.log(`   heartbeat every ${HEARTBEAT_MS}ms`)

  stats.phase = 'running batches'
  await mapPool(batches, DB_POOL_SIZE, async (ids, workerId) => {
    const result = await wipeDbBatch(pool, ids, stats, workerId)
    trash.enqueue(result.trashPaths)
    stats.dbRowsDeleted += result.deletedRows
    stats.filesSeen += result.files
    stats.batchesDone += 1
    stats.versionsDone += ids.length
    console.log(
      `[batch] worker=${workerId} versions=${ids.length} files=${result.files} deleted_rows=${result.deletedRows} enqueued_r2=${result.trashPaths.length} first_id=${ids[0]}`,
    )
  })

  stats.phase = 'draining R2'
  console.log('DB done. Draining R2 queue...')
  trash.close()
  await trash.finished
  stats.phase = 'done'
  clearInterval(heartbeat)

  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await pool.end()

  const elapsedMin = (Date.now() - stats.startedAt) / 60000
  const r2 = trash.stats
  console.log('Done.')
  console.log(`Versions: ${versionIds.length}`)
  console.log(`DB rows deleted: ${stats.dbRowsDeleted}`)
  console.log(`Files seen: ${stats.filesSeen}`)
  console.log(`R2: moved=${r2.moved} already_missing=${r2.missing} failed=${r2.failed} total_attempted=${r2.queued}`)
  console.log(`Elapsed: ${elapsedMin.toFixed(2)} min`)
  if (elapsedMin > MAX_OK_MINUTES)
    console.error(`FAIL BUDGET: took ${elapsedMin.toFixed(2)} min > ${MAX_OK_MINUTES} min`)
}

await main()
