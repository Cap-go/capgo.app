/**
 * Reclaim soft-deleted app_versions leftover public.manifest rows.
 *
 * FAST path (no parallel live-hash joins — those freeze the DB):
 *   1) Parallel DELETE ... RETURNING s3_path, file_hash + clear version JSON/count
 *   2) ONE pass: which returned hashes still exist in manifest? (= live) → skip
 *   3) R2: move remaining paths to deleted-after-7-days/ (1500 sockets)
 *
 * Heartbeat every 2s.
 */
import { Agent as HttpsAgent } from 'node:https'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import pg from 'pg'

const ENV_FILE = './internal/cloudflare/.env.prod'
const TRASH_PREFIX = 'deleted-after-7-days/'
const R2_CONCURRENCY = 1500
const DB_POOL_SIZE = 16
const VERSION_BATCH = 50
const HASH_CHECK_BATCH = 2000
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

type Hb = {
  phase: string
  detail: string
  versionsTotal: number
  versionsDone: number
  batchesTotal: number
  batchesDone: number
  inFlight: number
  dbRows: number
  pathsCollected: number
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

function formatRate(count: number, startedAt: number) {
  const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001)
  return `${Math.round(count / elapsedSec)}/s`
}

function printEta(versions: number) {
  const n = versions * ASSUMED_FILES_PER_VERSION
  console.log('=== time model ===')
  console.log(`  assumed files ≈ ${n.toLocaleString()}`)
  console.log(`  phase1 DB DELETE parallel: should be <2 min`)
  console.log(`  phase2 live-hash (single-threaded, after delete): seconds–1 min`)
  console.log(`  phase3 R2 @ ${R2_CONCURRENCY} sockets HEAD30ms: ~${((n * 0.03) / R2_CONCURRENCY / 60).toFixed(1)} min`)
  console.log(`  phase3 R2 mixed 120ms: ~${((n * 0.12) / R2_CONCURRENCY / 60).toFixed(1)} min`)
  console.log(`  budget ≤ ${MAX_OK_MINUTES} min`)
  console.log('==================')
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
    return 'skip' as const
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

async function deleteBatch(
  pool: pg.Pool,
  ids: string[],
  hb: Hb,
  workerId: number,
): Promise<{ deletedRows: number, pairs: Array<{ s3_path: string, file_hash: string }> }> {
  hb.inFlight += 1
  hb.detail = `w${workerId} connect first=${ids[0]}`
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    await client.query(`SET synchronous_commit = off`)

    hb.detail = `w${workerId} DELETE RETURNING n=${ids.length}`
    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = '0'`)
    await client.query(`SET LOCAL synchronous_commit = off`)
    await client.query(`SET LOCAL session_replication_role = 'replica'`)

    const deletedRes = await client.query<{ s3_path: string | null, file_hash: string }>(
      `DELETE FROM public.manifest
       WHERE app_version_id = ANY($1::bigint[])
       RETURNING s3_path, file_hash`,
      [ids],
    )

    hb.detail = `w${workerId} clear version counters`
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

    const pairs: Array<{ s3_path: string, file_hash: string }> = []
    for (const row of deletedRes.rows) {
      if (row.s3_path)
        pairs.push({ s3_path: row.s3_path, file_hash: row.file_hash })
    }

    return { deletedRows: deletedRes.rowCount ?? 0, pairs }
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
    hb.inFlight -= 1
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

  const hb: Hb = {
    phase: 'init',
    detail: '',
    versionsTotal: 0,
    versionsDone: 0,
    batchesTotal: 0,
    batchesDone: 0,
    inFlight: 0,
    dbRows: 0,
    pathsCollected: 0,
    startedAt: Date.now(),
  }

  // path -> hash (last writer wins; same path same hash)
  const pathToHash = new Map<string, string>()
  let r2Moved = 0
  let r2Missing = 0
  let r2Failed = 0
  let r2Done = 0
  let r2Total = 0

  const heartbeat = setInterval(() => {
    const elapsed = ((Date.now() - hb.startedAt) / 1000).toFixed(1)
    console.log(
      `[hb t+${elapsed}s] ${hb.phase} | ${hb.detail} | versions ${hb.versionsDone}/${hb.versionsTotal} batches ${hb.batchesDone}/${hb.batchesTotal} inflight=${hb.inFlight} | db_rows=${hb.dbRows} ${formatRate(hb.dbRows, hb.startedAt)} | paths=${hb.pathsCollected} | r2 ${r2Done}/${r2Total} moved=${r2Moved} miss=${r2Missing} fail=${r2Failed}`,
    )
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const onSignal = () => {
    clearInterval(heartbeat)
    pool.end().finally(() => process.exit(1))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  console.log('1/3 Listing doomed versions...')
  hb.phase = 'list'
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
  hb.versionsTotal = versionIds.length
  console.log(`   versions=${versionIds.length}`)
  printEta(versionIds.length)

  if (versionIds.length === 0) {
    clearInterval(heartbeat)
    await pool.end()
    console.log('Nothing to do.')
    return
  }

  const batches = chunk(versionIds, VERSION_BATCH)
  hb.batchesTotal = batches.length
  console.log(`2/3 Parallel DB DELETE only (no live-hash in hot path) pool=${DB_POOL_SIZE} batch=${VERSION_BATCH} batches=${batches.length}`)
  hb.phase = 'db-delete'

  await mapPool(batches, DB_POOL_SIZE, async (ids, workerId) => {
    const result = await deleteBatch(pool, ids, hb, workerId)
    for (const pair of result.pairs)
      pathToHash.set(pair.s3_path, pair.file_hash)
    hb.dbRows += result.deletedRows
    hb.pathsCollected = pathToHash.size
    hb.batchesDone += 1
    hb.versionsDone += ids.length
    console.log(
      `[db] w${workerId} deleted_rows=${result.deletedRows} returned_paths=${result.pairs.length} unique_paths_total=${pathToHash.size} versions_done=${hb.versionsDone}/${hb.versionsTotal}`,
    )
  })

  console.log(`DB delete done. rows=${hb.dbRows} unique_paths=${pathToHash.size}`)
  console.log('3/3 Filter live hashes (single connection) then R2 move-to-trash...')
  hb.phase = 'live-filter'

  const allHashes = [...new Set(pathToHash.values())]
  const liveHashes = new Set<string>()
  const hashChunks = chunk(allHashes, HASH_CHECK_BATCH)
  console.log(`   checking ${allHashes.length} hashes in ${hashChunks.length} chunks (AFTER delete, so only live refs remain)`)

  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    for (let i = 0; i < hashChunks.length; i++) {
      hb.detail = `live chunk ${i + 1}/${hashChunks.length}`
      const liveRes = await client.query<{ file_hash: string }>(
        `SELECT DISTINCT file_hash
         FROM public.manifest
         WHERE file_hash = ANY($1::text[])`,
        [hashChunks[i]],
      )
      for (const row of liveRes.rows)
        liveHashes.add(row.file_hash)
      if ((i + 1) % 5 === 0 || i + 1 === hashChunks.length) {
        console.log(`   live-filter ${i + 1}/${hashChunks.length} live_hashes_so_far=${liveHashes.size}`)
      }
    }
  }
  finally {
    client.release()
  }

  const toTrash = [...pathToHash.entries()]
    .filter(([, hash]) => !liveHashes.has(hash))
    .map(([path]) => path)
  r2Total = toTrash.length
  console.log(`   trash_paths=${toTrash.length} keep_live=${pathToHash.size - toTrash.length}`)

  hb.phase = 'r2-trash'
  hb.detail = `moving ${toTrash.length} objects @ ${R2_CONCURRENCY} sockets`
  let idx = 0
  await mapPool(toTrash, R2_CONCURRENCY, async (path) => {
    try {
      const result = await moveToTrash(s3, bucket, path)
      if (result === 'moved')
        r2Moved += 1
      else if (result === 'missing')
        r2Missing += 1
    }
    catch (error) {
      r2Failed += 1
      if (r2Failed <= 30)
        console.error(`R2 fail ${path}:`, error)
    }
    finally {
      r2Done += 1
      // idx unused; r2Done is enough
      void idx
    }
  })

  clearInterval(heartbeat)
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await pool.end()

  const elapsedMin = (Date.now() - hb.startedAt) / 60000
  console.log('Done.')
  console.log(`Versions: ${versionIds.length}`)
  console.log(`DB rows deleted: ${hb.dbRows}`)
  console.log(`R2 moved=${r2Moved} missing=${r2Missing} failed=${r2Failed}`)
  console.log(`Elapsed: ${elapsedMin.toFixed(2)} min`)
  if (elapsedMin > MAX_OK_MINUTES)
    console.error(`FAIL BUDGET: ${elapsedMin.toFixed(2)} min > ${MAX_OK_MINUTES}`)
}

await main()
