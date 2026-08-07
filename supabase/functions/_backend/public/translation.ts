import type { Context } from 'hono'
import type { AiBinding } from '../utils/workers_ai.ts'
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

type MessageEntry = [string, string]

const sourceMessageCatalog = sourceMessages as Record<string, string>
const pendingTranslations = new Map<string, Promise<void>>()

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
    if (translations && Object.values(translations).every(entry => typeof entry === 'string'))
      return translations as Record<string, string>
    if (Object.values(record).every(entry => typeof entry === 'string'))
      return record as Record<string, string>
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

function placeholders(value: string) {
  return value.match(PLACEHOLDER_PATTERN) ?? []
}

function keepTranslation(source: string, translated: unknown) {
  if (typeof translated !== 'string')
    return source

  const normalized = translated.trim()
  if (!normalized)
    return source

  const requiredPlaceholders = placeholders(source)
  if (!requiredPlaceholders.every(token => normalized.includes(token)))
    return source

  return normalized
}

function buildBatches(messages: Record<string, string>) {
  const batches: MessageEntry[][] = []
  let current: MessageEntry[] = []
  let currentCharacters = 0

  for (const entry of Object.entries(messages)) {
    const nextCharacters = entry[0].length + entry[1].length
    if (current.length > 0 && (current.length >= MAX_BATCH_ITEMS || currentCharacters + nextCharacters > MAX_BATCH_CHARACTERS)) {
      batches.push(current)
      current = []
      currentCharacters = 0
    }

    current.push(entry)
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
              'Translate user-facing text naturally. Keep product names, code, URLs, commands, numbers, and placeholders unchanged.',
              'Every placeholder like {count}, %name%, or $1 must be copied exactly.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              messages: Object.fromEntries(batch),
            }),
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
  const checksum = await sha256Hex(JSON.stringify(messages))
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
