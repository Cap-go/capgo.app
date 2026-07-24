/**
 * Reclaim ALL soft-deleted app_versions that still have public.manifest rows.
 *
 * Fast path — only indexed lookups, no global NOT EXISTS on manifest:
 *   For each version-id batch (parallel pool):
 *     1) SELECT DISTINCT s3_path, file_hash WHERE app_version_id = ANY(batch)
 *        (idx_manifest_app_version_id)
 *     2) SELECT live file_hashes WHERE file_hash = ANY(...) AND av.deleted=false
 *        (idx_manifest_file_hash)
 *     3) trash R2 paths whose hash is not live
 *     4) DELETE rows + clear JSON/count (session_replication_role=replica)
 *
 * Usage:
 *   bun scripts/reclaim_deleted_version_manifests.ts
 *
 * Must print "1/2 ..." — if you see "Cleaned N/M" or "2/3 Collecting R2 paths
 * not used by live versions", you are on an old script.
 * RequestTimeTooSkewed => sudo sntp -sS time.apple.com
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

/** Global R2 limiter shared across all DB batch workers. */
function createLimiter(max: number) {
  let active = 0
  const waiters: Array<() => void> = []
  const acquire = async () => {
    if (active < max) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1
        resolve()
      })
    })
  }
  const release = () => {
    active -= 1
    const next = waiters.shift()
    if (next)
      next()
  }
  return async <T>(fn: () => Promise<T>) => {
    await acquire()
    try {
      return await fn()
    }
    finally {
      release()
    }
  }
}

async function processBatch(
  pool: pg.Pool,
  s3: S3Client,
  bucket: string,
  ids: string[],
  withR2: <T>(fn: () => Promise<T>) => Promise<T>,
  onR2Progress?: (done: number, total: number) => void,
): Promise<{ deletedRows: number, trashed: number, files: number }> {
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    await client.query(`SET synchronous_commit = off`)

    // Indexed: idx_manifest_app_version_id
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
    for (const hashChunk of chunk(hashes, 500)) {
      // Indexed: idx_manifest_file_hash + deleted filter on small parent set
      const liveRes = await client.query<{ file_hash: string }>(
        `SELECT DISTINCT m.file_hash
         FROM public.manifest AS m
         WHERE m.file_hash = ANY($1::text[])
           AND EXISTS (
             SELECT 1
             FROM public.app_versions AS av
             WHERE av.id = m.app_version_id
               AND av.deleted = false
           )`,
        [hashChunk],
      )
      for (const row of liveRes.rows)
        liveHashes.add(row.file_hash)
    }

    const toTrash = [...new Set(
      filesRes.rows
        .filter(r => !liveHashes.has(r.file_hash))
        .map(r => r.s3_path),
    )]

    // Trash first (paths still tracked in DB), then wipe rows.
    let r2Done = 0
    await mapPool(toTrash, Math.min(R2_CONCURRENCY, Math.max(toTrash.length, 1)), async (path) => {
      await withR2(async () => moveToTrash(s3, bucket, path))
      r2Done += 1
      if (onR2Progress && (r2Done % 200 === 0 || r2Done === toTrash.length))
        onR2Progress(r2Done, toTrash.length)
    })

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
    return { deletedRows: deletedRes.rowCount ?? 0, trashed: toTrash.length, files: filesRes.rows.length }
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

  const onSignal = () => {
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
      AND av.manifest_count = 0
      AND av.app_id NOT LIKE 'com.capdemo%'
      AND EXISTS (
        SELECT 1 FROM public.manifest AS m WHERE m.app_version_id = av.id
      )
  `)
  const versionIds = versionsRes.rows.map(r => r.id)
  console.log(`   deleted versions (bundles)=${versionIds.length}`)
  if (versionIds.length === 0) {
    await pool.end()
    console.log('Nothing to do.')
    return
  }

  const batches = chunk(versionIds, VERSION_BATCH)
  console.log(`2/2 Wiping ${versionIds.length} deleted VERSIONS (bundles), not files.`)
  console.log(`   Each version can have thousands of manifest files.`)
  console.log(`   parallel: pool=${DB_POOL_SIZE} version_batch=${VERSION_BATCH} batches=${batches.length} r2_concurrency=${R2_CONCURRENCY}`)

  let totalDeleted = 0
  let totalTrashed = 0
  let totalFilesSeen = 0
  let batchesDone = 0
  let versionsDone = 0
  const workStarted = Date.now()
  const withR2 = createLimiter(R2_CONCURRENCY)

  const render = (extra = '') => {
    process.stdout.write(
      `\r   versions ${versionsDone}/${versionIds.length} | batches ${batchesDone}/${batches.length} | db_rows=${totalDeleted} ${formatRate(totalDeleted, workStarted)} | files_seen=${totalFilesSeen} | r2_trashed=${totalTrashed}${extra}`,
    )
  }

  await mapPool(batches, DB_POOL_SIZE, async (ids) => {
    const result = await processBatch(pool, s3, bucket, ids, withR2, (done, total) => {
      render(` | r2_batch=${done}/${total}`)
    })
    totalDeleted += result.deletedRows
    totalTrashed += result.trashed
    totalFilesSeen += result.files
    batchesDone += 1
    versionsDone += ids.length
    render()
  })
  process.stdout.write('\n')

  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await pool.end()

  console.log('Done.')
  console.log(`Versions (bundles): ${versionIds.length}`)
  console.log(`Manifest file rows deleted: ${totalDeleted}`)
  console.log(`Distinct file rows seen: ${totalFilesSeen}`)
  console.log(`R2 objects moved to trash: ${totalTrashed}`)
  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}

await main()
