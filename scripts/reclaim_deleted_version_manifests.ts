/**
 * Reclaim soft-deleted app_versions leftover public.manifest rows.
 *
 * DEFAULT = DB only (the part that actually frees Postgres). Target: finish
 * after deletes — do not sit for hours on R2.
 *
 * R2 (optional): RECLAIM_R2=1
 *   - Moves objects to deleted-after-7-days/ (copy + delete live key)
 *   - No HEAD (copy 404 => skip) — fewer RTT
 *   - Paths logged to .context/reclaim-r2-paths.tsv for resume:
 *       RECLAIM_R2_ONLY=1 bun scripts/reclaim_deleted_version_manifests.ts
 *
 * Usage:
 *   bun scripts/reclaim_deleted_version_manifests.ts
 *   RECLAIM_R2=1 bun scripts/reclaim_deleted_version_manifests.ts
 *   RECLAIM_R2_ONLY=1 bun scripts/reclaim_deleted_version_manifests.ts
 */
import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { CopyObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import pg from 'pg'

const ENV_FILE = './internal/cloudflare/.env.prod'
const TRASH_PREFIX = 'deleted-after-7-days/'
const PATH_LOG = '.context/reclaim-r2-paths.tsv'
const R2_CONCURRENCY = 400
const DB_POOL_SIZE = 16
const VERSION_BATCH = 50
const HASH_CHECK_BATCH = 5000
const HEARTBEAT_MS = 2000
const DB_URL_ENV_KEYS = [
  'MAIN_SUPABASE_DB_URL',
  'DATABASE_URL',
  'POSTGRES_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_DB_DIRECT_URL',
  'DIRECT_URL',
]

const DO_R2 = process.env.RECLAIM_R2 === '1' || process.env.RECLAIM_R2_ONLY === '1'
const R2_ONLY = process.env.RECLAIM_R2_ONLY === '1'

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

function ensurePathLog() {
  mkdirSync('.context', { recursive: true })
  if (!existsSync(PATH_LOG))
    writeFileSync(PATH_LOG, '')
}

function appendPaths(pairs: Array<{ s3_path: string, file_hash: string }>) {
  if (pairs.length === 0)
    return
  appendFileSync(PATH_LOG, `${pairs.map(p => `${p.s3_path}\t${p.file_hash}`).join('\n')}\n`)
}

function loadPathLog(): Map<string, string> {
  const map = new Map<string, string>()
  if (!existsSync(PATH_LOG))
    return map
  for (const line of readFileSync(PATH_LOG, 'utf8').split('\n')) {
    if (!line)
      continue
    const tab = line.indexOf('\t')
    if (tab <= 0)
      continue
    map.set(line.slice(0, tab), line.slice(tab + 1))
  }
  return map
}

/** Copy to trash; no HEAD. Missing object => skip. */
async function moveToTrashFast(s3: S3Client, bucket: string, key: string) {
  if (key.startsWith(TRASH_PREFIX))
    return 'skip' as const
  const encodedKey = key.split('/').map(segment => encodeURIComponent(segment)).join('/')
  try {
    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodedKey}`,
      Key: `${TRASH_PREFIX}${key}`,
    }))
  }
  catch (error: any) {
    const status = error?.$metadata?.httpStatusCode ?? error?.statusCode ?? error?.status
    const code = error?.name ?? error?.Code ?? error?.code
    if (status === 404 || code === 'NoSuchKey' || code === 'NotFound')
      return 'missing' as const
    throw error
  }
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
  hb.detail = `w${workerId} DELETE n=${ids.length} first=${ids[0]}`
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    await client.query(`SET synchronous_commit = off`)
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

async function filterLiveAndTrash(
  pool: pg.Pool,
  s3: S3Client,
  bucket: string,
  pathToHash: Map<string, string>,
  hb: Hb,
) {
  hb.phase = 'live-filter'
  const allHashes = [...new Set(pathToHash.values())]
  const liveHashes = new Set<string>()
  console.log(`Live-filter: ${allHashes.length} hashes via temp table...`)

  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    await client.query(`SET synchronous_commit = off`)
    await client.query(`
      CREATE TEMP TABLE reclaim_candidate_hashes (
        file_hash text PRIMARY KEY
      ) ON COMMIT PRESERVE ROWS
    `)
    for (const [i, hashChunk] of chunk(allHashes, HASH_CHECK_BATCH).entries()) {
      hb.detail = `temp insert ${i + 1}`
      await client.query(
        `INSERT INTO reclaim_candidate_hashes (file_hash)
         SELECT DISTINCT unnest($1::text[])
         ON CONFLICT DO NOTHING`,
        [hashChunk],
      )
    }
    hb.detail = 'semi-join'
    const liveRes = await client.query<{ file_hash: string }>(`
      SELECT c.file_hash
      FROM reclaim_candidate_hashes AS c
      WHERE EXISTS (
        SELECT 1 FROM public.manifest AS m WHERE m.file_hash = c.file_hash
      )
    `)
    for (const row of liveRes.rows)
      liveHashes.add(row.file_hash)
    await client.query(`DROP TABLE reclaim_candidate_hashes`)
  }
  finally {
    client.release()
  }

  const toTrash = [...pathToHash.entries()]
    .filter(([, hash]) => !liveHashes.has(hash))
    .map(([path]) => path)
  console.log(`R2 candidates: trash=${toTrash.length} keep_live=${pathToHash.size - toTrash.length}`)

  hb.phase = 'r2-trash'
  hb.detail = `${toTrash.length} objects, concurrency=${R2_CONCURRENCY}, no HEAD`
  let r2Done = 0
  let r2Moved = 0
  let r2Missing = 0
  let r2Failed = 0
  const r2Started = Date.now()

  // expose counters to heartbeat via hb.detail updates
  const timer = setInterval(() => {
    hb.detail = `r2 ${r2Done}/${toTrash.length} moved=${r2Moved} miss=${r2Missing} fail=${r2Failed} ${formatRate(r2Done, r2Started)}`
  }, 1000)
  timer.unref?.()

  await mapPool(toTrash, R2_CONCURRENCY, async (path) => {
    try {
      const result = await moveToTrashFast(s3, bucket, path)
      if (result === 'moved')
        r2Moved += 1
      else if (result === 'missing')
        r2Missing += 1
    }
    catch (error) {
      r2Failed += 1
      if (r2Failed <= 20)
        console.error(`R2 fail ${path}:`, error)
    }
    finally {
      r2Done += 1
    }
  })
  clearInterval(timer)
  console.log(`R2 done: moved=${r2Moved} missing=${r2Missing} failed=${r2Failed} in ${((Date.now() - r2Started) / 1000).toFixed(1)}s`)
}

async function main() {
  const env = await loadEnv(ENV_FILE)
  ensurePathLog()

  console.log(`Mode: ${R2_ONLY ? 'R2_ONLY (from path log)' : DO_R2 ? 'DB + R2' : 'DB ONLY (set RECLAIM_R2=1 to also trash)'}`)

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
        maxFreeSockets: 128,
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

  const heartbeat = setInterval(() => {
    const elapsed = ((Date.now() - hb.startedAt) / 1000).toFixed(1)
    console.log(
      `[hb t+${elapsed}s] ${hb.phase} | ${hb.detail} | versions ${hb.versionsDone}/${hb.versionsTotal} batches ${hb.batchesDone}/${hb.batchesTotal} inflight=${hb.inFlight} | db_rows=${hb.dbRows} ${formatRate(hb.dbRows, hb.startedAt)} | paths=${hb.pathsCollected}`,
    )
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const onSignal = () => {
    clearInterval(heartbeat)
    console.log(`\nInterrupted. Path log kept at ${PATH_LOG}`)
    console.log(`Resume R2 later: RECLAIM_R2_ONLY=1 bun scripts/reclaim_deleted_version_manifests.ts`)
    pool.end().finally(() => process.exit(1))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const pathToHash = R2_ONLY ? loadPathLog() : new Map<string, string>()

  if (R2_ONLY) {
    console.log(`Loaded ${pathToHash.size} paths from ${PATH_LOG}`)
    if (pathToHash.size === 0) {
      clearInterval(heartbeat)
      await pool.end()
      console.log('No paths to trash.')
      return
    }
    await filterLiveAndTrash(pool, s3, bucket, pathToHash, hb)
    clearInterval(heartbeat)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await pool.end()
    console.log(`Done (R2 only). Elapsed ${((Date.now() - hb.startedAt) / 60000).toFixed(2)} min`)
    return
  }

  console.log('1/2 Listing doomed versions...')
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

  if (versionIds.length === 0) {
    console.log('No DB rows left to delete.')
    if (DO_R2 && existsSync(PATH_LOG)) {
      const fromLog = loadPathLog()
      console.log(`RECLAIM_R2=1 and path log has ${fromLog.size} paths — running R2...`)
      for (const [k, v] of fromLog)
        pathToHash.set(k, v)
      await filterLiveAndTrash(pool, s3, bucket, pathToHash, hb)
    }
    clearInterval(heartbeat)
    await pool.end()
    console.log('Done.')
    return
  }

  const batches = chunk(versionIds, VERSION_BATCH)
  hb.batchesTotal = batches.length
  console.log(`2/2 DB DELETE pool=${DB_POOL_SIZE} batch=${VERSION_BATCH} batches=${batches.length}`)
  console.log(`   Paths appended to ${PATH_LOG} as we go (safe to Ctrl+C and resume R2 later)`)
  hb.phase = 'db-delete'

  await mapPool(batches, DB_POOL_SIZE, async (ids, workerId) => {
    const result = await deleteBatch(pool, ids, hb, workerId)
    appendPaths(result.pairs)
    for (const pair of result.pairs)
      pathToHash.set(pair.s3_path, pair.file_hash)
    hb.dbRows += result.deletedRows
    hb.pathsCollected = pathToHash.size
    hb.batchesDone += 1
    hb.versionsDone += ids.length
    console.log(
      `[db] w${workerId} rows=${result.deletedRows} paths+=${result.pairs.length} total_paths=${pathToHash.size} versions ${hb.versionsDone}/${hb.versionsTotal}`,
    )
  })

  console.log(`DB DONE in ${((Date.now() - hb.startedAt) / 60000).toFixed(2)} min — rows=${hb.dbRows} paths_logged=${pathToHash.size}`)

  if (!DO_R2) {
    clearInterval(heartbeat)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await pool.end()
    console.log('Skipping R2 (default). Paths saved.')
    console.log(`Trash later: RECLAIM_R2_ONLY=1 bun scripts/reclaim_deleted_version_manifests.ts`)
    return
  }

  await filterLiveAndTrash(pool, s3, bucket, pathToHash, hb)
  clearInterval(heartbeat)
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await pool.end()
  console.log(`Done. Elapsed ${((Date.now() - hb.startedAt) / 60000).toFixed(2)} min`)
}

await main()
