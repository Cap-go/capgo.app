/**
 * Fast orphan cleanup for keys in .context/r2_manifest_orphans.txt
 *
 * DEFAULT MODE=delete — DeleteObjects batches of 1000 (orders of magnitude
 * faster than per-object copy+delete). Safe for unreferenced orphans.
 *
 * MODE=trash — old path: copy to deleted-after-7-days/ then delete live key.
 *
 * Kill-safe: per-shard done_*.txt (fsync), resume skips done keys.
 *
 *   bash scripts/run_trash_r2_orphans_sharded.sh
 *   MODE=trash bash scripts/run_trash_r2_orphans_sharded.sh
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { Agent as HttpsAgent } from 'node:https'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3'

const ENV_FILE = './internal/cloudflare/.env.prod'
const TRASH_PREFIX = 'deleted-after-7-days/'
const PATH_LOG = '.context/r2_manifest_orphans.txt'
const MODE = (process.env.MODE || 'delete').toLowerCase() // delete | trash
const R2_CONCURRENCY = Number(process.env.RECLAIM_R2_CONCURRENCY || (MODE === 'delete' ? 64 : 500))
const DELETE_BATCH = Number(process.env.RECLAIM_DELETE_BATCH || 1000)
const SHARD_COUNT = Math.max(1, Number(process.env.SHARD_COUNT || 1))
const SHARD_INDEX = Math.max(0, Number(process.env.SHARD_INDEX || 0))
const DONE_LOG = SHARD_COUNT > 1
  ? `.context/r2_manifest_orphans_done_${SHARD_INDEX}.txt`
  : '.context/r2_manifest_orphans_done.txt'
const FAIL_LOG = SHARD_COUNT > 1
  ? `.context/r2_manifest_orphans_failed_${SHARD_INDEX}.txt`
  : '.context/r2_manifest_orphans_failed.txt'
const STATE_FILE = SHARD_COUNT > 1
  ? `.context/r2_manifest_orphans_state_${SHARD_INDEX}.json`
  : '.context/r2_manifest_orphans_state.json'
const PROGRESS_LOG = SHARD_COUNT > 1
  ? `.context/r2_manifest_orphans_progress_${SHARD_INDEX}.log`
  : '.context/r2_manifest_orphans_progress.log'
const DONE_FLUSH_EVERY = Number(process.env.RECLAIM_DONE_FLUSH || 2000)
const HEARTBEAT_MS = Number(process.env.RECLAIM_HEARTBEAT_MS || 2000)

type State = {
  mode: string
  phase: string
  shard: string
  startedAt: string
  updatedAt: string
  totalCandidates: number
  remainingAtStart: number
  processed: number
  deleted: number
  moved: number
  missing: number
  skippedAlreadyDone: number
  failed: number
  ratePerSec: number
  etaMinutes: number | null
  concurrency: number
  pathLog: string
  doneLog: string
  lastError?: string
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

function ensureContext() {
  mkdirSync('.context', { recursive: true })
  for (const f of [DONE_LOG, FAIL_LOG, PROGRESS_LOG]) {
    if (!existsSync(f))
      writeFileSync(f, '')
  }
}

function loadLineSet(file: string): Set<string> {
  const set = new Set<string>()
  if (!existsSync(file))
    return set
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line)
      set.add(line)
  }
  return set
}

function loadAllDoneSets(): Set<string> {
  const set = loadLineSet('.context/r2_manifest_orphans_done.txt')
  for (const name of readdirSync('.context')) {
    if (name.startsWith('r2_manifest_orphans_done_') && name.endsWith('.txt')) {
      for (const line of loadLineSet(`.context/${name}`))
        set.add(line)
    }
  }
  return set
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

function writeState(state: State) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
}

function logProgress(line: string) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  console.log(stamped)
  appendFileSync(PROGRESS_LOG, `${stamped}\n`)
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const current = items[idx++]
      await fn(current)
    }
  }))
}

function shardHash(path: string): number {
  let h = 0
  for (let i = 0; i < path.length; i++)
    h = (h * 31 + path.charCodeAt(i)) >>> 0
  return h
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

async function deleteBatch(s3: S3Client, bucket: string, keys: string[]) {
  if (keys.length === 0)
    return { deleted: 0, errors: [] as Array<{ key: string, message: string }> }
  const res = await s3.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: {
      Objects: keys.map(Key => ({ Key })),
      Quiet: false,
    },
  }))
  const errors = (res.Errors ?? []).map(e => ({
    key: e.Key || '',
    message: `${e.Code || 'Error'}: ${e.Message || ''}`,
  }))
  const deleted = (res.Deleted?.length ?? 0)
  // S3 Quiet:false — missing keys often appear in Deleted anyway; treat Errors only as fail
  return { deleted: deleted || (keys.length - errors.length), errors }
}

async function main() {
  ensureContext()
  if (!existsSync(PATH_LOG) || readFileSync(PATH_LOG, 'utf8').trim() === '')
    throw new Error(`${PATH_LOG} empty`)

  if (MODE !== 'delete' && MODE !== 'trash')
    throw new Error(`MODE must be delete|trash, got ${MODE}`)

  const env = await loadEnv(ENV_FILE)
  const bucket = env.S3_BUCKET || 'capgo'
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
        maxSockets: Math.max(R2_CONCURRENCY * 2, 128),
        maxFreeSockets: 256,
      }),
      connectionTimeout: 10_000,
      requestTimeout: 120_000,
    }),
  })

  logProgress(`mode=${MODE} concurrency=${R2_CONCURRENCY} shard=${SHARD_INDEX}/${SHARD_COUNT} batch=${DELETE_BATCH}`)
  const done = loadAllDoneSets()
  const all = loadLineSet(PATH_LOG)
  let candidates = [...all].filter(path => !done.has(path) && !path.startsWith(TRASH_PREFIX))
  const skippedAlreadyDone = all.size - candidates.length
  if (SHARD_COUNT > 1)
    candidates = candidates.filter(path => (shardHash(path) % SHARD_COUNT) === SHARD_INDEX)

  const startedAtMs = Date.now()
  const state: State = {
    mode: MODE,
    phase: MODE === 'delete' ? 'r2-delete-batch' : 'r2-trash',
    shard: `${SHARD_INDEX}/${SHARD_COUNT}`,
    startedAt: new Date(startedAtMs).toISOString(),
    updatedAt: new Date().toISOString(),
    totalCandidates: all.size,
    remainingAtStart: candidates.length,
    processed: 0,
    deleted: 0,
    moved: 0,
    missing: 0,
    skippedAlreadyDone,
    failed: 0,
    ratePerSec: 0,
    etaMinutes: null,
    concurrency: R2_CONCURRENCY,
    pathLog: PATH_LOG,
    doneLog: DONE_LOG,
  }
  writeState(state)
  logProgress(`Ready: unique=${all.size} done=${done.size} shard_todo=${candidates.length}`)

  if (candidates.length === 0) {
    state.phase = 'done'
    writeState(state)
    logProgress('Nothing left for this shard.')
    return
  }

  const doneBuf: string[] = []
  const failBuf: string[] = []
  let lastFlush = Date.now()
  let stopping = false

  const flush = () => {
    if (doneBuf.length)
      appendLinesDurable(DONE_LOG, doneBuf.splice(0, doneBuf.length))
    if (failBuf.length)
      appendLinesDurable(FAIL_LOG, failBuf.splice(0, failBuf.length))
    lastFlush = Date.now()
  }

  const heartbeat = setInterval(() => {
    const elapsedSec = Math.max((Date.now() - startedAtMs) / 1000, 0.001)
    state.processed = state.deleted + state.moved + state.missing + state.failed
    state.ratePerSec = Math.round(state.processed / elapsedSec)
    const left = Math.max(candidates.length - state.processed, 0)
    state.etaMinutes = state.ratePerSec > 0 ? Math.round((left / state.ratePerSec) / 60) : null
    state.updatedAt = new Date().toISOString()
    writeState(state)
    logProgress(
      `shard=${SHARD_INDEX}/${SHARD_COUNT} mode=${MODE} processed=${state.processed}/${candidates.length} deleted=${state.deleted} moved=${state.moved} miss=${state.missing} fail=${state.failed} rate=${state.ratePerSec}/s eta_min=${state.etaMinutes ?? '?'}`,
    )
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const onSigInt = () => handleStop('SIGINT')
  const onSigTerm = () => handleStop('SIGTERM')
  function handleStop(signal: string) {
    if (stopping)
      return
    stopping = true
    logProgress(`Caught ${signal} — flushing done log`)
    clearInterval(heartbeat)
    flush()
    state.phase = 'interrupted'
    state.updatedAt = new Date().toISOString()
    writeState(state)
    logProgress('Resume: MODE=delete bash scripts/run_trash_r2_orphans_sharded.sh')
    process.exit(1)
  }
  process.once('SIGINT', onSigInt)
  process.once('SIGTERM', onSigTerm)

  if (MODE === 'delete') {
    const batches = chunk(candidates, DELETE_BATCH)
    await mapPool(batches, R2_CONCURRENCY, async (keys) => {
      if (stopping)
        return
      try {
        const result = await deleteBatch(s3, bucket, keys)
        state.deleted += result.deleted
        const errKeys = new Set(result.errors.map(e => e.key))
        for (const key of keys) {
          if (!errKeys.has(key))
            doneBuf.push(key)
        }
        for (const err of result.errors) {
          state.failed += 1
          failBuf.push(`${err.key}\t${err.message}`)
          doneBuf.push(err.key) // don't infinite loop
          if (state.failed <= 40)
            logProgress(`FAIL ${err.key}: ${err.message}`)
        }
      }
      catch (error: any) {
        state.failed += keys.length
        state.lastError = error?.message || String(error)
        for (const key of keys) {
          failBuf.push(`${key}\t${error?.message || error}`)
          doneBuf.push(key)
        }
        if (state.failed <= 40)
          logProgress(`BATCH FAIL n=${keys.length}: ${error?.message || error}`)
      }
      finally {
        if (doneBuf.length >= DONE_FLUSH_EVERY || Date.now() - lastFlush > 2000)
          flush()
      }
    })
  }
  else {
    await mapPool(candidates, R2_CONCURRENCY, async (path) => {
      if (stopping)
        return
      try {
        const result = await moveToTrashFast(s3, bucket, path)
        if (result === 'moved')
          state.moved += 1
        else
          state.missing += 1
        doneBuf.push(path)
      }
      catch (error: any) {
        state.failed += 1
        failBuf.push(`${path}\t${error?.message || error}`)
        doneBuf.push(path)
        if (state.failed <= 40)
          logProgress(`FAIL ${path}: ${error?.message || error}`)
      }
      finally {
        if (doneBuf.length >= DONE_FLUSH_EVERY || Date.now() - lastFlush > 2000)
          flush()
      }
    })
  }

  flush()
  clearInterval(heartbeat)
  process.off('SIGINT', onSigInt)
  process.off('SIGTERM', onSigTerm)

  state.phase = 'done'
  state.processed = state.deleted + state.moved + state.missing + state.failed
  state.ratePerSec = Math.round(state.processed / Math.max((Date.now() - startedAtMs) / 1000, 0.001))
  state.etaMinutes = 0
  state.updatedAt = new Date().toISOString()
  writeState(state)
  logProgress(
    `DONE shard=${SHARD_INDEX}/${SHARD_COUNT} mode=${MODE} deleted=${state.deleted} moved=${state.moved} miss=${state.missing} fail=${state.failed} elapsed_min=${((Date.now() - startedAtMs) / 60000).toFixed(2)} rate=${state.ratePerSec}/s`,
  )
  if (state.failed > 0)
    process.exitCode = 2
}

await main()
