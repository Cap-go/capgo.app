import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { ONBOARDING_MESSAGES_PER_MINUTE } from '../utils/app_onboarding_refresh.ts'
import { sendDiscordAlert } from '../utils/discord.ts'
import { BRES, middlewareAPISecret, parseBody, simpleError } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
// --- Worker logic imports ---
import { integerLikeSchema, safeParseSchema } from '../utils/schema_validation.ts'
import { backgroundTask, getEnv, WAIT_FOR_COMPLETION_HEADER } from '../utils/utils.ts'
import { perMessageManifestSizeLookupBudget } from '../utils/manifest_size_lookup_budget.ts'
import { skipLegacyManifestSize, updateDeltaFileSize } from './on_manifest_create.ts'

// Define constants
export const DEFAULT_BATCH_SIZE = 950 // Default batch size for queue reads limit of CF is 1000 fetches so we take a safe margin
const DEFAULT_QUEUE_HTTP_CONCURRENCY = 25
const VERSION_QUEUE_HTTP_CONCURRENCY = 10
const VERSION_QUEUE_BATCH_SIZE = 40 // Keep under visibility window at 10-way / 60s HTTP
const MANIFEST_QUEUE_HTTP_CONCURRENCY = 100
const MANIFEST_QUEUE_ACK_CHUNK_SIZE = 100
const DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 120
const VERSION_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 900
const MANIFEST_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 900
const QUEUE_HTTP_TIMEOUT_MS = 15_000
const VERSION_QUEUE_HTTP_TIMEOUT_MS = 300_000 // database manifest cleanup and canonical ZIP trash
// HARD RULE: no pgmq queue may retry more than 5 times. Do not raise this, and
// do not add per-queue exceptions. Leftover work must be re-enqueued by a
// sweeper/cron (e.g. sweep_deleted_version_manifests), never by burning reads.
export const MAX_QUEUE_READS = 5
const DISCORD_IGNORED_ERROR_CODES = new Set(['version_not_found', 'no_channel'])
// Relayed batches (Cloudflare Queues, see queue_relay.ts) run every message of
// a queue at once. A Worker invocation keeps at most six connections open
// (TCP sockets, fetches, bindings) and queues the rest while their timeouts
// already run. The consumer's database client stays open for the whole batch,
// which leaves five, so the consumer's max_batch_size in wrangler.jsonc must
// stay at or below this.
const WORKER_OPEN_CONNECTIONS = 6
export const RELAYED_QUEUE_CONCURRENCY = WORKER_OPEN_CONNECTIONS - 1
// on_manifest_create runs in this invocation, and each message keeps its own
// database client open while it reads storage: two connections per message.
const RELAYED_MANIFEST_QUEUE_CONCURRENCY = Math.floor(RELAYED_QUEUE_CONCURRENCY / 2)
// pgmq names its tables pgmq.q_<name> and limits names to 47 characters. Our
// queue names are lowercase identifiers, which also makes them safe to put in
// SQL text.
export const PGMQ_QUEUE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,46}$/
// pgmq.read/delete/archive are writes behind a SELECT. On Cloudflare the
// queries go through Hyperdrive, whose query cache only skips statements it
// recognizes as writes or as calling a non-immutable function, so an
// identical pgmq.read could return the previous result without reading. The
// unused now() CTE makes them uncacheable; PostgreSQL never evaluates it.
// These are not request-path reads: serving them from cache would lose writes.
const PGMQ_UNCACHED = 'WITH capgo_pgmq_uncached AS (SELECT now()) '

export const messageSchema = z.object({
  msg_id: integerLikeSchema,
  read_ct: integerLikeSchema,
  message: z.object({
    payload: z.unknown().optional(),
    function_name: z.string(),
    function_type: z.enum(['cloudflare', 'cloudflare_pp', 'supabase', '']).nullable().optional(),
  }).passthrough(),
})

interface Message {
  msg_id: number
  read_ct: number
  message: {
    payload?: any
    function_name: string
    function_type?: 'cloudflare' | 'cloudflare_pp' | 'supabase' | '' | null
    [key: string]: unknown
  }
}

export const messagesArraySchema = messageSchema.array()

interface QueueMessageMetadata {
  queueName: string
  msgId: number
  readCount: number
}

interface FailureDetail {
  function_name: string
  function_type: string
  msg_id: number
  read_count: number
  status: number
  status_text: string
  error_code?: string
  error_message?: string
  response_body?: string
  payload_size: number
  cf_id: string
  duration_ms?: number
  target_url?: string
}

interface ProcessedQueueMessage extends Message {
  httpResponse: Response
  errorDetails: Awaited<ReturnType<typeof extractErrorDetails>>
  cfId: string
  payloadSize: number
  durationMs: number
  deletedFromQueue?: boolean
  targetUrl: string | null
}

interface QueueProcessResult {
  actionableFailureCount: number
  archivedCount: number
  failedCount: number
  processedCount: number
  readSucceeded: boolean
  skippedCount: number
  success: boolean
  successCount: number
}

function extractMessageBody(message: Message): Record<string, unknown> {
  if (message.message?.payload !== undefined)
    return (message.message.payload ?? {}) as Record<string, unknown>

  const { function_name: _functionName, function_type: _functionType, ...legacyBody } = message.message ?? {}
  return legacyBody
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getQueueMessageTrace(functionName: string, body: Record<string, unknown>): Record<string, unknown> | null {
  if (functionName !== 'on_version_update' || body.table !== 'app_versions' || body.type !== 'UPDATE')
    return null

  const record = isRecord(body.record) ? body.record : {}
  const oldRecord = isRecord(body.old_record) ? body.old_record : {}
  const manifest = record.manifest
  let manifestEntries = 0
  if (Array.isArray(manifest))
    manifestEntries = manifest.length
  else if (manifest)
    manifestEntries = 1

  return {
    app_id: record.app_id ?? null,
    deleted_at: record.deleted_at ?? null,
    id: record.id ?? null,
    manifest_count: record.manifest_count ?? null,
    manifest_entries: manifestEntries,
    old_deleted_at: oldRecord.deleted_at ?? null,
    old_r2_path: oldRecord.r2_path ?? null,
    old_storage_provider: oldRecord.storage_provider ?? null,
    old_updated_at: oldRecord.updated_at ?? null,
    r2_path: record.r2_path ?? null,
    storage_provider: record.storage_provider ?? null,
    updated_at: record.updated_at ?? null,
    version_name: record.name ?? null,
  }
}

function getActionableQueueFailures(failureDetails: FailureDetail[], retryBudget: number = MAX_QUEUE_READS): FailureDetail[] {
  return failureDetails.filter((detail) => {
    if (detail.read_count < retryBudget)
      return false
    return !detail.error_code || !DISCORD_IGNORED_ERROR_CODES.has(detail.error_code)
  })
}

function truncateDiscordField(value: string, maxLength = 1024): string {
  if (value.length <= maxLength)
    return value
  return `${value.slice(0, maxLength - 15)}... (truncated)`
}

function isAsciiLetterOrDigit(char: string): boolean {
  if (!char)
    return false
  const code = char.codePointAt(0) ?? 0
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
}

function isEmailLocalChar(char: string): boolean {
  return isAsciiLetterOrDigit(char)
    || char === '.'
    || char === '_'
    || char === '%'
    || char === '+'
    || char === '-'
}

function isEmailDomainChar(char: string): boolean {
  return isAsciiLetterOrDigit(char)
    || char === '.'
    || char === '-'
}

function isLikelyEmail(value: string): boolean {
  const atIndex = value.indexOf('@')
  if (atIndex <= 0 || atIndex !== value.lastIndexOf('@') || atIndex === value.length - 1)
    return false

  const domainPart = value.slice(atIndex + 1)
  const lastDotIndex = domainPart.lastIndexOf('.')
  if (lastDotIndex <= 0 || lastDotIndex === domainPart.length - 1)
    return false

  const tld = domainPart.slice(lastDotIndex + 1)
  return tld.length >= 2
}

function redactEmailLikeSubstrings(value: string): string {
  let result = ''
  let cursor = 0
  let searchIndex = 0

  while (searchIndex < value.length) {
    const atIndex = value.indexOf('@', searchIndex)
    if (atIndex === -1)
      break

    let start = atIndex
    while (start > cursor && isEmailLocalChar(value[start - 1]))
      start--

    let end = atIndex + 1
    while (end < value.length && isEmailDomainChar(value[end]))
      end++

    const candidate = value.slice(start, end)
    if (isLikelyEmail(candidate)) {
      result += value.slice(cursor, start)
      result += '[REDACTED_EMAIL]'
      cursor = end
      searchIndex = end
      continue
    }

    searchIndex = atIndex + 1
  }

  if (cursor === 0)
    return value

  return `${result}${value.slice(cursor)}`
}

function sanitizeDiscordResponseBody(value: string): string {
  return redactEmailLikeSubstrings(value)
    .replace(/\b(Bearer\s+)[\w.~+/-]+=*/gi, '$1[REDACTED_TOKEN]')
    .replace(/((?:api[-_]?key|token|authorization|password|secret|access[-_]?token|refresh[-_]?token)["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi, '$1[REDACTED]')
    .replace(/\b[\dA-F]{32,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\b[\w+/=-]{40,}\b/g, '[REDACTED_TOKEN]')
}

// Helper function to generate UUID v4
function generateUUID(): string {
  return crypto.randomUUID()
}

function isVersionQueueFunction(functionName: string): boolean {
  return functionName === 'on_version_update'
    || functionName === 'on_version_create'
    || functionName === 'on_version_delete'
}

function normalizeQueueFunctionType(functionType: string | null | undefined): string {
  const normalizedType = (functionType ?? '').trim()
  // Triggers historically omitted function_type; prefer the production Cloudflare path.
  if (!normalizedType || normalizedType === 'supabase')
    return 'cloudflare'
  return normalizedType
}

function stripAppVersionManifestFromQueueBody(body: Record<string, unknown>): Record<string, unknown> {
  let changed = false
  let next = body

  if (isRecord(body.record) && 'manifest' in body.record) {
    next = { ...next, record: { ...body.record, manifest: null } }
    changed = true
  }
  if (isRecord(body.old_record) && 'manifest' in body.old_record) {
    const oldRecord = isRecord(next.old_record) ? next.old_record : body.old_record
    next = { ...next, old_record: { ...oldRecord, manifest: null } }
    changed = true
  }

  return changed ? next : body
}

function prepareQueueHttpBody(functionName: string, body: Record<string, unknown>): Record<string, unknown> {
  if (!isVersionQueueFunction(functionName))
    return body
  return stripAppVersionManifestFromQueueBody(body)
}

function getQueueHttpTimeoutMs(functionName: string): number {
  if (isOnboardingQueue(functionName))
    return 90_000
  if (isVersionQueueFunction(functionName))
    return VERSION_QUEUE_HTTP_TIMEOUT_MS
  return QUEUE_HTTP_TIMEOUT_MS
}

function getQueueMaxReads(_queueName: string): number {
  return MAX_QUEUE_READS
}

function resolveFunctionUrl(c: Context, function_name: string, function_type: string | null | undefined): string {
  const cfPpUrl = getEnv(c, 'CLOUDFLARE_PP_FUNCTION_URL')
  const cfUrl = getEnv(c, 'CLOUDFLARE_FUNCTION_URL')
  const normalizedType = normalizeQueueFunctionType(function_type)

  if (normalizedType === 'cloudflare_pp' && cfPpUrl)
    return `${cfPpUrl}/triggers/${function_name}`

  if (normalizedType === 'cloudflare' && cfUrl)
    return `${cfUrl}/triggers/${function_name}`

  // Prefer Cloudflare whenever it is configured; Supabase is the local/dev fallback.
  if (cfUrl)
    return `${cfUrl}/triggers/${function_name}`

  return `${getEnv(c, 'SUPABASE_URL')}/functions/v1/triggers/${function_name}`
}

function queueFailureResponse(errorCode: string, message: string, moreInfo: Record<string, unknown> = {}, status = 599): Response {
  return new Response(JSON.stringify({
    error: errorCode,
    message,
    moreInfo,
  }), {
    headers: {
      'content-type': 'application/json',
    },
    status,
    statusText: status === 599 ? 'Queue Transport Error' : undefined,
  })
}

function httpExceptionToQueueResponse(error: unknown): Response | null {
  if (!error || typeof error !== 'object')
    return null

  const maybeException = error as {
    cause?: unknown
    message?: unknown
    status?: unknown
  }
  if (typeof maybeException.status !== 'number')
    return null

  const cause = maybeException.cause
  if (cause && typeof cause === 'object' && 'error' in cause) {
    const causeData = cause as {
      error?: unknown
      message?: unknown
      moreInfo?: unknown
    }
    const resolvedMessage = typeof causeData.message === 'string'
      ? causeData.message
      : typeof maybeException.message === 'string'
        ? maybeException.message
        : 'Queue handler failed'

    return queueFailureResponse(
      typeof causeData.error === 'string' ? causeData.error : 'http_exception',
      resolvedMessage,
      causeData.moreInfo && typeof causeData.moreInfo === 'object'
        ? causeData.moreInfo as Record<string, unknown>
        : {},
      maybeException.status,
    )
  }

  return queueFailureResponse(
    'http_exception',
    typeof maybeException.message === 'string' ? maybeException.message : 'Queue handler failed',
    {},
    maybeException.status,
  )
}

type ManifestQueueRecord
  = | { table: 'manifest', record: { id?: number | null } }
    | { table: 'delta_files', record: Database['public']['Tables']['delta_files']['Row'] }

function getManifestRecordFromQueueBody(body: Record<string, unknown>): ManifestQueueRecord {
  const record = body.record
  if (body.type !== 'INSERT' || (body.table !== 'manifest' && body.table !== 'delta_files') || !record || typeof record !== 'object') {
    throw simpleError('invalid_manifest_queue_payload', 'Invalid manifest queue payload', { body })
  }

  return body.table === 'delta_files'
    ? { table: 'delta_files', record: record as Database['public']['Tables']['delta_files']['Row'] }
    : { table: 'manifest', record: record as { id?: number | null } }
}

async function dispatchQueueMessage(
  c: Context,
  function_name: string,
  function_type: string | null | undefined,
  body: Record<string, unknown>,
  cfId: string,
  metadata: QueueMessageMetadata,
  targetUrl: string,
  waitForCompletion = false,
): Promise<{ response: Response, targetUrl: string }> {
  if (function_name === 'on_manifest_create') {
    const { table, record } = getManifestRecordFromQueueBody(body)
    const queue = {
      cfId,
      queueMsgId: String(metadata.msgId),
      queueName: metadata.queueName,
      queueReadCount: String(metadata.readCount),
    }
    const response = table === 'delta_files'
      ? await updateDeltaFileSize(c, record, queue)
      : skipLegacyManifestSize(c, record, queue)
    return { response, targetUrl }
  }

  const response = await http_post_helper(c, function_name, function_type, body, cfId, metadata, targetUrl, waitForCompletion)
  return { response, targetUrl }
}

async function processQueueMessage(c: Context, queueName: string, message: Message, waitForCompletion = false): Promise<ProcessedQueueMessage> {
  const function_name = message.message?.function_name ?? 'unknown'
  const function_type = normalizeQueueFunctionType(message.message?.function_type)
  const cfId = generateUUID()
  const start = Date.now()
  let payloadSize = 0
  let targetUrl: string | null = null
  let trace: ReturnType<typeof getQueueMessageTrace> = null

  // Everything that can fail is inside the try, so a message always ends as a
  // result (success or failure) and never rejects the batch it is part of.
  try {
    const body = extractMessageBody(message)
    if (message.message?.payload === undefined && Object.keys(body).length > 0) {
      cloudlog({
        requestId: c.get('requestId'),
        message: `[${queueName}] Using legacy queue message body shape for ${function_name}.`,
        msgId: message.msg_id,
      })
    }
    const dispatchBody = prepareQueueHttpBody(function_name, body)
    payloadSize = JSON.stringify(dispatchBody).length
    const resolvedUrl = function_name === 'on_manifest_create' ? 'direct:on_manifest_create' : resolveFunctionUrl(c, function_name, function_type)
    targetUrl = resolvedUrl
    trace = getQueueMessageTrace(function_name, body)

    cloudlog({
      requestId: c.get('requestId'),
      message: `[${queueName}] Queue message dispatching.`,
      body_trace: trace,
      cfId,
      function_name,
      function_type,
      msgId: message.msg_id,
      payloadSize,
      readCount: message.read_ct,
      targetUrl,
    })
    const result = await dispatchQueueMessage(c, function_name, function_type, dispatchBody, cfId, {
      msgId: message.msg_id,
      queueName,
      readCount: message.read_ct,
    }, resolvedUrl, waitForCompletion)
    const errorDetails = await extractErrorDetails(result.response)
    const durationMs = Date.now() - start

    cloudlog({
      requestId: c.get('requestId'),
      message: `[${queueName}] Queue message processed.`,
      body_trace: trace,
      cfId,
      durationMs,
      errorCode: errorDetails.errorCode,
      errorMessage: errorDetails.errorMessage,
      function_name,
      function_type,
      msgId: message.msg_id,
      payloadSize,
      readCount: message.read_ct,
      responseOk: result.response.status >= 200 && result.response.status < 300,
      responseStatus: result.response.status,
      targetUrl: result.targetUrl,
    })

    return {
      httpResponse: result.response,
      errorDetails,
      cfId,
      payloadSize,
      durationMs,
      targetUrl: result.targetUrl,
      ...message,
      message: {
        ...message.message,
        function_type: function_type as Message['message']['function_type'],
      },
    }
  }
  catch (error) {
    const serializedError = serializeError(error)
    const durationMs = Date.now() - start
    const httpResponse = httpExceptionToQueueResponse(error) ?? queueFailureResponse('queue_message_failed', serializedError.message ?? 'Queue message failed before receiving a response', {
      cfId,
      durationMs,
      error: serializedError,
      function_name,
      function_type,
      msgId: message.msg_id,
      queueName,
      readCount: message.read_ct,
      targetUrl,
    })
    cloudlogErr({
      requestId: c.get('requestId'),
      message: `[${queueName}] Queue message failed during processing.`,
      cfId,
      durationMs,
      error: serializedError,
      responseStatus: httpResponse.status,
      body_trace: trace,
      function_name,
      function_type,
      msgId: message.msg_id,
      readCount: message.read_ct,
      targetUrl,
    })
    const errorDetails = await extractErrorDetails(httpResponse)
    cloudlogErr({
      requestId: c.get('requestId'),
      message: `[${queueName}] Queue message processed as failure response.`,
      body_trace: trace,
      cfId,
      durationMs,
      errorCode: errorDetails.errorCode,
      errorMessage: errorDetails.errorMessage,
      function_name,
      function_type,
      msgId: message.msg_id,
      payloadSize,
      readCount: message.read_ct,
      responseStatus: httpResponse.status,
      targetUrl,
    })

    return {
      httpResponse,
      errorDetails,
      cfId,
      payloadSize,
      durationMs,
      targetUrl,
      ...message,
      message: {
        ...message.message,
        function_type: function_type as Message['message']['function_type'],
      },
    }
  }
}

export function getQueueBatchSize(queueName: string, requestedBatchSize: number): number {
  if (queueName === 'cron_onboarding_refresh_apps')
    return Math.min(requestedBatchSize, ONBOARDING_MESSAGES_PER_MINUTE)
  if (isVersionQueueFunction(queueName))
    return Math.min(requestedBatchSize, VERSION_QUEUE_BATCH_SIZE)
  return requestedBatchSize
}

function getQueueHttpConcurrency(queueName: string): number {
  if (isOnboardingQueue(queueName))
    return ONBOARDING_MESSAGES_PER_MINUTE
  if (queueName === 'on_manifest_create')
    return MANIFEST_QUEUE_HTTP_CONCURRENCY
  if (isVersionQueueFunction(queueName))
    return VERSION_QUEUE_HTTP_CONCURRENCY
  return DEFAULT_QUEUE_HTTP_CONCURRENCY
}

/** How many messages of one queue a relayed batch runs at once (see RELAYED_QUEUE_CONCURRENCY). */
export function getRelayedQueueConcurrency(queueName: string): number {
  if (queueName === 'on_manifest_create')
    return RELAYED_MANIFEST_QUEUE_CONCURRENCY
  if (isOnboardingQueue(queueName))
    return Math.min(ONBOARDING_MESSAGES_PER_MINUTE, RELAYED_QUEUE_CONCURRENCY)
  return RELAYED_QUEUE_CONCURRENCY
}

export function getQueueVisibilityTimeout(queueName: string): number {
  if (queueName === 'on_manifest_create')
    return MANIFEST_QUEUE_VISIBILITY_TIMEOUT_SECONDS
  if (isVersionQueueFunction(queueName))
    return VERSION_QUEUE_VISIBILITY_TIMEOUT_SECONDS
  return DEFAULT_QUEUE_VISIBILITY_TIMEOUT_SECONDS
}

function getQueueAckChunkSize(queueName: string): number | null {
  if (queueName === 'on_manifest_create')
    return MANIFEST_QUEUE_ACK_CHUNK_SIZE
  return null
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize))
  }
  return chunks
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index]!, index)
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  // Every worker settles before this returns or throws, so a caller that moves
  // on after a failure (the next queue, closing its client) never leaves
  // message work running past it and over the connection budget.
  const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()))
  const failure = settled.find(result => result.status === 'rejected')
  if (failure)
    throw failure.reason
  return results
}

function isSuccessfulQueueResult(result: { httpResponse: Response }): boolean {
  return result.httpResponse.status >= 200 && result.httpResponse.status < 300
}

function partitionQueueResultsForAck<T extends { httpResponse: Response }>(results: T[]): { failed: T[], successful: T[] } {
  const successful: T[] = []
  const failed: T[] = []
  for (const result of results) {
    if (isSuccessfulQueueResult(result))
      successful.push(result)
    else
      failed.push(result)
  }
  return { successful, failed }
}

async function deleteSuccessfulChunkMessages(
  c: Context,
  db: Awaited<ReturnType<typeof getPgClient>>,
  queueName: string,
  chunkResults: ProcessedQueueMessage[],
): Promise<void> {
  const successfulChunkMessages = chunkResults.filter(isSuccessfulQueueResult)
  if (successfulChunkMessages.length === 0)
    return

  cloudlog({ requestId: c.get('requestId'), message: `[${queueName}] Deleting ${successfulChunkMessages.length} successful messages from queue checkpoint.` })
  await delete_queue_message_batch(c, db, queueName, successfulChunkMessages.map(msg => msg.msg_id))
  for (const result of successfulChunkMessages) {
    result.deletedFromQueue = true
  }
}

async function processQueueMessageChunks(
  c: Context,
  db: Awaited<ReturnType<typeof getPgClient>>,
  queueName: string,
  messagesToProcess: Message[],
  processConcurrency: number,
  waitForCompletion: boolean,
): Promise<ProcessedQueueMessage[]> {
  const ackChunkSize = getQueueAckChunkSize(queueName)
  const processChunks = ackChunkSize ? chunkArray(messagesToProcess, ackChunkSize) : [messagesToProcess]
  const results: ProcessedQueueMessage[] = []

  for (const chunk of processChunks) {
    const chunkResults = await mapWithConcurrency(chunk, processConcurrency, async message => processQueueMessage(c, queueName, message, waitForCompletion))
    results.push(...chunkResults)

    if (ackChunkSize) {
      await deleteSuccessfulChunkMessages(c, db, queueName, chunkResults)
    }
  }

  return results
}

async function persistQueueCfIds(
  c: Context,
  db: Awaited<ReturnType<typeof getPgClient>>,
  queueName: string,
  results: ProcessedQueueMessage[],
): Promise<void> {
  const cfIdUpdates = results.map(result => ({
    msg_id: result.msg_id,
    cf_id: result.cfId,
    queue: queueName,
  }))

  if (cfIdUpdates.length === 0)
    return

  cloudlog({ requestId: c.get('requestId'), message: `[${queueName}] Updating ${cfIdUpdates.length} messages with CF IDs.` })
  try {
    await mass_edit_queue_messages_cf_ids(c, db, cfIdUpdates)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: `[${queueName}] Failed to persist queue CF IDs. Continuing queue cleanup.`,
      error: serializeError(error),
      queueName,
      updateCount: cfIdUpdates.length,
    })
  }
}

async function deleteUncheckpointedSuccessMessages(
  c: Context,
  db: Awaited<ReturnType<typeof getPgClient>>,
  queueName: string,
  successMessages: ProcessedQueueMessage[],
): Promise<void> {
  const successMessagesPendingDelete = successMessages.filter(msg => !msg.deletedFromQueue)
  if (successMessagesPendingDelete.length === 0)
    return

  cloudlog({ requestId: c.get('requestId'), message: `[${queueName}] Deleting ${successMessagesPendingDelete.length} successful messages from queue.` })
  await delete_queue_message_batch(c, db, queueName, successMessagesPendingDelete.map(msg => msg.msg_id))
}

async function reportQueueFailures(c: Context, queueName: string, messagesFailed: ProcessedQueueMessage[]): Promise<number> {
  if (messagesFailed.length === 0)
    return 0

  cloudlog({ requestId: c.get('requestId'), message: `[${queueName}] Failed to process ${messagesFailed.length} messages.` })

  const retryBudget = getQueueMaxReads(queueName)
  const timestamp = new Date().toISOString()
  const failureDetails = messagesFailed.map(msg => ({
    function_name: msg.message?.function_name ?? 'unknown',
    function_type: msg.message?.function_type ?? 'supabase',
    msg_id: msg.msg_id,
    read_count: msg.read_ct,
    status: msg.httpResponse.status,
    status_text: msg.httpResponse.statusText,
    error_code: msg.errorDetails.errorCode ?? undefined,
    error_message: msg.errorDetails.errorMessage ?? undefined,
    response_body: msg.errorDetails.bodyPreview ?? undefined,
    payload_size: msg.payloadSize,
    cf_id: msg.cfId,
    duration_ms: msg.durationMs,
    target_url: msg.targetUrl ?? undefined,
  }))

  const actionableFailures = getActionableQueueFailures(failureDetails, retryBudget)
  const groupedByFunction = actionableFailures.reduce((acc, detail) => {
    const key = detail.function_name
    acc[key] ??= []
    acc[key].push(detail)
    return acc
  }, {} as Record<string, typeof actionableFailures>)

  if (actionableFailures.length > 0) {
    await sendDiscordAlert(c, {
      content: `🚨 **Queue Processing Failures** - ${queueName}`,
      embeds: [
        {
          title: `❌ ${actionableFailures.length} Messages Failed Processing`,
          description: `**Queue:** ${queueName}\n**Failed Functions:** ${Object.keys(groupedByFunction).length}\n**Total Failures:** ${actionableFailures.length}`,
          color: 0xFF6B35, // Orange color for warnings
          timestamp,
          fields: [
            {
              name: '📊 Failure Summary',
              value: Object.entries(groupedByFunction)
                .map(([funcName, failures]) =>
                  `**${funcName}** (${failures[0].function_type}): ${failures.length} failures`,
                )
                .join('\n'),
              inline: false,
            },
            {
              name: '🔍 Detailed Failures',
              value: truncateDiscordField(actionableFailures.slice(0, 10).map((detail) => {
                const cfLogUrl = `https://dash.cloudflare.com/${getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID')}/workers/services/view/capgo_api-prod/production/observability/logs?workers-observability-view=%22invocations%22&filters=%5B%7B%22key%22%3A%22%24workers.event.request.headers.x-capgo-cf-id%22%2C%22type%22%3A%22string%22%2C%22value%22%3A%22${detail.cf_id}%22%2C%22operation%22%3A%22eq%22%7D%5D`
                const errorInfo = detail.error_code ? ` | Error: ${detail.error_code}` : ''
                const messageInfo = detail.error_message ? ` | ${truncateDiscordField(detail.error_message.replace(/\s+/g, ' ').trim(), 180)}` : ''
                const durationInfo = typeof detail.duration_ms === 'number' ? ` | ${detail.duration_ms}ms` : ''
                const targetInfo = detail.target_url ? ` | Target: ${truncateDiscordField(detail.target_url, 120)}` : ''
                return `**${detail.function_name}** | Status: ${detail.status} | Read: ${detail.read_count}/${retryBudget}${durationInfo}${errorInfo}${messageInfo}${targetInfo} | [CF Logs](${cfLogUrl})`
              }).join('\n')),
              inline: false,
            },
            {
              name: '📈 Status Code Distribution',
              value: Object.entries(
                actionableFailures.reduce((acc, detail) => {
                  acc[detail.status] = (acc[detail.status] ?? 0) + 1
                  return acc
                }, {} as Record<number, number>),
              ).map(([status, count]) => `**${status}:** ${count}`).join(' | '),
              inline: false,
            },
            {
              name: '⚠️ Retry Analysis',
              value: `**Retry Budget Exhausted:** ${actionableFailures.length}\n**Will Archive:** ${actionableFailures.length}`,
              inline: true,
            },
            {
              name: '📦 Payload Info',
              value: `**Avg Size:** ${Math.round(actionableFailures.reduce((sum, d) => sum + d.payload_size, 0) / actionableFailures.length)} bytes\n**Max Size:** ${Math.max(...actionableFailures.map(d => d.payload_size))} bytes`,
              inline: true,
            },
            {
              name: '🧾 Sanitized Response Body',
              value: truncateDiscordField(actionableFailures
                .map(detail => detail.response_body ? `**${detail.function_name}:** ${sanitizeDiscordResponseBody(detail.response_body)}` : `**${detail.function_name}:** (empty)`)
                .join('\n')),
              inline: false,
            },
          ],
          footer: {
            text: `Queue: ${queueName} | Environment: ${getEnv(c, 'ENVIRONMENT') ?? 'unknown'}`,
          },
        },
      ],
    })
  }
  else {
    cloudlog({
      requestId: c.get('requestId'),
      message: `[${queueName}] Suppressed Discord alert for retryable or ignored queue failures.`,
      retryingFailures: failureDetails.filter(detail => detail.read_count < retryBudget).length,
      ignoredErrors: Array.from(DISCORD_IGNORED_ERROR_CODES),
    })
  }

  return actionableFailures.length
}

async function processQueue(c: Context, db: Awaited<ReturnType<typeof getPgClient>>, queueName: string, batchSize: number = DEFAULT_BATCH_SIZE, waitForCompletion = false): Promise<QueueProcessResult> {
  const messages = await readQueue(c, db, queueName, batchSize)

  if (messages === null) {
    cloudlog({
      requestId: c.get('requestId'),
      message: `[${queueName}] Queue read failed.`,
      queueName,
    })
    return emptyQueueProcessResult(false)
  }

  return processQueueMessages(c, db, queueName, messages, getQueueHttpConcurrency(queueName), waitForCompletion)
}

function emptyQueueProcessResult(readSucceeded: boolean): QueueProcessResult {
  return {
    actionableFailureCount: 0,
    archivedCount: 0,
    failedCount: 0,
    processedCount: 0,
    readSucceeded,
    skippedCount: 0,
    success: readSucceeded,
    successCount: 0,
  }
}

// Archives messages past the retry budget, dispatches the rest, deletes the
// successful ones and reports the failures. Failed messages stay in pgmq and
// become readable again when their visibility timeout ends.
async function processQueueMessages(
  c: Context,
  db: Awaited<ReturnType<typeof getPgClient>>,
  queueName: string,
  messages: Message[],
  processConcurrency: number,
  waitForCompletion: boolean,
): Promise<QueueProcessResult> {
  const retryBudget = getQueueMaxReads(queueName)
  const [messagesToProcess, messagesToSkip] = messages.reduce((acc, message) => {
    acc[message.read_ct <= retryBudget ? 0 : 1].push(message)
    return acc
  }, [[], []] as [typeof messages, typeof messages])

  cloudlog({
    requestId: c.get('requestId'),
    message: `[${queueName}] Processing queue batch.`,
    queueName,
    processingCount: messagesToProcess.length,
    skippedCount: messagesToSkip.length,
    concurrency: processConcurrency,
    retryBudget,
  })

  // Archive messages after the configured retry budget is exhausted.
  if (messagesToSkip.length > 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: `[${queueName}] Archiving messages that exceeded the retry budget.`,
      queueName,
      archiveCount: messagesToSkip.length,
      retryBudget,
    })
    await archive_queue_messages(c, db, queueName, messagesToSkip.map(msg => msg.msg_id))
  }

  if (queueName === 'on_manifest_create' && messagesToProcess.length > 0) {
    c.set(
      'manifestSizeLookupSubrequestBudgetPerMessage',
      perMessageManifestSizeLookupBudget(messagesToProcess.length),
    )
  }

  const results = await processQueueMessageChunks(c, db, queueName, messagesToProcess, processConcurrency, waitForCompletion)

  const { failed: messagesFailed, successful: successMessages } = partitionQueueResultsForAck(results)

  // Successful messages are deleted below, so only failed ones keep a CF ID trail.
  await persistQueueCfIds(c, db, queueName, messagesFailed)

  await deleteUncheckpointedSuccessMessages(c, db, queueName, successMessages)
  const actionableFailureCount = await reportQueueFailures(c, queueName, messagesFailed)

  if (successMessages.length !== messagesToProcess.length) {
    cloudlog({ requestId: c.get('requestId'), message: `[${queueName}] ${successMessages.length} messages were processed successfully, ${messagesToProcess.length - successMessages.length} messages failed.` })
  }
  else {
    cloudlog({ requestId: c.get('requestId'), message: `[${queueName}] All messages were processed successfully.` })
  }

  return {
    actionableFailureCount,
    archivedCount: messagesToSkip.length,
    failedCount: messagesFailed.length,
    processedCount: messagesToProcess.length,
    readSucceeded: true,
    skippedCount: messagesToSkip.length,
    success: messagesToSkip.length === 0 && messagesFailed.length === 0,
    successCount: successMessages.length,
  }
}

async function extractErrorDetails(response: Response): Promise<{
  errorCode: string | null
  errorMessage: string | null
  bodyPreview: string | null
}> {
  if (response.status < 400) {
    response.body?.cancel()
    return {
      bodyPreview: null,
      errorCode: null,
      errorMessage: null,
    }
  }
  const cloned = response.clone()
  const contentType = cloned.headers.get('content-type') ?? ''
  let payload: any = null
  let bodyPreview: string | null = null
  try {
    if (contentType.includes('application/json')) {
      const text = await cloned.text()
      bodyPreview = text.slice(0, 500)
      payload = text ? JSON.parse(text) : null
    }
    else {
      const text = await cloned.text()
      bodyPreview = text ? text.slice(0, 500) : null
      if (text) {
        try {
          payload = JSON.parse(text)
        }
        catch {
          payload = null
        }
      }
    }
  }
  catch {
    payload = null
  }
  if (payload && typeof payload === 'object') {
    const errorCode = payload.error ?? payload.errorCode
    const errorMessage = payload.message ?? payload.errorMessage
    return {
      bodyPreview,
      errorCode: typeof errorCode === 'string' ? errorCode : null,
      errorMessage: typeof errorMessage === 'string' ? errorMessage : null,
    }
  }
  return {
    bodyPreview,
    errorCode: null,
    errorMessage: null,
  }
}

/**
 * Archives the rows that can never be processed (no function_name, bad ids)
 * and returns the others. Their read is already counted, so failing the whole
 * batch for one malformed row would use up a read of every other message in
 * it, and cleanup_queue_messages deletes messages past five reads unprocessed.
 */
async function takeValidQueueMessages(
  c: Context,
  db: Awaited<ReturnType<typeof getPgClient>>,
  queueName: string,
  rows: readonly unknown[],
): Promise<Message[]> {
  const valid: Message[] = []
  const invalidIds: number[] = []
  let firstError: unknown
  for (const row of rows) {
    const parsed = safeParseSchema(messageSchema, row)
    if (parsed.success) {
      valid.push(parsed.data as Message)
      continue
    }
    firstError ??= parsed.error
    const msgId = Number((row as { msg_id?: unknown } | null)?.msg_id)
    if (Number.isSafeInteger(msgId) && msgId > 0)
      invalidIds.push(msgId)
  }
  if (valid.length === rows.length)
    return valid

  cloudlogErr({
    requestId: c.get('requestId'),
    message: `[${queueName}] Archiving messages with an invalid format.`,
    queueName,
    invalidCount: rows.length - valid.length,
    msgIds: invalidIds.slice(0, 20),
    error: firstError,
  })
  try {
    await archive_queue_messages(c, db, queueName, invalidIds)
  }
  catch {
    // Already logged; they are read and archived again after their visibility timeout.
  }
  return valid
}

// Reads messages from the queue and logs them
async function readQueue(c: Context, db: Awaited<ReturnType<typeof getPgClient>>, queueName: string, batchSize: number = DEFAULT_BATCH_SIZE): Promise<Message[] | null> {
  const queueKey = 'readQueue'
  const startTime = Date.now()
  let messages: Message[] = []

  cloudlog({ requestId: c.get('requestId'), message: `[${queueKey}] Starting queue read at ${startTime}.` })

  try {
    const visibilityTimeout = getQueueVisibilityTimeout(queueName)
    cloudlog(`[${queueKey}] Reading messages from queue: ${queueName}`)
    try {
      const result = await db.query(
        `${PGMQ_UNCACHED}SELECT msg_id, message, read_ct FROM pgmq.read($1, $2, $3)`,
        [queueName, visibilityTimeout, batchSize],
      )
      messages = result.rows
    }
    catch (readError) {
      throw simpleError('error_reading_from_pgmq_queue', 'Error reading from pgmq queue', { queueName }, readError)
    }

    if (!messages?.length) {
      cloudlog({ requestId: c.get('requestId'), message: `[${queueKey}] No new messages found in queue ${queueName}.` })
      return messages
    }

    cloudlog({ requestId: c.get('requestId'), message: `[${queueKey}] Received ${messages.length} messages from queue ${queueName}.` })
    return await takeValidQueueMessages(c, db, queueName, messages)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: `[${queueKey}] Error reading queue messages:`, error })
  }
  finally {
    cloudlog({ requestId: c.get('requestId'), message: `[${queueKey}] Finished reading queue messages in ${Date.now() - startTime}ms.` })
  }
  return null
}

// The main HTTP POST helper function
export async function http_post_helper(
  c: Context,
  function_name: string,
  function_type: string | null | undefined,
  body: any,
  cfId: string,
  metadata?: QueueMessageMetadata,
  targetUrl = resolveFunctionUrl(c, function_name, function_type),
  waitForCompletion = false,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'apisecret': getEnv(c, 'API_SECRET'),
    'x-capgo-cf-id': cfId,
  }
  if (metadata) {
    headers['x-capgo-queue-name'] = metadata.queueName
    headers['x-capgo-queue-msg-id'] = String(metadata.msgId)
    headers['x-capgo-queue-read-count'] = String(metadata.readCount)
    headers['x-capgo-queue-max-reads'] = String(metadata ? getQueueMaxReads(metadata.queueName) : MAX_QUEUE_READS)
  }
  if (waitForCompletion)
    headers[WAIT_FOR_COMPLETION_HEADER] = 'true'
  const timeoutMs = getQueueHttpTimeoutMs(function_name)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return response
  }
  catch (error) {
    const serializedError = serializeError(error)
    throw simpleError('queue_http_post_failed', 'Queue HTTP POST failed', {
      cfId,
      error: serializedError,
      function_name,
      function_type: function_type ?? null,
      metadata: metadata ?? null,
      targetUrl,
      timeoutMs,
    }, error)
  }
  finally {
    clearTimeout(timeoutId)
  }
}

// Helper function to delete multiple messages from the queue in a single batch
async function delete_queue_message_batch(c: Context, db: Awaited<ReturnType<typeof getPgClient>>, queueName: string, msgIds: number[]) {
  try {
    if (msgIds.length === 0)
      return
    // Use pg's array syntax
    await db.query(
      `${PGMQ_UNCACHED}SELECT pgmq.delete($1, $2::bigint[])`,
      [queueName, msgIds],
    )
  }
  catch (error) {
    throw simpleError('error_deleting_queue_messages', 'Error deleting queue messages', { msgIds, queueName }, error)
  }
}

// Helper function to archive multiple messages from the queue in a single batch
async function archive_queue_messages(c: Context, db: Awaited<ReturnType<typeof getPgClient>>, queueName: string, msgIds: number[]) {
  try {
    if (msgIds.length === 0)
      return
    // Use pg's array syntax
    await db.query(
      `${PGMQ_UNCACHED}SELECT pgmq.archive($1, $2::bigint[])`,
      [queueName, msgIds],
    )
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? error.stack : undefined
    const msgIdsTruncated = msgIds.length > 20 ? msgIds.slice(0, 20) : msgIds

    cloudlogErr({
      requestId: c.get('requestId'),
      message: `[${queueName}] Failed to archive ${msgIds.length} messages`,
      error,
      errorMessage,
      errorStack,
      queueName,
      msgIds: msgIdsTruncated,
      msgIdsLength: msgIds.length,
    })

    throw simpleError('error_archiving_queue_messages', `Error archiving queue messages: ${errorMessage}`, { msgIds: msgIdsTruncated, msgIdsLength: msgIds.length, queueName, errorMessage }, error)
  }
}

// Helper function to mass update queue messages with CF IDs
async function mass_edit_queue_messages_cf_ids(
  c: Context,
  db: Awaited<ReturnType<typeof getPgClient>>,
  updates: Array<{ msg_id: number, cf_id: string, queue: string }>,
) {
  try {
    // Build the array of ROW values as a string
    // Note: With pg library, we need to sanitize values to prevent SQL injection
    const rowValues = updates.map((u) => {
      // Escape single quotes in cf_id and queue
      const escapedCfId = u.cf_id.replace(/'/g, '\'\'')
      const escapedQueue = u.queue.replace(/'/g, '\'\'')
      return `ROW(${u.msg_id}::bigint, '${escapedCfId}'::varchar, '${escapedQueue}'::varchar)::message_update`
    }).join(',')

    await db.query(`${PGMQ_UNCACHED}
      SELECT mass_edit_queue_messages_cf_ids(
        ARRAY[${rowValues}]
      )
    `)
  }
  catch (error) {
    throw simpleError('error_updating_cf_ids', 'Error updating CF IDs', {}, error)
  }
}

// --- Relayed messages (Cloudflare Queues) ---

// What the relay (queue_relay.ts) sends to Cloudflare Queues: ids only, so a
// message never hits the 128 KB Cloudflare Queues limit and its body is read
// from pgmq once, when processing starts.
export const relayedQueueMessageSchema = z.object({
  queue_name: z.string().regex(PGMQ_QUEUE_NAME_PATTERN),
  msg_id: z.number().int().positive(),
  read_ct: z.number().int().nonnegative(),
  wait_for_completion: z.boolean().optional(),
})

export type RelayedQueueMessage = z.infer<typeof relayedQueueMessageSchema>

/**
 * Takes the relayed messages and counts the read, like pgmq.read does for the
 * HTTP consumer. The read_ct must still be the one the message was relayed
 * with, so each relayed copy is claimed at most once: a Cloudflare Queues
 * retry or redelivery, or a copy relayed again after its visibility timeout,
 * matches nothing once one copy was claimed, and every attempt uses one of the
 * MAX_QUEUE_READS reads. It also restarts the visibility timeout, so time spent
 * waiting in Cloudflare Queues does not eat into processing time. A top-level
 * UPDATE is never served from the Hyperdrive query cache.
 */
export function relayedQueueClaimSql(queueName: string): string {
  if (!PGMQ_QUEUE_NAME_PATTERN.test(queueName))
    throw simpleError('invalid_queue_name', 'Invalid pgmq queue name', { queueName })
  return `UPDATE pgmq."q_${queueName}" AS m
SET vt = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => $3::double precision), read_ct = m.read_ct + 1
FROM ROWS FROM (pg_catalog.unnest($1::bigint[]), pg_catalog.unnest($2::integer[])) AS relayed(msg_id, read_ct)
WHERE m.msg_id = relayed.msg_id AND m.read_ct = relayed.read_ct
RETURNING m.msg_id, m.message, m.read_ct`
}

async function claimRelayedQueueMessages(
  c: Context,
  db: Awaited<ReturnType<typeof getPgClient>>,
  queueName: string,
  relayed: RelayedQueueMessage[],
): Promise<Message[]> {
  const result = await db.query(relayedQueueClaimSql(queueName), [
    relayed.map(message => message.msg_id),
    relayed.map(message => message.read_ct),
    getQueueVisibilityTimeout(queueName),
  ])
  const claimed = [...result.rows].sort((a, b) => Number(a.msg_id) - Number(b.msg_id))
  if (claimed.length !== relayed.length) {
    cloudlog({
      requestId: c.get('requestId'),
      message: `[${queueName}] Skipped relayed messages that another copy already claimed.`,
      claimedCount: claimed.length,
      relayedCount: relayed.length,
    })
  }
  return takeValidQueueMessages(c, db, queueName, claimed)
}

export interface RelayedQueueBatchResult {
  results: Record<string, QueueProcessResult>
  /** Queues whose claim failed: Cloudflare Queues should deliver their messages again. */
  retryQueues: string[]
}

/**
 * Cloudflare Queues consumer side: processes one delivered batch exactly like
 * /sync processes a pgmq read (same archive, ack, Discord and cf_id handling),
 * only the read is replaced by the claim above. pgmq stays the retry
 * authority: a failed message is not deleted, so it becomes readable again and
 * the next wakeup relays it with a higher read_ct.
 */
export async function processRelayedQueueMessages(c: Context, relayed: RelayedQueueMessage[]): Promise<RelayedQueueBatchResult> {
  const byQueue = new Map<string, RelayedQueueMessage[]>()
  for (const message of relayed) {
    const group = byQueue.get(message.queue_name)
    if (group)
      group.push(message)
    else
      byQueue.set(message.queue_name, [message])
  }
  const batch: RelayedQueueBatchResult = { results: {}, retryQueues: [] }
  if (byQueue.size === 0)
    return batch

  const db = await getPgClient(c)
  try {
    // One queue at a time, each settled before the next: the connection
    // budget (getRelayedQueueConcurrency) holds for every queue, and a failure
    // in one queue never ends the invocation while another queue's claimed
    // messages are still running.
    for (const [queueName, group] of byQueue) {
      let messages: Message[]
      try {
        messages = await claimRelayedQueueMessages(c, db, queueName, group)
      }
      catch (error) {
        // The claim either did not commit, so no read was counted, or it did
        // and a redelivery matches nothing: delivering again is always safe.
        cloudlogErr({ requestId: c.get('requestId'), message: 'pgmq_relay_claim_failed', queueName, count: group.length, error })
        batch.retryQueues.push(queueName)
        continue
      }
      if (messages.length === 0) {
        batch.results[queueName] = emptyQueueProcessResult(true)
        continue
      }
      try {
        const waitForCompletion = group.some(message => message.wait_for_completion === true)
        batch.results[queueName] = await processQueueMessages(c, db, queueName, messages, getRelayedQueueConcurrency(queueName), waitForCompletion)
      }
      catch (error) {
        // The reads are counted, so a redelivery would match nothing: pgmq
        // makes the unfinished messages readable again.
        cloudlogErr({ requestId: c.get('requestId'), message: 'pgmq_relay_process_failed', queueName, count: messages.length, error })
      }
    }
    return batch
  }
  finally {
    await closeClient(c, db)
  }
}

// --- Hono app setup ---
function shouldRunQueueSyncInBackground(queueName: string): boolean {
  return queueName !== 'on_manifest_create' && !isOnboardingQueue(queueName)
}

function isOnboardingQueue(queueName: string): boolean {
  return queueName === 'cron_onboarding_refresh_apps'
}

async function runQueueSync(
  c: Context,
  queueName: string,
  finalBatchSize: number,
  executionMode: 'background' | 'awaited',
  waitForCompletion = false,
): Promise<QueueProcessResult> {
  cloudlog({ requestId: c.get('requestId'), message: `[Queue Sync] Starting ${executionMode} execution for queue: ${queueName} with batch size: ${finalBatchSize}` })
  let db: Awaited<ReturnType<typeof getPgClient>> | null = null
  try {
    db = await getPgClient(c)
    const result = await processQueue(c, db, queueName, finalBatchSize, waitForCompletion)
    cloudlog({
      requestId: c.get('requestId'),
      message: result.success
        ? `[Queue Sync] ${executionMode} execution finished successfully.`
        : `[Queue Sync] ${executionMode} execution finished with queue failures.`,
      executionMode,
      result,
    })
    return result
  }
  finally {
    if (db)
      await closeClient(c, db)
    cloudlog({ requestId: c.get('requestId'), message: `[Queue Sync] ${executionMode} PostgreSQL connection closed.` })
  }
}
export const app = new Hono<MiddlewareKeyVariables>()

// /health endpoint
app.get('/health', (c) => {
  return c.text('OK', 200)
})

app.use('/sync', middlewareAPISecret)

// /sync endpoint
app.post('/sync', async (c) => {
  const handlerStart = Date.now()
  cloudlog({ requestId: c.get('requestId'), message: `[Sync Request] Received trigger to process queue.` })

  // Require JSON body with queue_name and optional batch_size
  const body = await parseBody<{ queue_name: string, batch_size?: number, wait_for_completion?: boolean }>(c)
  const queueName = body?.queue_name
  const batchSize = body?.batch_size
  const waitForCompletion = body?.wait_for_completion === true

  if (!queueName || typeof queueName !== 'string') {
    throw simpleError('missing_or_invalid_queue_name', 'Missing or invalid queue_name in body', { body })
  }

  // Only validate when batchSize is explicitly provided
  if (batchSize !== undefined) {
    if (typeof batchSize !== 'number' || batchSize <= 0) {
      throw simpleError('invalid_batch_size', 'batch_size must be a positive number', { batchSize })
    }
  }

  // Compute finalBatchSize: use provided batchSize capped with DEFAULT_BATCH_SIZE, or fall back to DEFAULT_BATCH_SIZE.
  const requestedBatchSize = batchSize !== undefined ? Math.min(batchSize, DEFAULT_BATCH_SIZE) : DEFAULT_BATCH_SIZE
  const finalBatchSize = getQueueBatchSize(queueName, requestedBatchSize)
  if (finalBatchSize !== requestedBatchSize) {
    cloudlog({
      requestId: c.get('requestId'),
      message: `[Sync Request] Queue batch size capped for ${queueName}.`,
      requestedBatchSize,
      finalBatchSize,
    })
  }

  if (shouldRunQueueSyncInBackground(queueName) && !waitForCompletion) {
    await backgroundTask(c, runQueueSync(c, queueName, finalBatchSize, 'background'))
    cloudlog({ requestId: c.get('requestId'), message: `[Sync Request] Responding 202 Accepted. Time: ${Date.now() - handlerStart}ms` })
    return c.json(BRES, 202)
  }

  await runQueueSync(c, queueName, finalBatchSize, 'awaited', waitForCompletion)
  cloudlog({ requestId: c.get('requestId'), message: `[Sync Request] Responding 202 Accepted after awaited queue processing. Time: ${Date.now() - handlerStart}ms` })
  return c.json(BRES, 202)
})

export const __queueConsumerTestUtils__ = {
  defaultBatchSize: DEFAULT_BATCH_SIZE,
  emptyQueueProcessResult,
  extractErrorDetails,
  extractMessageBody,
  getQueueMessageTrace,
  getActionableQueueFailures,
  getManifestRecordFromQueueBody,
  getQueueBatchSize,
  manifestQueueHttpConcurrency: MANIFEST_QUEUE_HTTP_CONCURRENCY,
  mapWithConcurrency,
  getQueueAckChunkSize,
  getQueueHttpConcurrency,
  getQueueHttpTimeoutMs,
  getQueueMaxReads,
  httpExceptionToQueueResponse,
  getQueueVisibilityTimeout,
  isSuccessfulQueueResult,
  normalizeQueueFunctionType,
  partitionQueueResultsForAck,
  prepareQueueHttpBody,
  shouldRunQueueSyncInBackground,
  queueFailureResponse,
  resolveFunctionUrl,
  sanitizeDiscordResponseBody,
  stripAppVersionManifestFromQueueBody,
  takeValidQueueMessages,
}
