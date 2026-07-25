/**
 * Reclaim soft-deleted app_versions leftover public.manifest rows.
 *
 * SOLID ORDER (no orphans):
 *   1) SELECT paths → append+fsync to .context/reclaim-r2-paths.tsv
 *   2) Live-filter (keep hashes still used by non-deleted versions)
 *   3) R2: copy → deleted-after-7-days/ then delete live key (missing=ok)
 *   4) Only then DELETE manifest rows + clear app_versions counters
 *
 * Ctrl+C after step 1 is safe: resume with RECLAIM_RESUME=1
 *
 * Usage:
 *   bun scripts/reclaim_deleted_version_manifests.ts
 *   RECLAIM_RESUME=1 bun scripts/reclaim_deleted_version_manifests.ts
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, fsyncSync, truncateSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { CopyObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import pg from 'pg'

const ENV_FILE = './internal/cloudflare/.env.prod'
const TRASH_PREFIX = 'deleted-after-7-days/'
const PATH_LOG = '.context/reclaim-r2-paths.tsv'
const DONE_LOG = '.context/reclaim-r2-done.txt'
const R2_CONCURRENCY = Number(process.env.RECLAIM_R2_CONCURRENCY || 800)
const DB_POOL_SIZE = Number(process.env.RECLAIM_DB_POOL || 16)
const VERSION_BATCH = Number(process.env.RECLAIM_VERSION_BATCH || 50)
const HASH_CHECK_BATCH = 5000
const HEARTBEAT_MS = 2000
const RESUME = process.env.RECLAIM_RESUME === '1'
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
  r2Done: number
  r2Total: number
  r2Moved: number
  r2Missing: number
  r2Failed: number
  startedAt: number
  phaseStartedAt: number
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

function ensureContext() {
  mkdirSync('.context', { recursive: true })
}

/** Durable append: write + fsync so Ctrl+C cannot lose the path list. */
function appendPathsDurable(pairs: Array<{ s3_path: string, file_hash: string }>) {
  if (pairs.length === 0)
    return
  const payload = `${pairs.map(p => `${p.s3_path}\t${p.file_hash}`).join('\n')}\n`
  const fd = openSync(PATH_LOG, 'a')
  try {
    appendFileSync(fd, payload)
    fsyncSync(fd)
  }
  finally {
    closeSync(fd)
  }
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

function loadDoneSet(): Set<string> {
  const set = new Set<string>()
  if (!existsSync(DONE_LOG))
    return set
  for (const line of readFileSync(DONE_LOG, 'utf8').split('\n')) {
    if (line)
      set.add(line)
  }
  return set
}

function appendDoneDurable(paths: string[]) {
  if (paths.length === 0)
    return
  const fd = openSync(DONE_LOG, 'a')
  try {
    appendFileSync(fd, `${paths.join('\n')}\n`)
    fsyncSync(fd)
  }
  finally {
    closeSync(fd)
  }
}

/** Copy to trash; no HEAD. Missing => ok. */
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

async function selectPathsBatch(
  pool: pg.Pool,
  ids: string[],
  hb: Hb,
  workerId: number,
): Promise<Array<{ s3_path: string, file_hash: string }>> {
  hb.inFlight += 1
  hb.detail = `w${workerId} SELECT n=${ids.length}`
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    const res = await client.query<{ s3_path: string, file_hash: string }>(
      `SELECT DISTINCT m.s3_path, m.file_hash
       FROM public.manifest AS m
       WHERE m.app_version_id = ANY($1::bigint[])
         AND m.s3_path IS NOT NULL
         AND m.s3_path <> ''`,
      [ids],
    )
    return res.rows
  }
  finally {
    hb.inFlight -= 1
    client.release()
  }
}

async function deleteBatch(
  pool: pg.Pool,
  ids: string[],
  hb: Hb,
  workerId: number,
): Promise<number> {
  hb.inFlight += 1
  hb.detail = `w${workerId} DELETE n=${ids.length}`
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    await client.query(`SET synchronous_commit = off`)
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
    return deletedRes.rowCount ?? 0
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

async function liveFilterHashes(pool: pg.Pool, hashes: string[], hb: Hb): Promise<Set<string>> {
  hb.phase = 'live-filter'
  hb.phaseStartedAt = Date.now()
  const liveHashes = new Set<string>()
  if (hashes.length === 0)
    return liveHashes

  console.log(`Live-filter: ${hashes.length} hashes via temp table...`)
  const client = await pool.connect()
  try {
    await client.query(`SET statement_timeout = '0'`)
    await client.query(`
      CREATE TEMP TABLE reclaim_candidate_hashes (
        file_hash text PRIMARY KEY
      ) ON COMMIT PRESERVE ROWS
    `)
    for (const [i, hashChunk] of chunk(hashes, HASH_CHECK_BATCH).entries()) {
      hb.detail = `temp insert ${i + 1}/${Math.ceil(hashes.length / HASH_CHECK_BATCH)}`
      await client.query(
        `INSERT INTO reclaim_candidate_hashes (file_hash)
         SELECT DISTINCT unnest($1::text[])
         ON CONFLICT DO NOTHING`,
        [hashChunk],
      )
    }
    hb.detail = 'semi-join against live manifests'
    // Only treat as live if a NON-deleted version still references the hash
    const liveRes = await client.query<{ file_hash: string }>(`
      SELECT c.file_hash
      FROM reclaim_candidate_hashes AS c
      WHERE EXISTS (
        SELECT 1
        FROM public.manifest AS m
        INNER JOIN public.app_versions AS av
          ON av.id = m.app_version_id
         AND av.deleted = false
        WHERE m.file_hash = c.file_hash
      )
    `)
    for (const row of liveRes.rows)
      liveHashes.add(row.file_hash)
    await client.query(`DROP TABLE reclaim_candidate_hashes`)
  }
  finally {
    client.release()
  }
  return liveHashes
}

async function trashPaths(
  s3: S3Client,
  bucket: string,
  paths: string[],
  hb: Hb,
) {
  hb.phase = 'r2-trash'
  hb.phaseStartedAt = Date.now()
  hb.r2Total = paths.length
  hb.r2Done = 0
  hb.r2Moved = 0
  hb.r2Missing = 0
  hb.r2Failed = 0
  hb.detail = `${paths.length} objects concurrency=${R2_CONCURRENCY}`

  const doneBuf: string[] = []
  let lastFlush = Date.now()

  await mapPool(paths, R2_CONCURRENCY, async (path) => {
    try {
      const result = await moveToTrashFast(s3, bucket, path)
      if (result === 'moved')
        hb.r2Moved += 1
      else if (result === 'missing')
        hb.r2Missing += 1
      doneBuf.push(path)
    }
    catch (error) {
      hb.r2Failed += 1
      if (hb.r2Failed <= 30)
        console.error(`R2 fail ${path}:`, error)
    }
    finally {
      hb.r2Done += 1
      if (doneBuf.length >= 500 || Date.now() - lastFlush > 2000) {
        const flush = doneBuf.splice(0, doneBuf.length)
        appendDoneDurable(flush)
        lastFlush = Date.now()
      }
    }
  })
  if (doneBuf.length)
    appendDoneDurable(doneBuf)

  if (hb.r2Failed > 0) {
    throw new Error(`R2 trash finished with ${hb.r2Failed} failures — NOT deleting DB. Fix failures and RECLAIM_RESUME=1`)
  }
  console.log(`R2 done: moved=${hb.r2Moved} missing=${hb.r2Missing} failed=${hb.r2Failed} in ${((Date.now() - hb.phaseStartedAt) / 1000).toFixed(1)}s`)
}

async function main() {
  const env = await loadEnv(ENV_FILE)
  ensureContext()

  console.log('Mode: SOLID (paths durable → R2 trash → DB delete). No orphans.')
  if (RESUME)
    console.log(`RESUME from ${PATH_LOG}`)

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
    r2Done: 0,
    r2Total: 0,
    r2Moved: 0,
    r2Missing: 0,
    r2Failed: 0,
    startedAt: Date.now(),
    phaseStartedAt: Date.now(),
  }

  const heartbeat = setInterval(() => {
    const elapsed = ((Date.now() - hb.startedAt) / 1000).toFixed(1)
    console.log(
      `[hb t+${elapsed}s] ${hb.phase} | ${hb.detail} | versions ${hb.versionsDone}/${hb.versionsTotal} batches ${hb.batchesDone}/${hb.batchesTotal} inflight=${hb.inFlight} | paths=${hb.pathsCollected} | r2 ${hb.r2Done}/${hb.r2Total} moved=${hb.r2Moved} miss=${hb.r2Missing} fail=${hb.r2Failed} ${hb.r2Done ? formatRate(hb.r2Done, hb.phaseStartedAt) : ''} | db_rows=${hb.dbRows}`,
    )
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const onSignal = () => {
    clearInterval(heartbeat)
    console.log(`\nInterrupted. Path log: ${PATH_LOG} done log: ${DONE_LOG}`)
    console.log(`Resume (no orphans): RECLAIM_RESUME=1 bun scripts/reclaim_deleted_version_manifests.ts`)
    pool.end().finally(() => process.exit(1))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  let pathToHash = new Map<string, string>()
  let versionIds: string[] = []

  if (RESUME) {
    pathToHash = loadPathLog()
    console.log(`Loaded ${pathToHash.size} paths from disk`)
    if (pathToHash.size === 0) {
      clearInterval(heartbeat)
      await pool.end()
      throw new Error(`RESUME set but ${PATH_LOG} empty — cannot proceed without path list`)
    }
    // version ids for DB delete: re-list whatever still has rows
    const versionsRes = await pool.query<{ id: string }>(`
      SELECT av.id::text AS id
      FROM public.app_versions AS av
      WHERE av.deleted = true
        AND av.app_id NOT LIKE 'com.capdemo%'
        AND (
          av.manifest_count > 0
          OR EXISTS (SELECT 1 FROM public.manifest AS m WHERE m.app_version_id = av.id)
        )
    `)
    versionIds = versionsRes.rows.map(r => r.id)
    console.log(`Versions still holding DB rows: ${versionIds.length}`)
  }
  else {
    // Fresh run: wipe stale logs only if starting clean
    if (existsSync(PATH_LOG) || existsSync(DONE_LOG)) {
      console.log(`Note: existing ${PATH_LOG} / ${DONE_LOG} found. Use RECLAIM_RESUME=1 to continue, or delete them to start fresh.`)
      if (!process.env.RECLAIM_FORCE_FRESH) {
        clearInterval(heartbeat)
        await pool.end()
        throw new Error('Refusing to overwrite path logs. RECLAIM_RESUME=1 or RECLAIM_FORCE_FRESH=1')
      }
      writeFileSync(PATH_LOG, '')
      writeFileSync(DONE_LOG, '')
    }
    else {
      writeFileSync(PATH_LOG, '')
      writeFileSync(DONE_LOG, '')
    }

    console.log('1/4 Listing doomed versions...')
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
    versionIds = versionsRes.rows.map(r => r.id)
    hb.versionsTotal = versionIds.length
    console.log(`   versions=${versionIds.length}`)

    if (versionIds.length === 0) {
      clearInterval(heartbeat)
      await pool.end()
      console.log('Nothing to do.')
      return
    }

    const batches = chunk(versionIds, VERSION_BATCH)
    hb.batchesTotal = batches.length
    console.log(`2/4 SELECT + durable path log (BEFORE any DELETE) pool=${DB_POOL_SIZE}`)
    hb.phase = 'select-paths'
    hb.phaseStartedAt = Date.now()

    await mapPool(batches, DB_POOL_SIZE, async (ids, workerId) => {
      const pairs = await selectPathsBatch(pool, ids, hb, workerId)
      appendPathsDurable(pairs)
      for (const pair of pairs)
        pathToHash.set(pair.s3_path, pair.file_hash)
      hb.pathsCollected = pathToHash.size
      hb.batchesDone += 1
      hb.versionsDone += ids.length
      console.log(
        `[select] w${workerId} pairs=${pairs.length} total_paths=${pathToHash.size} versions ${hb.versionsDone}/${hb.versionsTotal}`,
      )
    })
    const fd = openSync(PATH_LOG, 'r')
    try {
      fsyncSync(fd)
    }
    finally {
      closeSync(fd)
    }
    console.log(`Path log durable: ${pathToHash.size} paths → ${PATH_LOG}`)
  }

  // 3) live filter + R2
  const done = loadDoneSet()
  const allHashes = [...new Set(pathToHash.values())]
  const liveHashes = await liveFilterHashes(pool, allHashes, hb)
  const toTrash = [...pathToHash.entries()]
    .filter(([path, hash]) => !liveHashes.has(hash) && !done.has(path))
    .map(([path]) => path)
  console.log(`3/4 R2 trash: remaining=${toTrash.length} already_done=${done.size} keep_live=${[...pathToHash.values()].filter(h => liveHashes.has(h)).length}`)

  if (toTrash.length > 0)
    await trashPaths(s3, bucket, toTrash, hb)
  else
    console.log('R2: nothing left to trash')

  // 4) DB delete ONLY after R2 success
  if (versionIds.length === 0) {
    console.log('4/4 No DB rows left (already cleared). Cleaning logs.')
  }
  else {
    console.log(`4/4 DB DELETE versions=${versionIds.length} (R2 finished with 0 failures)`)
    hb.phase = 'db-delete'
    hb.phaseStartedAt = Date.now()
    hb.versionsTotal = versionIds.length
    hb.versionsDone = 0
    hb.batchesDone = 0
    const batches = chunk(versionIds, VERSION_BATCH)
    hb.batchesTotal = batches.length
    await mapPool(batches, DB_POOL_SIZE, async (ids, workerId) => {
      const n = await deleteBatch(pool, ids, hb, workerId)
      hb.dbRows += n
      hb.batchesDone += 1
      hb.versionsDone += ids.length
      console.log(`[db] w${workerId} rows=${n} versions ${hb.versionsDone}/${hb.versionsTotal}`)
    })
  }

  // success: clear logs so next run is fresh
  writeFileSync(PATH_LOG, '')
  writeFileSync(DONE_LOG, '')
  truncateSync(PATH_LOG, 0)
  truncateSync(DONE_LOG, 0)

  clearInterval(heartbeat)
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await pool.end()
  console.log(`Done. Elapsed ${((Date.now() - hb.startedAt) / 60000).toFixed(2)} min db_rows=${hb.dbRows} r2_moved=${hb.r2Moved}`)
}

await main()
