import type { SnippetEdgeReplay } from './snippetEdgeAnswer.ts'
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
 */
export const SNIPPET_EDGE_STAT_HEADER = 'x-capgo-edge-stat'
/** Per replay message: Analytics Engine allows 250 data points per invocation. */
const MAX_POINTS_PER_CHUNK = 200
/** Queue messages are limited to 128 KB. */
const MAX_BYTES_PER_CHUNK = 100_000
/** sendBatch: at most 100 messages and 256 KB per call. */
const MAX_MESSAGES_PER_SEND = 100
const MAX_BYTES_PER_SEND = 240_000
const REPLAY_CONCURRENCY = 8
/** Analytics Engine points one replayed event can write: APP_LOG, DEVICE_USAGE, DEVICE_INFO, VERSION_USAGE. */
const POINTS_PER_EVENT = 4

export interface SnippetEdgeStatRecord {
  /** 'updates' | 'stats' */
  e: 'updates' | 'stats'
  /** Raw request body. */
  b: string
  /** /updates answer: owner org, allow custom id, served bundle. */
  o?: string
  a?: boolean
  n?: string
  ip?: string
  country?: string
}

function base64UrlDecode(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** `X-Capgo-Edge-Stat` value: base64url(JSON { e, b, o?, a?, n? }), written by the snippet. */
export function decodeSnippetEdgeStat(value: string): SnippetEdgeStatRecord | null {
  try {
    const parsed = JSON.parse(base64UrlDecode(value)) as Partial<SnippetEdgeStatRecord>
    if ((parsed.e !== 'updates' && parsed.e !== 'stats') || typeof parsed.b !== 'string')
      return null
    if (parsed.e === 'updates' && (typeof parsed.o !== 'string' || typeof parsed.n !== 'string'))
      return null
    return {
      e: parsed.e,
      b: parsed.b,
      ...(parsed.e === 'updates' ? { o: parsed.o, a: parsed.a === true, n: parsed.n } : {}),
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

export function recordSize(record: SnippetEdgeStatRecord) {
  return JSON.stringify(record).length
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
    const size = chunk.reduce((sum, record) => sum + recordSize(record), 0)
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
}

export function isSnippetEdgeReplayMessage(body: unknown): body is SnippetEdgeReplayMessage {
  return Boolean(body && typeof body === 'object' && Array.isArray((body as SnippetEdgeReplayMessage).snippetEdgeStats))
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
  const request = new Request(`https://plugin.capgo.app/${record.e}`, {
    method: 'POST',
    headers,
    body: record.b,
  })
  // Stats read the device country from request.cf.
  Object.defineProperty(request, 'cf', { value: { country: record.country }, configurable: true })
  const replay: SnippetEdgeReplay = record.e === 'updates'
    ? { endpoint: 'updates', updates: { ownerOrg: record.o!, allowDeviceCustomId: record.a === true, versionName: record.n! } }
    : { endpoint: 'stats' }
  markSnippetEdgeReplay(request, replay)
  return request
}

type FetchHandler = (request: Request) => Response | Promise<Response>

/** Replays one chunk through the plugin app. Failures are counted, not retried: the stats are best effort. */
export async function replaySnippetEdgeRecords(records: SnippetEdgeStatRecord[], fetchHandler: FetchHandler) {
  let failed = 0
  let next = 0
  async function worker() {
    while (next < records.length) {
      const record = records[next++]!
      try {
        const response = await fetchHandler(buildReplayRequest(record))
        if (response.status >= 500)
          failed++
        // Release the body: nobody reads the replay answer.
        await response.body?.cancel()
      }
      catch {
        failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REPLAY_CONCURRENCY, records.length) }, worker))
  return { replayed: records.length, failed }
}
