import type { Context } from 'hono'
import type { AiBinding } from '../utils/workers_ai.ts'
import sourceMessageContexts from '../../../../messages/en.context.json'
import sourceMessages from '../../../../messages/en.json'
import { CacheHelper } from '../utils/cache.ts'
import { honoFactory, parseBody, quickError, useCors } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { backgroundTask, getEnv } from '../utils/utils.ts'
import { extractAiText, recordOf } from '../utils/workers_ai.ts'

const CACHE_TTL_SECONDS = 5 * 60
const DEFAULT_TRANSLATION_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast'
const MAX_BATCH_CHARACTERS = 6_000
const MAX_BATCH_ITEMS = 60
const TRANSLATION_ATTEMPTS = 3
const TRANSLATION_CACHE_PATH = '/translation/messages-cache'
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

interface TranslationBody {
  targetLanguage?: string
}

interface TranslationMessagesResponsePayload {
  checksum: string
  messages: Record<string, string>
  model: string
  status: 'ready'
}

type MessageEntry = [string, string, string]

interface TranslationPromptMessage {
  context?: string
  text: string
}

function catalogWithoutSchema(messages: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(messages).filter((entry): entry is [string, string] => entry[0] !== '$schema' && typeof entry[1] === 'string'),
  )
}

const sourceMessageCatalog = catalogWithoutSchema(sourceMessages as Record<string, unknown>)
const sourceMessageContextCatalog = catalogWithoutSchema(sourceMessageContexts as Record<string, unknown>)
const pendingTranslations = new Map<string, Promise<void>>()
// Context uses stable folder areas + UI role (not file names), so renames inside a
// folder do not invalidate translation caches. Area/role changes still should.
const sourceCatalogChecksumPromise = sha256Hex(JSON.stringify({
  contexts: sourceMessageContextCatalog,
  messages: sourceMessageCatalog,
}))

function getTranslationModel(c: Context) {
  return getEnv(c, 'TRANSLATION_MODEL') || DEFAULT_TRANSLATION_MODEL
}

function getTargetLanguageName(targetLanguage: string) {
  return LANGUAGE_NAMES[targetLanguage] ?? targetLanguage
}

async function sha256Hex(value: string) {
  const buffer = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function parseTranslationObject(value: unknown): Record<string, string> | null {
  const record = recordOf(value)
  if (record) {
    const translations = recordOf(record.translations)
    if (translations) {
      const unwrapped = unwrapTranslationRecord(translations)
      if (unwrapped)
        return unwrapped
    }
    const flat = unwrapTranslationRecord(record)
    if (flat)
      return flat
  }

  if (typeof value !== 'string')
    return null

  const trimmed = value.trim()
  if (!trimmed)
    return null

  try {
    return parseTranslationObject(JSON.parse(trimmed))
  }
  catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end <= start)
      return null
    try {
      return parseTranslationObject(JSON.parse(trimmed.slice(start, end + 1)))
    }
    catch {
      return null
    }
  }
}

function translatedTextFromEntry(entry: unknown): string | null {
  return unwrapTranslatedMessage(entry)
}

function unwrapTranslationRecord(record: Record<string, unknown>): Record<string, string> | null {
  const output: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    const value = translatedTextFromEntry(entry)
    if (value === null)
      return null
    output[key] = value
  }
  return output
}

function placeholders(value: string) {
  return value.match(PLACEHOLDER_PATTERN) ?? []
}

function unwrapTranslatedMessage(translated: unknown): string | null {
  if (typeof translated === 'string') {
    if (!translated.trim())
      return null

    const trimmedForParse = translated.trim()
    if (!trimmedForParse.startsWith('{'))
      return translated

    try {
      const parsed = JSON.parse(trimmedForParse) as unknown
      const record = recordOf(parsed)
      if (!record)
        return translated
      if (typeof record.text !== 'string' || !record.text.trim())
        return null
      return record.text
    }
    catch {
      return translated
    }
  }

  const record = recordOf(translated)
  if (typeof record?.text !== 'string')
    return null
  if (!record.text.trim())
    return null
  return record.text
}

function keepTranslation(source: string, translated: unknown) {
  const normalized = unwrapTranslatedMessage(translated)
  if (!normalized)
    return source

  const requiredPlaceholders = placeholders(source)
  if (!requiredPlaceholders.every(token => normalized.includes(token)))
    return source

  return normalized
}

function buildBatches(messages: Record<string, string>, contexts: Record<string, string> = sourceMessageContextCatalog) {
  const batches: MessageEntry[][] = []
  let current: MessageEntry[] = []
  let currentCharacters = 0

  for (const [key, message] of Object.entries(messages)) {
    const context = typeof contexts[key] === 'string' ? contexts[key].trim() : ''
    const nextCharacters = key.length + message.length + context.length
    if (current.length > 0 && (current.length >= MAX_BATCH_ITEMS || currentCharacters + nextCharacters > MAX_BATCH_CHARACTERS)) {
      batches.push(current)
      current = []
      currentCharacters = 0
    }

    current.push([key, message, context])
    currentCharacters += nextCharacters
  }

  if (current.length > 0)
    batches.push(current)

  return batches
}

function translationSchema() {
  return {
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

async function translateBatch(ai: AiBinding, model: string, targetLanguage: string, batch: MessageEntry[]) {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= TRANSLATION_ATTEMPTS; attempt += 1) {
    try {
      const result = await ai.run(model, {
        temperature: 0,
        max_tokens: 8192,
        response_format: {
          type: 'json_schema',
          json_schema: translationSchema(),
        },
        messages: [
          {
            role: 'system',
            content: [
              `Translate Capgo application UI messages from English to ${getTargetLanguageName(targetLanguage)}.`,
              'Return JSON only, with a translations object keyed by the exact input keys.',
              'Each input value is an object with text (translate this) and optional context (where/how the text is used in the Capgo console UI).',
              'Use context to disambiguate meaning, tone, and part of speech (button label vs title vs status vs empty state).',
              'Translate only the text field. Do not translate or copy context into the output.',
              'Each translations value must be a plain string of the translated text only, never a JSON object or {text, context} wrapper.',
              'Translate user-facing text naturally. Keep product names, code, URLs, commands, numbers, and placeholders unchanged.',
              'Every placeholder like {count}, %name%, or $1 must be copied exactly.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify(translationBatchPayload(batch)),
          },
        ],
      })

      const translations = parseTranslationObject(extractAiText(result) || result)
      if (!translations)
        throw new Error('Workers AI returned invalid JSON')

      if (!batch.some(([key]) => typeof translations[key] === 'string'))
        throw new Error('Workers AI returned no translated messages')

      return Object.fromEntries(
        batch.map(([key, source]) => [key, keepTranslation(source, translations[key])] as const),
      )
    }
    catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
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

async function translateMessages(ai: AiBinding, messages: Record<string, string>, targetLanguage: string, model: string) {
  const translated: Record<string, string> = {}
  const batches = buildBatches(messages)

  for (const batch of batches)
    Object.assign(translated, await translateBatch(ai, model, targetLanguage, batch))

  return translated
}

function startTranslation(c: Context, cacheHelper: CacheHelper, cacheRequest: Request, payload: Omit<TranslationMessagesResponsePayload, 'messages' | 'status'>, messages: Record<string, string>, targetLanguage: string, model: string) {
  const key = cacheRequest.url
  const existing = pendingTranslations.get(key)
  if (existing)
    return existing

  const ai = c.env.AI as AiBinding | undefined
  if (!ai)
    quickError(503, 'translation_unavailable', 'Workers AI binding is not configured')

  const pending = translateMessages(ai, messages, targetLanguage, model)
    .then(async translatedMessages => cacheHelper.putJson(cacheRequest, {
      ...payload,
      messages: translatedMessages,
      status: 'ready',
    } satisfies TranslationMessagesResponsePayload, CACHE_TTL_SECONDS))
    .catch((error) => {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'Workers AI message catalog translation failed',
        error,
        targetLanguage,
        messageCount: Object.keys(messages).length,
      })
    })
    .finally(() => {
      pendingTranslations.delete(key)
    })

  pendingTranslations.set(key, pending)
  void backgroundTask(c, pending)
  return pending
}

export const app = honoFactory.createApp()

app.use('*', useCors)

app.post('/messages', async (c) => {
  const body = await parseBody<TranslationBody>(c)
  const targetLanguage = typeof body.targetLanguage === 'string' ? body.targetLanguage.trim().toLowerCase() : ''
  if (!SUPPORTED_LANGUAGES.has(targetLanguage))
    quickError(400, 'unsupported_translation_language', 'Target language is not supported')

  if (targetLanguage === 'en')
    quickError(400, 'unsupported_translation_language', 'English messages are already bundled')

  const messages = sourceMessageCatalog
  const checksum = await sourceCatalogChecksumPromise
  const model = getTranslationModel(c)
  const cacheHelper = new CacheHelper(c)
  const cacheRequest = cacheHelper.buildRequest(TRANSLATION_CACHE_PATH, {
    checksum,
    lang: targetLanguage,
  })

  const cached = await cacheHelper.matchJson<TranslationMessagesResponsePayload>(cacheRequest)
  if (cached) {
    c.header('Cache-Control', `public, max-age=0, s-maxage=${CACHE_TTL_SECONDS}`)
    return c.json(cached)
  }

  startTranslation(c, cacheHelper, cacheRequest, { checksum, model }, messages, targetLanguage, model)
  c.header('Cache-Control', 'no-store')
  c.header('Retry-After', '10')
  return c.json({ checksum, status: 'pending' }, 202)
})
