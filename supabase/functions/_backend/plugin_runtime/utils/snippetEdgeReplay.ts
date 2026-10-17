import type { Queue, R2Bucket } from '@cloudflare/workers-types'
import type { SnippetEdgeReplay } from './snippetEdgeAnswer.ts'
import { cloudlog } from './logging.ts'
import { markSnippetEdgeReplay } from './snippetEdgeAnswer.ts'

/**
 * Stats of the requests the Cloudflare Snippet answered without a worker
 * (snippetEdgeAnswer.ts).
 *
 * Every snippet answer carries `X-Capgo-Edge-Stat`. A zone Logpush job
 * (http_requests, custom response field `x-capgo-edge-stat`) writes those
 * lines to R2, R2 event notifications queue each file, and the plugin
 * worker's queue consumer:
 * 1. reads the file and splits the stat lines into chunks (one replay queue
 *    message each), sized to Analytics Engine's 250 data points per invocation
 * 2. replays every chunk in its own invocation through the plugin app, in
 *    process: /stats runs its normal handler, /updates only writes the stats
 *    of the up-to-date answer the snippet gave (recordSnippetUpToDate)
 *
 * Delivery is at least once, without a dedupe store: a file is deleted once
 * all its chunks are queued (a repeated notification then finds nothing), a
 * failed send resumes from the failed group, and only the records that failed
 * a replay are queued again.
 */
export const SNIPPET_EDGE_STAT_HEADER = 'x-capgo-edge-stat'
/** Per replay message: Analytics Engine allows 250 data points per invocation. */
const MAX_POINTS_PER_CHUNK = 200
/** Queue messages are limited to 128 KB (UTF-8 bytes of the serialized body). */
const MAX_BYTES_PER_CHUNK = 100_000
/** sendBatch: at most 100 messages and 256 KB per call. */
const MAX_MESSAGES_PER_SEND = 100
const MAX_BYTES_PER_SEND = 240_000
const REPLAY_CONCURRENCY = 8
/** Replays of a record that failed (5xx or a throw), including the first one. */
export const MAX_REPLAY_ATTEMPTS = 3
/** Analytics Engine points one replayed event can write: APP_LOG, DEVICE_USAGE, DEVICE_INFO, VERSION_USAGE. */
const POINTS_PER_EVENT = 4

export interface SnippetEdgeStatRecord {
  /** 'updates' | 'stats' */
  e: 'updates' | 'stats'
  /** Raw request body. */
  b: string
  /** /updates answer: the bundle the snippet said is current. */
  n?: string
  ip?: string
  country?: string
  /** Unix ms of the snippet answer. */
  t?: number
}

function base64UrlDecode(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** `X-Capgo-Edge-Stat` value: base64url(JSON { e, b, n? }), written by the snippet. */
export function decodeSnippetEdgeStat(value: string): SnippetEdgeStatRecord | null {
  try {
    const parsed = JSON.parse(base64UrlDecode(value)) as Partial<SnippetEdgeStatRecord>
    if ((parsed.e !== 'updates' && parsed.e !== 'stats') || typeof parsed.b !== 'string')
      return null
    if (parsed.e === 'updates' && typeof parsed.n !== 'string')
      return null
    return {
      e: parsed.e,
      b: parsed.b,
      ...(parsed.e === 'updates' ? { n: parsed.n } : {}),
    }
  }
  catch {
    return null
  }
}

function headerValue(headers: unknown) {
  if (!headers || typeof headers !== 'object')
    return null
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === SNIPPET_EDGE_STAT_HEADER && typeof value === 'string' && value)
      return value
  }
  return null
}

export interface LogpushReadStats {
  /** Lines with a stat header that does not decode (e.g. truncated by Logpush): their stats are lost. */
  invalid: number
}

/** One Logpush http_requests line (NDJSON) -> stat record, or null when the snippet did not answer it. */
export function parseLogpushLine(line: string, stats?: LogpushReadStats): SnippetEdgeStatRecord | null {
  // Most lines are worker-served requests: skip them before JSON.parse.
  if (!line.includes(SNIPPET_EDGE_STAT_HEADER))
    return null
  try {
    const row = JSON.parse(line) as Record<string, unknown>
    const value = headerValue(row.ResponseHeaders)
    if (!value)
      return null
    const record = decodeSnippetEdgeStat(value)
    if (!record) {
      if (stats)
        stats.invalid++
      return null
    }
    if (typeof row.ClientIP === 'string' && row.ClientIP)
      record.ip = row.ClientIP
    if (typeof row.ClientCountry === 'string' && row.ClientCountry)
      record.country = row.ClientCountry.toUpperCase()
    // timestamp_format unixnano: ms precision survives the float parse.
    const startNs = Number(row.EdgeStartTimestamp)
    if (Number.isFinite(startNs) && startNs > 0)
      record.t = Math.floor(startNs / 1e6)
    return record
  }
  catch {
    if (stats)
      stats.invalid++
    return null
  }
}

export async function* readLogpushRecords(stream: ReadableStream<Uint8Array>, gzip: boolean, stats?: LogpushReadStats): AsyncGenerator<SnippetEdgeStatRecord> {
  const bytes = gzip ? stream.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>) : stream
  const text = bytes.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
  let buffered = ''
  for await (const part of text as unknown as AsyncIterable<string>) {
    buffered += part
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      const record = parseLogpushLine(buffered.slice(0, newline), stats)
      buffered = buffered.slice(newline + 1)
      if (record)
        yield record
      newline = buffered.indexOf('\n')
    }
  }
  const record = buffered ? parseLogpushLine(buffered, stats) : null
  if (record)
    yield record
}

function estimatePoints(record: SnippetEdgeStatRecord) {
  if (record.e === 'updates')
    return POINTS_PER_EVENT
  // Snippet answers single events and batches; a batch body starts with '['.
  if (!record.b.trimStart().startsWith('['))
    return POINTS_PER_EVENT
  try {
    const events = JSON.parse(record.b)
    return Math.max(1, Array.isArray(events) ? events.length : 1) * POINTS_PER_EVENT
  }
  catch {
    return POINTS_PER_EVENT
  }
}

const utf8 = new TextEncoder()

/** Queue limits count UTF-8 bytes: a JS string length undercounts non-ASCII text up to 3x. */
export function recordSize(record: SnippetEdgeStatRecord) {
  return utf8.encode(JSON.stringify(record)).byteLength
}

/** Groups records into replay messages under the Analytics Engine and queue message limits. */
export function chunkSnippetEdgeRecords(records: Iterable<SnippetEdgeStatRecord>) {
  const chunks: SnippetEdgeStatRecord[][] = []
  let current: SnippetEdgeStatRecord[] = []
  let points = 0
  let bytes = 0
  for (const record of records) {
    const recordPoints = estimatePoints(record)
    const size = recordSize(record)
    // A record bigger than a whole chunk cannot be replayed within the limits.
    if (recordPoints > MAX_POINTS_PER_CHUNK || size > MAX_BYTES_PER_CHUNK)
      continue
    if (current.length > 0 && (points + recordPoints > MAX_POINTS_PER_CHUNK || bytes + size > MAX_BYTES_PER_CHUNK)) {
      chunks.push(current)
      current = []
      points = 0
      bytes = 0
    }
    current.push(record)
    points += recordPoints
    bytes += size
  }
  if (current.length > 0)
    chunks.push(current)
  return chunks
}

/** Splits replay messages into sendBatch calls (100 messages, 256 KB). */
export function groupForSendBatch(chunks: SnippetEdgeStatRecord[][]) {
  const groups: SnippetEdgeStatRecord[][][] = []
  let current: SnippetEdgeStatRecord[][] = []
  let bytes = 0
  for (const chunk of chunks) {
    const size = utf8.encode(JSON.stringify({ snippetEdgeStats: chunk })).byteLength
    if (current.length > 0 && (current.length >= MAX_MESSAGES_PER_SEND || bytes + size > MAX_BYTES_PER_SEND)) {
      groups.push(current)
      current = []
      bytes = 0
    }
    current.push(chunk)
    bytes += size
  }
  if (current.length > 0)
    groups.push(current)
  return groups
}

export interface SnippetEdgeReplayMessage {
  snippetEdgeStats: SnippetEdgeStatRecord[]
  /** Replays already done for these records (absent on the first one). */
  attempt?: number
}

export function isSnippetEdgeReplayMessage(body: unknown): body is SnippetEdgeReplayMessage {
  return Boolean(body && typeof body === 'object' && Array.isArray((body as SnippetEdgeReplayMessage).snippetEdgeStats))
}

/** Rest of a Logpush file whose sendBatch failed part way: resume from `fromGroup`. */
export interface SnippetEdgeFileResumeMessage {
  snippetEdgeStatsFile: string
  fromGroup: number
}

export function isSnippetEdgeFileResumeMessage(body: unknown): body is SnippetEdgeFileResumeMessage {
  return Boolean(body && typeof body === 'object'
    && typeof (body as SnippetEdgeFileResumeMessage).snippetEdgeStatsFile === 'string'
    && Number.isInteger((body as SnippetEdgeFileResumeMessage).fromGroup))
}

/** R2 event notification body (object-create on the Logpush bucket). */
export function getR2NotificationObjectKey(body: unknown): string | null {
  if (!body || typeof body !== 'object')
    return null
  const { action, object } = body as { action?: string, object?: { key?: unknown } }
  if (action && !action.startsWith('PutObject') && !action.startsWith('CompleteMultipartUpload') && !action.startsWith('CopyObject'))
    return null
  return typeof object?.key === 'string' ? object.key : null
}

export function buildReplayRequest(record: SnippetEdgeStatRecord) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (record.ip)
    headers.set('cf-connecting-ip', record.ip)
  // Stats read the device country from request.cf: workerd takes it from the init.
  const cf = { country: record.country }
  const request = new Request(`https://plugin.capgo.app/${record.e}`, {
    method: 'POST',
    headers,
    body: record.b,
    cf,
  } as RequestInit)
  if ((request as { cf?: unknown }).cf === undefined)
    Object.defineProperty(request, 'cf', { value: cf, configurable: true })
  const replay: SnippetEdgeReplay = record.e === 'updates'
    ? { endpoint: 'updates', updates: { versionName: record.n! }, eventTime: record.t }
    : { endpoint: 'stats', eventTime: record.t }
  markSnippetEdgeReplay(request, replay)
  return request
}

type FetchHandler = (request: Request) => Response | Promise<Response>

/** Events the handler refused: a 4xx, an error body, or non-ok results of a batch. */
async function countRejected(response: Response) {
  if (response.status >= 400)
    return 1
  const body = await response.json().catch(() => null) as { error?: unknown, results?: { status?: string }[] } | null
  if (body?.error)
    return 1
  return Array.isArray(body?.results) ? body.results.filter(result => result?.status !== 'ok').length : 0
}

/**
 * Replays one chunk through the plugin app. Returns the records that failed
 * (5xx or a throw: worth another attempt) and counts what the handler
 * rejected (a client error a retry would not change).
 */
export async function replaySnippetEdgeRecords(records: SnippetEdgeStatRecord[], fetchHandler: FetchHandler) {
  const failed: SnippetEdgeStatRecord[] = []
  let rejected = 0
  let next = 0
  async function worker() {
    while (next < records.length) {
      const record = records[next++]!
      try {
        const response = await fetchHandler(buildReplayRequest(record))
        if (response.status >= 500) {
          failed.push(record)
          await response.body?.cancel()
          continue
        }
        // Await first: `rejected += await` would add to a stale value read by another worker.
        const count = await countRejected(response)
        rejected += count
      }
      catch {
        failed.push(record)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REPLAY_CONCURRENCY, records.length) }, worker))
  return { replayed: records.length - failed.length, failed, rejected }
}

export interface SnippetEdgeStatsEnv {
  SNIPPET_EDGE_STATS_LOGS?: R2Bucket
  SNIPPET_EDGE_STATS_REPLAY?: Queue
}

/** Delay before failed records are replayed again, or a failed file send resumes. */
const REPLAY_RETRY_DELAY_SECONDS = 60

/**
 * Logpush file -> replay messages. Chunking is deterministic, so a failed send
 * resumes from its group instead of queuing the groups already sent again.
 * The file is deleted once fully queued: a repeated R2 notification then finds
 * nothing to replay.
 */
export async function enqueueSnippetEdgeStatsFile(env: SnippetEdgeStatsEnv, key: string, fromGroup = 0) {
  if (!env.SNIPPET_EDGE_STATS_LOGS || !env.SNIPPET_EDGE_STATS_REPLAY)
    throw new Error('Snippet edge stats bindings are missing')
  const object = await env.SNIPPET_EDGE_STATS_LOGS.get(key)
  if (!object)
    return { missing: true, records: 0, chunks: 0, invalid: 0 }
  const records = []
  const stats = { invalid: 0 }
  for await (const record of readLogpushRecords(object.body as unknown as ReadableStream<Uint8Array>, key.endsWith('.gz'), stats))
    records.push(record)
  const chunks = chunkSnippetEdgeRecords(records)
  const groups = groupForSendBatch(chunks)
  for (let index = fromGroup; index < groups.length; index++) {
    try {
      await env.SNIPPET_EDGE_STATS_REPLAY.sendBatch(groups[index]!.map(chunk => ({ body: { snippetEdgeStats: chunk } })))
    }
    catch (error) {
      // A throw here retries the whole message: the groups before `index` would be sent twice.
      const resume: SnippetEdgeFileResumeMessage = { snippetEdgeStatsFile: key, fromGroup: index }
      await env.SNIPPET_EDGE_STATS_REPLAY.send(resume, { delaySeconds: REPLAY_RETRY_DELAY_SECONDS })
      return { missing: false, records: records.length, chunks: chunks.length, invalid: stats.invalid, resumeFromGroup: index, error: String(error) }
    }
  }
  await env.SNIPPET_EDGE_STATS_LOGS.delete(key).catch(() => undefined)
  return { missing: false, records: records.length, chunks: chunks.length, invalid: stats.invalid }
}

/**
 * One message of either queue: an R2 notification (new Logpush file), the
 * rest of a file, or a chunk to replay. Throws only when the message itself
 * must be retried.
 */
export async function handleSnippetEdgeStatsMessage(env: SnippetEdgeStatsEnv, requestId: string, body: unknown, fetchHandler: FetchHandler) {
  if (isSnippetEdgeReplayMessage(body)) {
    const attempt = (body.attempt ?? 0) + 1
    const result = await replaySnippetEdgeRecords(body.snippetEdgeStats, fetchHandler)
    const retry = result.failed.length > 0 && attempt < MAX_REPLAY_ATTEMPTS
    // Only the failed records go back: a retry of the message would replay the others twice.
    if (retry) {
      const next: SnippetEdgeReplayMessage = { snippetEdgeStats: result.failed, attempt }
      await env.SNIPPET_EDGE_STATS_REPLAY!.send(next, { delaySeconds: REPLAY_RETRY_DELAY_SECONDS })
    }
    if (result.failed.length > 0 || result.rejected > 0) {
      cloudlog({
        requestId,
        message: 'snippet edge stats replay failures',
        replayed: result.replayed,
        failed: result.failed.length,
        rejected: result.rejected,
        attempt,
        dropped: retry ? 0 : result.failed.length,
      })
    }
    return
  }
  if (isSnippetEdgeFileResumeMessage(body)) {
    const result = await enqueueSnippetEdgeStatsFile(env, body.snippetEdgeStatsFile, body.fromGroup)
    cloudlog({ requestId, message: 'snippet edge stats file resumed', key: body.snippetEdgeStatsFile, fromGroup: body.fromGroup, ...result })
    return
  }
  const key = getR2NotificationObjectKey(body)
  if (key) {
    const result = await enqueueSnippetEdgeStatsFile(env, key)
    cloudlog({ requestId, message: result.missing ? 'snippet edge stats file already replayed or expired' : 'snippet edge stats file queued', key, ...result })
  }
}
