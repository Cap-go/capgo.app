/**
 * Rediscover R2 delta objects not referenced by public.manifest, then trash them.
 *
 * Safe after reclaim wiped deleted-version manifest rows: orphans are rediscoverable
 * by listing orgs/{org}/apps/{app}/delta/ and subtracting that app's live s3_paths.
 *
 * Usage:
 *   FIND_ONLY=1 bun scripts/find_and_trash_r2_manifest_orphans.ts
 *   TRASH_ONLY=1 bun scripts/find_and_trash_r2_manifest_orphans.ts
 *   bun scripts/find_and_trash_r2_manifest_orphans.ts
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, fsyncSync } from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import pg from 'pg'

const ENV_FILE = './internal/cloudflare/.env.prod'
const TRASH_PREFIX = 'deleted-after-7-days/'
const PATH_LOG = '.context/r2_manifest_orphans.txt'
const DONE_LOG = '.context/r2_manifest_orphans_done.txt'
const R2_CONCURRENCY = Number(process.env.RECLAIM_R2_CONCURRENCY || 600)
const APP_CONCURRENCY = Number(process.env.RECLAIM_APP_CONCURRENCY || 24)
const FIND_ONLY = process.env.FIND_ONLY === '1'
const TRASH_ONLY = process.env.TRASH_ONLY === '1'
const HEARTBEAT_MS = 2000

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

function cleanDbUrl(databaseUrl: string) {
  const parsed = new URL(databaseUrl)
  parsed.searchParams.delete('sslmode')
  parsed.searchParams.delete('sslrootcert')
  return parsed.toString()
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  if (items.length === 0)
    return
  let idx = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const cur = items[idx++]
      await fn(cur)
    }
  }))
}

function formatRate(count: number, startedAt: number) {
  const elapsedSec = Math.max((Date.now() - startedAt) / 1000, 0.001)
  return `${Math.round(count / elapsedSec)}/s`
}

function ensureContext() {
  mkdirSync('.context', { recursive: true })
}

function appendLinesDurable(file: string, lines: string[]) {
  if (lines.length === 0)
    return
  const fd = openSync(file, 'a')
  try {
    appendFileSync(fd, `${lines.join('\n')}\n`)
    fsyncSync(fd)
  }
  finally {
    closeSync(fd)
  }
}

function loadLines(file: string): Set<string> {
  const set = new Set<string>()
  if (!existsSync(file))
    return set
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line)
      set.add(line)
  }
  return set
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    }
    catch (error) {
      last = error
      const wait = Math.min(1000 * 2 ** (i - 1), 15000)
      console.error(`retry ${label} ${i}/${attempts} wait=${wait}ms`, error)
      await Bun.sleep(wait)
    }
  }
  throw last
}

async function listAllKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  while (true) {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }))
    for (const obj of res.Contents ?? []) {
      if (obj.Key && !obj.Key.endsWith('/'))
        keys.push(obj.Key)
    }
    if (!res.IsTruncated)
      break
    token = res.NextContinuationToken
  }
  return keys
}

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

async function livePathsForApp(pool: pg.Pool, appId: string): Promise<Set<string>> {
  const res = await pool.query<{ s3_path: string }>(`
    SELECT m.s3_path
    FROM public.manifest AS m
    INNER JOIN public.app_versions AS av
      ON av.id = m.app_version_id
     AND av.deleted = false
    WHERE av.app_id = $1
      AND m.s3_path IS NOT NULL
      AND m.s3_path <> ''
  `, [appId])
  return new Set(res.rows.map(r => r.s3_path))
}

async function main() {
  const env = await loadEnv(ENV_FILE)
  ensureContext()
  const bucket = env.S3_BUCKET || 'capgo'
  const databaseUrl = cleanDbUrl(env.MAIN_SUPABASE_DB_URL || env.DATABASE_URL)
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: APP_CONCURRENCY,
    allowExitOnIdle: true,
  })
  pool.on('connect', (c) => {
    c.query(`SET statement_timeout = '0'`).catch(() => {})
  })

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
        maxSockets: Math.max(R2_CONCURRENCY, APP_CONCURRENCY * 4),
        maxFreeSockets: 256,
      }),
      connectionTimeout: 10_000,
      requestTimeout: 120_000,
    }),
  })

  const startedAt = Date.now()
  let phase = 'init'
  let detail = ''
  let listed = 0
  let orphans = 0
  let appsDone = 0
  let appsTotal = 0
  let r2Done = 0
  let r2Total = 0
  let r2Moved = 0
  let r2Missing = 0
  let r2Failed = 0
  let r2Started = Date.now()

  const hb = setInterval(() => {
    console.log(`[hb t+${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${phase} | ${detail} | apps ${appsDone}/${appsTotal} listed=${listed} orphans=${orphans} | r2 ${r2Done}/${r2Total} moved=${r2Moved} miss=${r2Missing} fail=${r2Failed} ${r2Done ? formatRate(r2Done, r2Started) : ''}`)
  }, HEARTBEAT_MS)
  hb.unref?.()

  if (!TRASH_ONLY) {
    phase = 'load-apps'
    const appsRes = await pool.query<{ owner_org: string, app_id: string }>(`
      SELECT DISTINCT av.owner_org::text AS owner_org, av.app_id
      FROM public.app_versions AS av
      WHERE av.deleted = true
        AND av.app_id NOT LIKE 'com.capdemo%'
        AND av.owner_org IS NOT NULL
    `)
    const apps = appsRes.rows
    appsTotal = apps.length
    console.log(`Apps with deleted versions: ${apps.length}`)

    writeFileSync(PATH_LOG, '')
    if (!existsSync(DONE_LOG))
      writeFileSync(DONE_LOG, '')

    phase = 'list-diff'
    detail = `app concurrency=${APP_CONCURRENCY}`
    // Serialize durable writes (workers still list/query in parallel)
    let writeChain: Promise<void> = Promise.resolve()
    const writeOrphans = (paths: string[]) => {
      if (paths.length === 0)
        return
      writeChain = writeChain.then(() => {
        appendLinesDurable(PATH_LOG, paths)
      })
      return writeChain
    }

    await mapPool(apps, APP_CONCURRENCY, async (app) => {
      const prefix = `orgs/${app.owner_org}/apps/${app.app_id}/delta/`
      try {
        const [keys, live] = await Promise.all([
          withRetry(`list ${prefix}`, () => listAllKeys(s3, bucket, prefix)),
          withRetry(`db ${app.app_id}`, () => livePathsForApp(pool, app.app_id)),
        ])
        listed += keys.length
        const appOrphans: string[] = []
        for (const key of keys) {
          if (!live.has(key))
            appOrphans.push(key)
        }
        orphans += appOrphans.length
        await writeOrphans(appOrphans)
      }
      catch (error) {
        console.error(`app fail ${app.app_id}`, error)
      }
      finally {
        appsDone += 1
        detail = `last=${app.app_id}`
      }
    })
    await writeChain

    console.log(`FIND done: listed=${listed} orphans=${orphans} → ${PATH_LOG}`)
    if (FIND_ONLY) {
      clearInterval(hb)
      await pool.end()
      return
    }
  }

  phase = 'r2-trash'
  r2Started = Date.now()
  const done = loadLines(DONE_LOG)
  const allOrphans = [...loadLines(PATH_LOG)].filter(p => !done.has(p))
  r2Total = allOrphans.length
  console.log(`Trash candidates: ${r2Total} (already_done=${done.size})`)
  detail = `concurrency=${R2_CONCURRENCY}`

  const doneBuf: string[] = []
  await mapPool(allOrphans, R2_CONCURRENCY, async (path) => {
    try {
      const result = await moveToTrashFast(s3, bucket, path)
      if (result === 'moved')
        r2Moved += 1
      else if (result === 'missing')
        r2Missing += 1
      doneBuf.push(path)
    }
    catch (error) {
      r2Failed += 1
      if (r2Failed <= 20)
        console.error(`trash fail ${path}`, error)
    }
    finally {
      r2Done += 1
      if (doneBuf.length >= 500) {
        const flush = doneBuf.splice(0, doneBuf.length)
        appendLinesDurable(DONE_LOG, flush)
      }
    }
  })
  if (doneBuf.length)
    appendLinesDurable(DONE_LOG, doneBuf)

  clearInterval(hb)
  await pool.end()
  console.log(`Done. moved=${r2Moved} missing=${r2Missing} failed=${r2Failed} elapsed_min=${((Date.now() - startedAt) / 60000).toFixed(2)}`)
  if (r2Failed > 0)
    process.exitCode = 1
}

await main()
