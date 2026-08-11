import type { D1Database, ExecutionContext, MessageBatch, Queue } from '@cloudflare/workers-types'
import sourceMessageContexts from '../../messages/en.context.json' with { type: 'json' }
import sourceMessages from '../../messages/en.json' with { type: 'json' }

const CACHE_TTL_SECONDS = 5 * 60
const PENDING_TRANSLATION_STORE_TTL_SECONDS = 60 * 60
const READY_TRANSLATION_STORE_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_TRANSLATION_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'
const MAX_BATCH_CHARACTERS = 6_000
const MAX_BATCH_ITEMS = 60
const TRANSLATION_ATTEMPTS = 3
const TRANSLATION_CACHE_PATH = '/translation/messages-cache'
const TRANSLATION_STORE_CLEANUP_INTERVAL_SECONDS = 60
const TRANSLATION_REQUEUE_AFTER_SECONDS = 60
const TRANSLATION_BATCH_LEASE_SECONDS = 15 * 60
const TRANSLATION_STORE_TABLE = 'translation_messages_cache'
const CLAIMED_TRANSLATION_BATCH_INDEX_OFFSET = 1_000_000_000
const PLACEHOLDER_PATTERN = /\{[\w.]+\}|%\w+%?|\$\d+/g

const SUPPORTED_LANGUAGES = new Set([
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'pl',
  'pt',
  'pt-br',
  'ru',
  'tr',
  'vi',
  'zh',
  'zh-cn',
])

const TRANSLATION_ALLOWED_LANGUAGES = new Set([
  'de',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'pl',
  'pt',
  'ru',
  'tr',
  'vi',
  'zh',
])

const LANGUAGE_NAMES: Record<string, string> = {
  'de': 'German',
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'hi': 'Hindi',
  'id': 'Indonesian',
  'it': 'Italian',
  'ja': 'Japanese',
  'ko': 'Korean',
  'pl': 'Polish',
  'pt': 'Portuguese',
  'pt-br': 'Brazilian Portuguese',
  'ru': 'Russian',
  'tr': 'Turkish',
  'vi': 'Vietnamese',
  'zh': 'Simplified Chinese',
  'zh-cn': 'Simplified Chinese',
}

interface AiBinding {
  run: (model: string, input: unknown) => Promise<unknown>
}

interface TranslationWorkerBindings {
  AI?: AiBinding
  DB_TRANSLATIONS?: D1Database
  ENV_NAME?: string
  TRANSLATION_MESSAGES_QUEUE?: Queue<Required<TranslationQueuePayload>>
  TRANSLATION_MODEL?: string
}

interface TranslationBody {
  targetLanguage?: string
}

interface TranslationMessagesResponsePayload {
  checksum: string
  messages: Record<string, string>
  model: string
  status: 'ready'
}

type TranslationStoreStatus = 'pending' | 'ready'

interface TranslationStoreEntry {
  checksum: string
  messages: Record<string, string>
  model: string
  nextBatchIndex: number
  status: TranslationStoreStatus
  targetLanguage: string
  updatedAt: number
}

interface TranslationQueuePayload {
  batchIndex?: number
  checksum?: string
  model?: string
  targetLanguage?: string
}

type MessageEntry = [string, string, string]
type TranslationStoreEntryInput = Omit<TranslationStoreEntry, 'updatedAt'>

interface TranslationPromptMessage {
  context?: string
  text: string
}

interface ReadyTranslationWriteInput {
  batchCount?: number
  checksum: string
  claimedBatchIndex?: number
  env: TranslationWorkerBindings
  messages: Record<string, string>
  model: string
  nextBatchIndex: number
  readyRequest: Request
  requestId: string | undefined
  targetLanguage: string
}

interface TranslatedBatchPersistenceInput {
  batchIndex: number
  batches: MessageEntry[][]
  checksum: string
  env: TranslationWorkerBindings
  mergedMessages: Record<string, string>
  model: string
  readyRequest: Request
  requestId: string | undefined
  targetLanguage: string
}

class PublicHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function catalogWithoutSchema(messages: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(messages).filter((entry): entry is [string, string] => entry[0] !== '$schema' && typeof entry[1] === 'string'),
  )
}

const sourceMessageCatalog = catalogWithoutSchema(sourceMessages as Record<string, unknown>)
const sourceMessageContextCatalog = catalogWithoutSchema(sourceMessageContexts as Record<string, unknown>)
// Context uses stable folder areas + UI role (not file names), so renames inside a
// folder do not invalidate translation caches. Area/role changes still should.
const sourceCatalogChecksumPromise = sha256Hex(JSON.stringify({
  contexts: sourceMessageContextCatalog,
  messages: sourceMessageCatalog,
})) // NOSONAR: top-level await is disallowed by lint config.
let translationStoreInitialized = false
let lastTranslationStoreCleanupAt = 0

function fail(status: number, code: string, message: string): never {
  throw new PublicHttpError(status, code, message)
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Origin': '*',
  }
}

function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
      ...headers,
    },
  })
}

function errorResponse(status: number, code: string, message: string) {
  return jsonResponse({ error: code, message }, status)
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    }
  }
  return error
}

function cloudlog(payload: Record<string, unknown>) {
  console.log(JSON.stringify(payload))
}

function cloudlogErr(payload: Record<string, unknown>) {
  console.error(JSON.stringify(payload))
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T
  }
  catch {
    return {} as T
  }
}

function requestIdFrom(request: Request) {
  return request.headers.get('x-request-id') ?? crypto.randomUUID()
}

function getTranslationModel(env: TranslationWorkerBindings) {
  return env.TRANSLATION_MODEL || DEFAULT_TRANSLATION_MODEL
}

function targetLanguageLabel(targetLanguage: string) {
  const label = LANGUAGE_NAMES[targetLanguage]
  return typeof label === 'string' ? label : targetLanguage
}

function isTranslationLanguageAllowed(targetLanguage: string) {
  return TRANSLATION_ALLOWED_LANGUAGES.has(targetLanguage)
}

async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', data)
  let encoded = ''
  for (const byte of new Uint8Array(hash))
    encoded += byte.toString(16).padStart(2, '0')
  return encoded
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null
  return value as Record<string, unknown>
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string')
    return content

  const parts: string[] = []
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item)
      }
      else {
        const itemRecord = recordOf(item)
        if (typeof itemRecord?.text === 'string') {
          parts.push(itemRecord.text)
        }
      }
    }
  }
  return parts.join('')
}

function extractAiFieldText(value: unknown): string {
  if (typeof value === 'string')
    return value

  if (Array.isArray(value))
    return extractContentText(value)

  const valueRecord = recordOf(value)
  return valueRecord ? extractAiText(valueRecord) : ''
}

function extractAiChoiceText(choice: unknown): string {
  const choiceRecord = recordOf(choice)
  if (typeof choiceRecord?.text === 'string')
    return choiceRecord.text

  const message = recordOf(choiceRecord?.message)
  return extractContentText(message?.content)
}

function extractAiText(result: unknown): string {
  if (typeof result === 'string')
    return result

  const resultRecord = recordOf(result)
  if (!resultRecord)
    return ''

  for (const key of ['response', 'text', 'result', 'output']) {
    const text = extractAiFieldText(resultRecord[key])
    if (text)
      return text
  }

  const choices = resultRecord.choices
  if (!Array.isArray(choices))
    return ''

  for (const choice of choices) {
    const text = extractAiChoiceText(choice)
    if (text)
      return text
  }

  return ''
}

function translatedTextFromEntry(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim()
    return trimmed || null
  }

  const record = recordOf(entry)
  if (typeof record?.text === 'string') {
    const trimmed = record.text.trim()
    return trimmed || null
  }

  return null
}

function stringMapFromRecord(record: Record<string, unknown> | null): Record<string, string> | null {
  if (!record)
    return null

  const output: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    const value = translatedTextFromEntry(entry)
    if (value === null)
      return null
    output[key] = value
  }
  return output
}

function jsonCandidates(value: string) {
  const trimmed = value.trim()
  if (!trimmed)
    return []

  const candidates = [trimmed]
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace)
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))

  return [...new Set(candidates)]
}

function parseJsonCandidate(value: string) {
  try {
    return JSON.parse(value) as unknown
  }
  catch {
    return undefined
  }
}

function parseTranslationObject(value: unknown): Record<string, string> | null {
  const record = recordOf(value)
  const wrappedRecord = stringMapFromRecord(recordOf(record?.translations))
  if (wrappedRecord)
    return wrappedRecord

  const flatRecord = stringMapFromRecord(record)
  if (flatRecord)
    return flatRecord

  if (typeof value !== 'string')
    return null

  for (const candidate of jsonCandidates(value)) {
    const parsed = parseJsonCandidate(candidate)
    const parsedRecord = parsed === undefined ? null : parseTranslationObject(parsed)
    if (parsedRecord)
      return parsedRecord
  }
  return null
}

function unwrapTranslatedMessage(translated: string) {
  const trimmed = translated.trim()
  if (!trimmed.startsWith('{'))
    return trimmed

  const parsed = parseJsonCandidate(trimmed)
  const record = recordOf(parsed)
  if (!record || typeof record.text !== 'string')
    return trimmed

  const unwrapped = record.text.trim()
  return unwrapped || trimmed
}

function keepTranslation(source: string, translated: unknown) {
  const candidate = typeof translated === 'string' ? unwrapTranslatedMessage(translated) : ''
  if (!candidate)
    return source

  const missingPlaceholder = (source.match(PLACEHOLDER_PATTERN) ?? []).some(token => !candidate.includes(token))
  return missingPlaceholder ? source : candidate
}

function shouldFlushBatch(current: MessageEntry[], currentCharacters: number, nextCharacters: number) {
  return current.length > 0 && (current.length >= MAX_BATCH_ITEMS || currentCharacters + nextCharacters > MAX_BATCH_CHARACTERS)
}

function messageContextFor(key: string, contexts: Record<string, string> = sourceMessageContextCatalog) {
  const context = contexts[key]
  return typeof context === 'string' ? context.trim() : ''
}

function buildBatches(messages: Record<string, string>, contexts: Record<string, string> = sourceMessageContextCatalog) {
  const batches: MessageEntry[][] = []
  let current: MessageEntry[] = []
  let currentCharacters = 0

  const flush = () => {
    if (!current.length)
      return
    batches.push(current)
    current = []
    currentCharacters = 0
  }

  for (const [key, message] of Object.entries(messages)) {
    const context = messageContextFor(key, contexts)
    const entry: MessageEntry = [key, message, context]
    const entryCharacters = key.length + message.length + context.length
    if (shouldFlushBatch(current, currentCharacters, entryCharacters))
      flush()
    current.push(entry)
    currentCharacters += entryCharacters
  }

  flush()
  return batches
}

const translationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    translations: {
      type: 'object',
      additionalProperties: {
        type: 'string',
      },
    },
  },
  required: ['translations'],
}

function translationPrompt(targetLanguage: string) {
  return [
    `Translate Capgo application UI messages from English to ${targetLanguageLabel(targetLanguage)}.`,
    'Return JSON only, with a translations object keyed by the exact input keys.',
    'Each input value is an object with text (translate this) and optional context (where/how the text is used in the Capgo console UI).',
    'Use context to disambiguate meaning, tone, and part of speech (button label vs title vs status vs empty state).',
    'Translate only the text field. Do not translate or copy context into the output.',
    'Each translations value must be a plain string of the translated text only, never a JSON object or {text, context} wrapper.',
    'Translate user-facing text naturally. Keep product names, code, URLs, commands, numbers, and placeholders unchanged.',
    'Every placeholder like {count}, %name%, or $1 must be copied exactly.',
  ].join(' ')
}

function translationBatchPayload(batch: MessageEntry[]) {
  const messages: Record<string, TranslationPromptMessage> = {}
  for (const [key, text, context] of batch) {
    messages[key] = context
      ? { text, context }
      : { text }
  }
  return { messages }
}

function translationRequest(targetLanguage: string, batch: MessageEntry[]) {
  return {
    temperature: 0,
    max_tokens: 8192,
    response_format: {
      type: 'json_schema',
      json_schema: translationResponseSchema,
    },
    messages: [
      {
        role: 'system',
        content: translationPrompt(targetLanguage),
      },
      {
        role: 'user',
        content: JSON.stringify(translationBatchPayload(batch)),
      },
    ],
  }
}

function translatedBatch(batch: MessageEntry[], translations: Record<string, string>) {
  if (!batch.some(([key]) => typeof translations[key] === 'string'))
    throw new Error('Workers AI returned no translated messages')

  return Object.fromEntries(batch.map(([key, source]) => [
    key,
    keepTranslation(source, translations[key]),
  ] as const))
}

function normalizeTranslationError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

async function translateBatch(ai: AiBinding, model: string, targetLanguage: string, batch: MessageEntry[]) {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= TRANSLATION_ATTEMPTS; attempt += 1) {
    try {
      const result = await ai.run(model, translationRequest(targetLanguage, batch))
      const translations = parseTranslationObject(extractAiText(result) || result)
      if (!translations)
        throw new Error('Workers AI returned invalid JSON')
      return translatedBatch(batch, translations)
    }
    catch (error) {
      lastError = normalizeTranslationError(error)
      cloudlog({
        message: 'Message translation batch failed',
        targetLanguage,
        attempt,
        batchSize: batch.length,
        error: lastError.message,
      })
    }
  }

  throw lastError ?? new Error('Message translation failed')
}

function messageCatalogOf(value: unknown): Record<string, string> {
  if (typeof value === 'string') {
    try {
      return messageCatalogOf(JSON.parse(value))
    }
    catch {
      return {}
    }
  }

  const record = recordOf(value)
  if (!record)
    return {}

  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function escapeVueI18nAtSigns(message: string) {
  const escapedAtSign = '{\'@\'}'
  let output = ''

  for (let index = 0; index < message.length;) {
    if (message.startsWith(escapedAtSign, index)) {
      output += escapedAtSign
      index += escapedAtSign.length
    }
    else if (message[index] === '@') {
      output += escapedAtSign
      index += 1
    }
    else {
      output += message[index]
      index += 1
    }
  }

  return output
}

function vueI18nMessageCatalog(messages: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(messages).map(([key, message]) => [
      key,
      escapeVueI18nAtSigns(unwrapTranslatedMessage(message)),
    ]),
  )
}

function getTranslationStore(env: TranslationWorkerBindings) {
  if (!env.DB_TRANSLATIONS)
    fail(503, 'translation_unavailable', 'Cloudflare D1 translation store is not configured')

  return env.DB_TRANSLATIONS
}

function getTranslationQueue(env: TranslationWorkerBindings) {
  if (!env.TRANSLATION_MESSAGES_QUEUE)
    fail(503, 'translation_unavailable', 'Cloudflare translation queue is not configured')

  return env.TRANSLATION_MESSAGES_QUEUE
}

async function ensureTranslationStore(db: D1Database) {
  if (translationStoreInitialized)
    return

  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${TRANSLATION_STORE_TABLE} (
       target_language TEXT NOT NULL,
       checksum TEXT NOT NULL,
       model TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ready')),
       messages TEXT NOT NULL DEFAULT '{}',
       next_batch_index INTEGER NOT NULL DEFAULT 0 CHECK(next_batch_index >= 0),
       expires_at INTEGER NOT NULL,
       created_at INTEGER NOT NULL DEFAULT (unixepoch()),
       updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
       PRIMARY KEY (target_language, checksum)
     )`,
  ).run()
  await db.prepare(
    `CREATE INDEX IF NOT EXISTS idx_${TRANSLATION_STORE_TABLE}_expires_at
     ON ${TRANSLATION_STORE_TABLE} (expires_at)`,
  ).run()
  translationStoreInitialized = true
}

function parseTranslationStoreEntry(row: unknown): TranslationStoreEntry | null {
  const record = recordOf(row)
  if (!record)
    return null

  const status = record.status
  const checksum = record.checksum
  const model = record.model
  const targetLanguage = record.target_language
  const nextBatchIndex = Number(record.next_batch_index)
  const updatedAt = Number(record.updated_at)
  if ((status !== 'pending' && status !== 'ready') || typeof checksum !== 'string' || typeof model !== 'string' || typeof targetLanguage !== 'string' || !Number.isInteger(nextBatchIndex) || !Number.isFinite(updatedAt))
    return null

  return {
    checksum,
    messages: messageCatalogOf(record.messages),
    model,
    nextBatchIndex,
    status,
    targetLanguage,
    updatedAt,
  }
}

function readyPayloadFromStore(entry: TranslationStoreEntry): TranslationMessagesResponsePayload {
  return {
    checksum: entry.checksum,
    messages: vueI18nMessageCatalog(entry.messages),
    model: entry.model,
    status: 'ready',
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function translationStoreEntry(input: TranslationStoreEntryInput): TranslationStoreEntry {
  return {
    ...input,
    updatedAt: nowSeconds(),
  }
}

function translationQueuePayload(checksum: string, targetLanguage: string, model: string, batchIndex: number): Required<TranslationQueuePayload> {
  return {
    batchIndex,
    checksum,
    model,
    targetLanguage,
  }
}

function isPendingTranslationStale(entry: TranslationStoreEntry) {
  return entry.status === 'pending' && nowSeconds() - entry.updatedAt >= TRANSLATION_REQUEUE_AFTER_SECONDS
}

function isReadyTranslationFresh(entry: TranslationStoreEntry) {
  return entry.status === 'ready' && nowSeconds() - entry.updatedAt < CACHE_TTL_SECONDS
}

function isTranslationBatchLeaseExpired(entry: TranslationStoreEntry) {
  return entry.status === 'pending' && nowSeconds() - entry.updatedAt >= TRANSLATION_BATCH_LEASE_SECONDS
}

function claimedTranslationBatchIndex(nextBatchIndex: number) {
  return nextBatchIndex >= CLAIMED_TRANSLATION_BATCH_INDEX_OFFSET ? nextBatchIndex - CLAIMED_TRANSLATION_BATCH_INDEX_OFFSET : null
}

function translationBatchIndexFromStore(nextBatchIndex: number) {
  return claimedTranslationBatchIndex(nextBatchIndex) ?? nextBatchIndex
}

function translationBatchClaimMarker(batchIndex: number) {
  return CLAIMED_TRANSLATION_BATCH_INDEX_OFFSET + batchIndex
}

async function deleteExpiredTranslationStoreEntries(db: D1Database) {
  const now = nowSeconds()
  if (now - lastTranslationStoreCleanupAt < TRANSLATION_STORE_CLEANUP_INTERVAL_SECONDS)
    return

  await db.prepare(`DELETE FROM ${TRANSLATION_STORE_TABLE} WHERE expires_at <= unixepoch()`).run()
  lastTranslationStoreCleanupAt = now
}

async function readTranslationStoreEntry(env: TranslationWorkerBindings, checksum: string, targetLanguage: string) {
  const db = getTranslationStore(env)
  await ensureTranslationStore(db)
  await deleteExpiredTranslationStoreEntries(db)
  const row = await db.prepare(
    `SELECT checksum, messages, model, next_batch_index, status, target_language, updated_at
     FROM ${TRANSLATION_STORE_TABLE}
     WHERE target_language = ?
       AND checksum = ?
       AND expires_at > unixepoch()
     LIMIT 1`,
  ).bind(targetLanguage, checksum).first()

  return parseTranslationStoreEntry(row)
}

async function readLatestReadyTranslationStoreEntry(env: TranslationWorkerBindings, targetLanguage: string) {
  const db = getTranslationStore(env)
  await ensureTranslationStore(db)
  await deleteExpiredTranslationStoreEntries(db)
  const row = await db.prepare(
    `SELECT checksum, messages, model, next_batch_index, status, target_language, updated_at
     FROM ${TRANSLATION_STORE_TABLE}
     WHERE target_language = ?
       AND status = 'ready'
       AND expires_at > unixepoch()
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).bind(targetLanguage).first()

  return parseTranslationStoreEntry(row)
}

function translationStoreTtlSeconds(entry: Pick<TranslationStoreEntry, 'status'>) {
  return entry.status === 'pending' ? PENDING_TRANSLATION_STORE_TTL_SECONDS : READY_TRANSLATION_STORE_TTL_SECONDS
}

async function upsertTranslationStoreEntry(db: D1Database, entry: TranslationStoreEntry, ttlSeconds = translationStoreTtlSeconds(entry)) {
  await db.prepare(
    `INSERT INTO ${TRANSLATION_STORE_TABLE} (
       target_language,
       checksum,
       model,
       status,
       messages,
       next_batch_index,
       expires_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, unixepoch() + ?, unixepoch())
     ON CONFLICT (target_language, checksum) DO UPDATE
     SET model = excluded.model,
         status = excluded.status,
         messages = excluded.messages,
         next_batch_index = excluded.next_batch_index,
         expires_at = excluded.expires_at,
         updated_at = unixepoch()`,
  ).bind(entry.targetLanguage, entry.checksum, entry.model, entry.status, JSON.stringify(entry.messages), entry.nextBatchIndex, ttlSeconds).run()
}

async function writeTranslationStoreEntry(env: TranslationWorkerBindings, entry: TranslationStoreEntry) {
  const db = getTranslationStore(env)
  await ensureTranslationStore(db)
  await deleteExpiredTranslationStoreEntries(db)
  await upsertTranslationStoreEntry(db, entry)
}

async function writeClaimedTranslationStoreEntry(env: TranslationWorkerBindings, entry: TranslationStoreEntry, batchIndex: number) {
  const db = getTranslationStore(env)
  await ensureTranslationStore(db)
  await deleteExpiredTranslationStoreEntries(db)
  const result = await db.prepare(
    `UPDATE ${TRANSLATION_STORE_TABLE}
     SET model = ?,
         status = ?,
         messages = ?,
         next_batch_index = ?,
         expires_at = unixepoch() + ?,
         updated_at = unixepoch()
     WHERE target_language = ?
       AND checksum = ?
       AND status = 'pending'
       AND next_batch_index = ?
       AND expires_at > unixepoch()`,
  ).bind(entry.model, entry.status, JSON.stringify(entry.messages), entry.nextBatchIndex, translationStoreTtlSeconds(entry), entry.targetLanguage, entry.checksum, translationBatchClaimMarker(batchIndex)).run()

  return result.meta.changes > 0
}

async function insertPendingTranslationStoreEntry(env: TranslationWorkerBindings, entry: TranslationStoreEntry) {
  const db = getTranslationStore(env)
  await ensureTranslationStore(db)
  await deleteExpiredTranslationStoreEntries(db)
  const result = await db.prepare(
    `INSERT INTO ${TRANSLATION_STORE_TABLE} (
       target_language,
       checksum,
       model,
       status,
       messages,
       next_batch_index,
       expires_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, unixepoch() + ?, unixepoch())
     ON CONFLICT (target_language, checksum) DO UPDATE
     SET model = excluded.model,
         status = excluded.status,
         messages = excluded.messages,
         next_batch_index = excluded.next_batch_index,
         expires_at = excluded.expires_at,
         updated_at = unixepoch()
     WHERE ${TRANSLATION_STORE_TABLE}.expires_at <= unixepoch()`,
  ).bind(entry.targetLanguage, entry.checksum, entry.model, entry.status, JSON.stringify(entry.messages), entry.nextBatchIndex, PENDING_TRANSLATION_STORE_TTL_SECONDS).run()

  return result.meta.changes > 0
}

async function touchTranslationStoreEntry(env: TranslationWorkerBindings, entry: TranslationStoreEntry) {
  const db = getTranslationStore(env)
  await ensureTranslationStore(db)
  await db.prepare(
    `UPDATE ${TRANSLATION_STORE_TABLE}
     SET expires_at = unixepoch() + ?,
         updated_at = unixepoch()
     WHERE target_language = ?
       AND checksum = ?`,
  ).bind(translationStoreTtlSeconds(entry), entry.targetLanguage, entry.checksum).run()
}

async function claimTranslationBatch(env: TranslationWorkerBindings, checksum: string, targetLanguage: string, batchIndex: number) {
  const db = getTranslationStore(env)
  await ensureTranslationStore(db)
  const result = await db.prepare(
    `UPDATE ${TRANSLATION_STORE_TABLE}
     SET next_batch_index = ?,
         expires_at = unixepoch() + ?,
         updated_at = unixepoch()
     WHERE target_language = ?
       AND checksum = ?
       AND status = 'pending'
       AND next_batch_index = ?
       AND expires_at > unixepoch()`,
  ).bind(translationBatchClaimMarker(batchIndex), PENDING_TRANSLATION_STORE_TTL_SECONDS, targetLanguage, checksum, batchIndex).run()

  return result.meta.changes > 0
}

async function releaseTranslationBatchClaim(env: TranslationWorkerBindings, checksum: string, targetLanguage: string, batchIndex: number) {
  const db = getTranslationStore(env)
  await ensureTranslationStore(db)
  const result = await db.prepare(
    `UPDATE ${TRANSLATION_STORE_TABLE}
     SET next_batch_index = ?,
         expires_at = unixepoch() + ?,
         updated_at = unixepoch()
     WHERE target_language = ?
       AND checksum = ?
       AND status = 'pending'
       AND next_batch_index = ?`,
  ).bind(batchIndex, PENDING_TRANSLATION_STORE_TTL_SECONDS, targetLanguage, checksum, translationBatchClaimMarker(batchIndex)).run()

  return result.meta.changes > 0
}

async function deleteTranslationStoreEntry(env: TranslationWorkerBindings, entry: TranslationStoreEntry) {
  const db = getTranslationStore(env)
  await ensureTranslationStore(db)
  await db.prepare(
    `DELETE FROM ${TRANSLATION_STORE_TABLE}
     WHERE target_language = ?
       AND checksum = ?`,
  ).bind(entry.targetLanguage, entry.checksum).run()
}

function workerCache() {
  return (caches as CacheStorage & { default: Cache }).default
}

function buildTranslationCacheRequest(checksum: string, targetLanguage: string) {
  const url = new URL(TRANSLATION_CACHE_PATH, 'https://translation-cache.capgo.local')
  url.searchParams.set('checksum', checksum)
  url.searchParams.set('lang', targetLanguage)
  return new Request(url.toString())
}

async function matchReadyTranslationPayload(request: Request) {
  const cached = await workerCache().match(request)
  if (!cached)
    return null

  try {
    const payload = await cached.json() as TranslationMessagesResponsePayload
    return { ...payload, messages: vueI18nMessageCatalog(payload.messages) }
  }
  catch {
    return null
  }
}

async function cacheReadyTranslationPayload(requestId: string | undefined, readyRequest: Request, payload: TranslationMessagesResponsePayload, targetLanguage: string) {
  try {
    await workerCache().put(readyRequest, new Response(JSON.stringify(payload), {
      headers: {
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
        'Content-Type': 'application/json',
      },
    }))
  }
  catch (error) {
    cloudlogErr({
      requestId,
      message: 'Unable to cache ready translation payload',
      error: serializeError(error),
      targetLanguage,
      cacheKey: readyRequest.url,
    })
  }
}

async function enqueueTranslationBatch(env: TranslationWorkerBindings, payload: Required<TranslationQueuePayload>, requestId?: string) {
  const queue = getTranslationQueue(env)
  await queue.send(payload, { contentType: 'json' })
  cloudlog({
    requestId,
    message: 'Queued message catalog translation batch',
    batchIndex: payload.batchIndex,
    targetLanguage: payload.targetLanguage,
  })
}

async function queueTranslationIfNeeded(env: TranslationWorkerBindings, payload: Required<TranslationQueuePayload>, requestId?: string) {
  const pendingEntry = translationStoreEntry({
    checksum: payload.checksum,
    messages: {},
    model: payload.model,
    nextBatchIndex: payload.batchIndex,
    status: 'pending',
    targetLanguage: payload.targetLanguage,
  })

  const claimed = await insertPendingTranslationStoreEntry(env, pendingEntry)
  if (!claimed) {
    const existingEntry = await readTranslationStoreEntry(env, payload.checksum, payload.targetLanguage)
    if (existingEntry)
      return existingEntry

    fail(503, 'translation_unavailable', 'Translation queue is not available')
  }

  try {
    await enqueueTranslationBatch(env, payload, requestId)
  }
  catch (error) {
    await deleteTranslationStoreEntry(env, pendingEntry).catch(() => {})
    throw error
  }

  return pendingEntry
}

function normalizeBatchIndex(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    return 0
  return value
}

function currentSourceChecksum() {
  return sourceCatalogChecksumPromise
}

function pendingTranslationResponse(checksum: string) {
  return jsonResponse({ checksum, status: 'pending' }, 202, {
    'Cache-Control': 'no-store',
    'Retry-After': '10',
  })
}

async function readyTranslationResponse(requestId: string | undefined, readyRequest: Request, entry: TranslationStoreEntry, targetLanguage: string) {
  const payload = readyPayloadFromStore(entry)
  await cacheReadyTranslationPayload(requestId, readyRequest, payload, targetLanguage)
  return jsonResponse(payload, 200, {
    'Cache-Control': `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`,
  })
}

function latestReadyTranslationResponse(entry: TranslationStoreEntry, checksum: string) {
  return jsonResponse(readyPayloadFromStore(entry), 200, {
    'Cache-Control': 'no-store',
    'X-Capgo-Translation-Refreshing-Checksum': checksum,
    'X-Capgo-Translation-Stale': '1',
  })
}

async function readyOrLatestTranslationResponse(requestId: string | undefined, readyRequest: Request, entry: TranslationStoreEntry, targetLanguage: string, checksum: string) {
  if (entry.checksum === checksum)
    return readyTranslationResponse(requestId, readyRequest, entry, targetLanguage)

  return latestReadyTranslationResponse(entry, checksum)
}

async function requeueStaleTranslation(env: TranslationWorkerBindings, storedEntry: TranslationStoreEntry, checksum: string, targetLanguage: string, requestId: string) {
  const claimedBatchIndex = claimedTranslationBatchIndex(storedEntry.nextBatchIndex)
  if (claimedBatchIndex !== null && !isTranslationBatchLeaseExpired(storedEntry))
    return

  try {
    await enqueueTranslationBatch(env, translationQueuePayload(
      checksum,
      targetLanguage,
      storedEntry.model,
      translationBatchIndexFromStore(storedEntry.nextBatchIndex),
    ), requestId)
    if (claimedBatchIndex === null)
      await touchTranslationStoreEntry(env, storedEntry)
  }
  catch (error) {
    cloudlogErr({
      requestId,
      message: 'Unable to requeue stale message catalog translation',
      error: serializeError(error),
      targetLanguage,
    })
    fail(503, 'translation_unavailable', 'Translation queue is not available')
  }
}

async function currentReadyTranslationResponse(env: TranslationWorkerBindings, requestId: string | undefined, readyRequest: Request, entry: TranslationStoreEntry, targetLanguage: string, checksum: string) {
  if (isReadyTranslationFresh(entry))
    return readyOrLatestTranslationResponse(requestId, readyRequest, entry, targetLanguage, checksum)

  if (entry.checksum !== checksum)
    return null

  await touchTranslationStoreEntry(env, entry)
  return readyTranslationResponse(requestId, readyRequest, entry, targetLanguage)
}

async function queueCurrentTranslationResponse(env: TranslationWorkerBindings, requestId: string, readyRequest: Request, checksum: string, targetLanguage: string, model: string) {
  const queuedEntry = await queueTranslationIfNeeded(env, translationQueuePayload(checksum, targetLanguage, model, 0), requestId)
  if (queuedEntry.status === 'ready') {
    await touchTranslationStoreEntry(env, queuedEntry)
    return readyTranslationResponse(requestId, readyRequest, queuedEntry, targetLanguage)
  }
  if (queuedEntry.status === 'pending' && isPendingTranslationStale(queuedEntry))
    await requeueStaleTranslation(env, queuedEntry, checksum, targetLanguage, requestId)
  return null
}

async function handleTranslationMessages(request: Request, env: TranslationWorkerBindings) {
  const requestId = requestIdFrom(request)
  const body = await parseJsonBody<TranslationBody>(request)
  const targetLanguage = typeof body.targetLanguage === 'string' ? body.targetLanguage.trim().toLowerCase() : ''
  if (!SUPPORTED_LANGUAGES.has(targetLanguage))
    fail(400, 'unsupported_translation_language', 'Target language is not supported')

  if (targetLanguage === 'en')
    fail(400, 'unsupported_translation_language', 'English messages are already bundled')

  if (!isTranslationLanguageAllowed(targetLanguage))
    fail(400, 'unsupported_translation_language', 'Target language is not enabled')

  const checksum = await currentSourceChecksum()
  const model = getTranslationModel(env)
  const readyRequest = buildTranslationCacheRequest(checksum, targetLanguage)

  const cached = await matchReadyTranslationPayload(readyRequest)
  if (cached) {
    return jsonResponse(cached, 200, {
      'Cache-Control': `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`,
    })
  }

  const latestReadyEntry = await readLatestReadyTranslationStoreEntry(env, targetLanguage)
  if (latestReadyEntry) {
    const readyResponse = await currentReadyTranslationResponse(env, requestId, readyRequest, latestReadyEntry, targetLanguage, checksum)
    if (readyResponse)
      return readyResponse
  }

  try {
    const queuedResponse = await queueCurrentTranslationResponse(env, requestId, readyRequest, checksum, targetLanguage, model)
    if (queuedResponse)
      return queuedResponse
  }
  catch (error) {
    cloudlogErr({
      requestId,
      message: 'Unable to queue message catalog translation',
      error: serializeError(error),
      targetLanguage,
    })
    if (latestReadyEntry)
      return latestReadyTranslationResponse(latestReadyEntry, checksum)
    fail(503, 'translation_unavailable', 'Translation queue is not available')
  }

  if (latestReadyEntry)
    return latestReadyTranslationResponse(latestReadyEntry, checksum)

  return pendingTranslationResponse(checksum)
}

function queuedTargetLanguage(body: TranslationQueuePayload, requestId: string | undefined) {
  const targetLanguage = typeof body.targetLanguage === 'string' ? body.targetLanguage.trim().toLowerCase() : ''
  if (SUPPORTED_LANGUAGES.has(targetLanguage) && targetLanguage !== 'en' && isTranslationLanguageAllowed(targetLanguage))
    return targetLanguage

  cloudlogErr({
    requestId,
    message: 'Ignoring disabled or unsupported queued translation language',
    targetLanguage,
  })
  return null
}

function queuedModel(body: TranslationQueuePayload, env: TranslationWorkerBindings) {
  return typeof body.model === 'string' && body.model.trim() ? body.model : getTranslationModel(env)
}

function logStaleQueuedMessage(body: TranslationQueuePayload, checksum: string, targetLanguage: string, requestId: string | undefined) {
  cloudlog({
    requestId,
    message: 'Ignoring stale queued translation message',
    queuedChecksum: body.checksum,
    checksum,
    targetLanguage,
  })
}

async function cacheReadyStoreEntry(env: TranslationWorkerBindings, checksum: string, targetLanguage: string, requestId: string | undefined, readyRequest: Request) {
  const storedEntry = await readTranslationStoreEntry(env, checksum, targetLanguage)
  if (storedEntry?.status === 'ready')
    await cacheReadyTranslationPayload(requestId, readyRequest, readyPayloadFromStore(storedEntry), targetLanguage)
  return storedEntry
}

async function nextProcessableBatchIndex(env: TranslationWorkerBindings, storedEntry: TranslationStoreEntry, checksum: string, targetLanguage: string, batchIndex: number) {
  const claimedBatchIndex = claimedTranslationBatchIndex(storedEntry.nextBatchIndex)
  if (claimedBatchIndex === null)
    return storedEntry.nextBatchIndex

  if (batchIndex !== claimedBatchIndex)
    return null

  if (!isTranslationBatchLeaseExpired(storedEntry))
    return null

  const released = await releaseTranslationBatchClaim(env, checksum, targetLanguage, batchIndex)
  return released ? claimedBatchIndex : null
}

async function writeReadyTranslation(input: ReadyTranslationWriteInput) {
  const {
    batchCount,
    checksum,
    claimedBatchIndex,
    env,
    messages,
    model,
    nextBatchIndex,
    readyRequest,
    requestId,
    targetLanguage,
  } = input
  const readyEntry = translationStoreEntry({
    checksum,
    messages,
    model,
    nextBatchIndex,
    status: 'ready',
    targetLanguage,
  })
  const written = claimedBatchIndex === undefined
    ? (await writeTranslationStoreEntry(env, readyEntry), true)
    : await writeClaimedTranslationStoreEntry(env, readyEntry, claimedBatchIndex)
  if (!written)
    return false

  await cacheReadyTranslationPayload(requestId, readyRequest, readyPayloadFromStore(readyEntry), targetLanguage)

  if (batchCount !== undefined) {
    cloudlog({
      requestId,
      message: 'Message catalog translation cached',
      targetLanguage,
      batchCount,
    })
  }
  return true
}

async function translateOwnedBatch(ai: AiBinding, env: TranslationWorkerBindings, checksum: string, targetLanguage: string, model: string, batches: MessageEntry[][], batchIndex: number) {
  const batch = batches[batchIndex]
  if (!batch) {
    await releaseTranslationBatchClaim(env, checksum, targetLanguage, batchIndex).catch(() => {})
    return null
  }

  try {
    return await translateBatch(ai, model, targetLanguage, batch)
  }
  catch (error) {
    await releaseTranslationBatchClaim(env, checksum, targetLanguage, batchIndex).catch(() => {})
    throw error
  }
}

async function persistTranslatedBatch(input: TranslatedBatchPersistenceInput) {
  const {
    batchIndex,
    batches,
    checksum,
    env,
    mergedMessages,
    model,
    readyRequest,
    requestId,
    targetLanguage,
  } = input
  const followingBatchIndex = batchIndex + 1

  if (followingBatchIndex >= batches.length) {
    await writeReadyTranslation({
      batchCount: batches.length,
      checksum,
      claimedBatchIndex: batchIndex,
      env,
      messages: mergedMessages,
      model,
      nextBatchIndex: followingBatchIndex,
      readyRequest,
      requestId,
      targetLanguage,
    })
    return
  }

  const written = await writeClaimedTranslationStoreEntry(env, translationStoreEntry({
    checksum,
    messages: mergedMessages,
    model,
    nextBatchIndex: followingBatchIndex,
    status: 'pending',
    targetLanguage,
  }), batchIndex)
  if (!written)
    return

  await enqueueTranslationBatch(env, translationQueuePayload(checksum, targetLanguage, model, followingBatchIndex), requestId)
}

async function processTranslationQueueBatch(env: TranslationWorkerBindings, body: TranslationQueuePayload, requestId?: string) {
  const targetLanguage = queuedTargetLanguage(body, requestId)
  if (!targetLanguage)
    return

  const checksum = await currentSourceChecksum()
  if (body.checksum !== checksum) {
    logStaleQueuedMessage(body, checksum, targetLanguage, requestId)
    return
  }

  const model = queuedModel(body, env)
  const ai = env.AI
  if (!ai)
    fail(503, 'translation_unavailable', 'Workers AI binding is not configured')

  const readyRequest = buildTranslationCacheRequest(checksum, targetLanguage)
  if (await matchReadyTranslationPayload(readyRequest))
    return

  const storedEntry = await cacheReadyStoreEntry(env, checksum, targetLanguage, requestId, readyRequest)
  if (storedEntry?.status !== 'pending')
    return

  const batches = buildBatches(sourceMessageCatalog)
  const batchIndex = normalizeBatchIndex(body.batchIndex)
  const nextBatchIndex = await nextProcessableBatchIndex(env, storedEntry, checksum, targetLanguage, batchIndex)
  if (nextBatchIndex === null)
    return

  if (nextBatchIndex >= batches.length) {
    await writeReadyTranslation({
      checksum,
      env,
      messages: storedEntry.messages,
      model,
      nextBatchIndex,
      readyRequest,
      requestId,
      targetLanguage,
    })
    return
  }

  if (batchIndex < nextBatchIndex)
    return

  if (batchIndex !== nextBatchIndex) {
    await enqueueTranslationBatch(env, translationQueuePayload(checksum, targetLanguage, model, nextBatchIndex), requestId)
    return
  }

  const claimed = await claimTranslationBatch(env, checksum, targetLanguage, batchIndex)
  if (!claimed)
    return

  const translatedBatch = await translateOwnedBatch(ai, env, checksum, targetLanguage, model, batches, batchIndex)
  if (!translatedBatch)
    return

  const mergedMessages = {
    ...storedEntry.messages,
    ...translatedBatch,
  }
  await persistTranslatedBatch({
    batchIndex,
    batches,
    checksum,
    env,
    mergedMessages,
    model,
    readyRequest,
    requestId,
    targetLanguage,
  })
}

async function fetchHandler(request: Request, env: TranslationWorkerBindings) {
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: corsHeaders() })

  const url = new URL(request.url)
  if (request.method === 'POST' && (url.pathname === '/translation/messages' || url.pathname === '/messages'))
    return handleTranslationMessages(request, env)

  return errorResponse(404, 'not_found', 'Not found')
}

export default {
  async fetch(request: Request, env: TranslationWorkerBindings) {
    try {
      return await fetchHandler(request, env)
    }
    catch (error) {
      if (error instanceof PublicHttpError)
        return errorResponse(error.status, error.code, error.message)

      cloudlogErr({
        requestId: requestIdFrom(request),
        message: 'Translation worker request failed',
        error: serializeError(error),
      })
      return errorResponse(500, 'internal_error', 'Internal server error')
    }
  },
  async queue(batch: MessageBatch<TranslationQueuePayload>, env: TranslationWorkerBindings, _ctx: ExecutionContext) {
    for (const message of batch.messages) {
      try {
        await processTranslationQueueBatch(env, message.body)
        message.ack()
      }
      catch (error) {
        cloudlogErr({
          message: 'Translation queue consumer error',
          error: serializeError(error),
          queueMessage: message.body,
        })
        message.retry({ delaySeconds: 30 })
      }
    }
  },
}

export const __translationWorkerTestUtils__ = {
  buildBatches,
  claimedTranslationBatchIndex,
  escapeVueI18nAtSigns,
  isReadyTranslationFresh,
  isTranslationBatchLeaseExpired,
  keepTranslation,
  normalizeBatchIndex,
  parseTranslationObject,
  translationBatchPayload,
  translationBatchClaimMarker,
  translationBatchIndexFromStore,
  translationPrompt,
  translationStoreTtlSeconds,
  unwrapTranslatedMessage,
}
