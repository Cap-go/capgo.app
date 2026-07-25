/**
 * Trash R2 manifest orphans already listed in .context/r2_manifest_orphans.txt
 * (keys not referenced by live public.manifest).
 *
 * Kill-safe / resumable:
 *   - Never truncates the orphan path list
 *   - Appends finished keys to .context/r2_manifest_orphans_done.txt (fsync)
 *   - Writes .context/r2_manifest_orphans_state.json every heartbeat
 *   - On restart, skips keys already in the done log
 *
 * Fast path:
 *   - No HEAD
 *   - Copy → deleted-after-7-days/ then DeleteObject
 *   - High concurrency + keep-alive sockets
 *
 * Usage:
 *   bun scripts/trash_r2_manifest_orphans.ts
 *   RECLAIM_R2_CONCURRENCY=800 bun scripts/trash_r2_manifest_orphans.ts
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
import { CopyObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'

const ENV_FILE = './internal/cloudflare/.env.prod'
const TRASH_PREFIX = 'deleted-after-7-days/'
const PATH_LOG = '.context/r2_manifest_orphans.txt'
const DONE_LOG = '.context/r2_manifest_orphans_done.txt'
const FAIL_LOG = '.context/r2_manifest_orphans_failed.txt'
const STATE_FILE = process.env.SHARD_COUNT && Number(process.env.SHARD_COUNT) > 1
  ? `.context/r2_manifest_orphans_state_${process.env.SHARD_INDEX || 0}.json`
  : '.context/r2_manifest_orphans_state.json'
const PROGRESS_LOG = '.context/r2_manifest_orphans_progress.log'
const R2_CONCURRENCY = Number(process.env.RECLAIM_R2_CONCURRENCY || 500)
const DONE_FLUSH_EVERY = Number(process.env.RECLAIM_DONE_FLUSH || 500)
const HEARTBEAT_MS = Number(process.env.RECLAIM_HEARTBEAT_MS || 2000)

type State = {
  phase: string
  startedAt: string
  updatedAt: string
  totalCandidates: number
  remainingAtStart: number
  processed: number
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
  if (!existsSync(DONE_LOG))
    writeFileSync(DONE_LOG, '')
  if (!existsSync(FAIL_LOG))
    writeFileSync(FAIL_LOG, '')
  if (!existsSync(PROGRESS_LOG))
    writeFileSync(PROGRESS_LOG, '')
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
  // merge any shard done files
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

async function main() {
  ensureContext()
  if (!existsSync(PATH_LOG) || readFileSync(PATH_LOG, 'utf8').trim() === '') {
    throw new Error(`${PATH_LOG} is empty. Run FIND first (FIND_ONLY=1 bun scripts/find_and_trash_r2_manifest_orphans.ts) without wiping the log.`)
  }

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
        maxSockets: R2_CONCURRENCY,
        maxFreeSockets: 256,
      }),
      connectionTimeout: 10_000,
      requestTimeout: 60_000,
    }),
  })

  logProgress(`Loading path/done logs (concurrency=${R2_CONCURRENCY} shard=${SHARD_INDEX}/${SHARD_COUNT})...`)
  const done = loadAllDoneSets()
  const all = loadLineSet(PATH_LOG) // dedupe
  let candidates = [...all].filter(path => !done.has(path) && !path.startsWith(TRASH_PREFIX))
  const skippedAlreadyDone = all.size - candidates.length
  if (SHARD_COUNT > 1) {
    candidates = candidates.filter((path) => {
      let h = 0
      for (let i = 0; i < path.length; i++)
        h = (h * 31 + path.charCodeAt(i)) >>> 0
      return (h % SHARD_COUNT) === SHARD_INDEX
    })
  }

  const startedAtMs = Date.now()
  const state: State = {
    phase: 'r2-trash',
    startedAt: new Date(startedAtMs).toISOString(),
    updatedAt: new Date().toISOString(),
    totalCandidates: all.size,
    remainingAtStart: candidates.length,
    processed: 0,
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

  logProgress(`Ready: unique_paths=${all.size} already_done=${done.size} shard_to_trash=${candidates.length} shard=${SHARD_INDEX}/${SHARD_COUNT}`)
  if (candidates.length === 0) {
    state.phase = 'done'
    writeState(state)
    logProgress('Nothing left to trash.')
    return
  }

  const doneBuf: string[] = []
  const failBuf: string[] = []
  let lastFlush = Date.now()
  let stopping = false

  const flush = () => {
    if (doneBuf.length) {
      const chunk = doneBuf.splice(0, doneBuf.length)
      appendLinesDurable(DONE_LOG, chunk)
    }
    if (failBuf.length) {
      const chunk = failBuf.splice(0, failBuf.length)
      appendLinesDurable(FAIL_LOG, chunk)
    }
    lastFlush = Date.now()
  }

  const heartbeat = setInterval(() => {
    const elapsedSec = Math.max((Date.now() - startedAtMs) / 1000, 0.001)
    state.processed = state.moved + state.missing + state.failed
    state.ratePerSec = Math.round(state.processed / elapsedSec)
    const left = candidates.length - state.processed
    state.etaMinutes = state.ratePerSec > 0 ? Math.round((left / state.ratePerSec) / 60) : null
    state.updatedAt = new Date().toISOString()
    writeState(state)
    logProgress(
      `phase=${state.phase} processed=${state.processed}/${candidates.length} moved=${state.moved} missing=${state.missing} failed=${state.failed} rate=${state.ratePerSec}/s eta_min=${state.etaMinutes ?? '?'}`,
    )
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const onSigInt = () => handleStop('SIGINT')
  const onSigTerm = () => handleStop('SIGTERM')
  function handleStop(signal: string) {
    if (stopping)
      return
    stopping = true
    logProgress(`Caught ${signal} — flushing durable done log then exit`)
    clearInterval(heartbeat)
    flush()
    state.phase = 'interrupted'
    state.updatedAt = new Date().toISOString()
    writeState(state)
    logProgress(`Interrupted safely. Resume with: bun scripts/trash_r2_manifest_orphans.ts`)
    process.exit(1)
  }
  process.once('SIGINT', onSigInt)
  process.once('SIGTERM', onSigTerm)

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
      state.lastError = `${path}: ${error?.message || error}`
      failBuf.push(`${path}\t${error?.message || error}`)
      if (state.failed <= 30)
        logProgress(`FAIL ${path}: ${error?.message || error}`)
      // still mark done so we don't infinite-loop poison keys; they stay in FAIL_LOG
      doneBuf.push(path)
    }
    finally {
      if (doneBuf.length >= DONE_FLUSH_EVERY || Date.now() - lastFlush > 3000)
        flush()
    }
  })

  flush()
  clearInterval(heartbeat)
  process.off('SIGINT', onSigInt)
  process.off('SIGTERM', onSigTerm)

  state.phase = 'done'
  state.processed = state.moved + state.missing + state.failed
  state.ratePerSec = Math.round(state.processed / Math.max((Date.now() - startedAtMs) / 1000, 0.001))
  state.etaMinutes = 0
  state.updatedAt = new Date().toISOString()
  writeState(state)

  logProgress(
    `DONE moved=${state.moved} missing=${state.missing} failed=${state.failed} elapsed_min=${((Date.now() - startedAtMs) / 60000).toFixed(2)} rate=${state.ratePerSec}/s`,
  )
  if (state.failed > 0)
    process.exitCode = 2
}

await main()
