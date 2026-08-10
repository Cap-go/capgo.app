import { describe, expect, it, vi } from 'vitest'
import translationWorker, { __translationWorkerTestUtils__ } from '../cloudflare_workers/translation/index.ts'
import sourceMessageContexts from '../messages/en.context.json'
import sourceMessages from '../messages/en.json'

function stubWorkerCache(matchedResponse: Response | null = null) {
  const cache = {
    match: vi.fn(async () => matchedResponse),
    put: vi.fn(async () => undefined),
  }
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: cache },
  })
  return cache
}

function createTranslationStoreMock(latestReadyEntry: Record<string, unknown> | null) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (sql.includes('status = \'ready\'') && sql.includes('ORDER BY updated_at DESC'))
            return latestReadyEntry
          return null
        }),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    })),
  }
}

describe('translation queue helpers', () => {
  it.concurrent('keeps translator context for every English message key', () => {
    const messageKeys = Object.keys(sourceMessages).filter(key => key !== '$schema')
    const contextKeys = Object.keys(sourceMessageContexts)

    expect(contextKeys.sort()).toEqual(messageKeys.sort())
    expect(Object.values(sourceMessageContexts).every(value => typeof value === 'string' && value.trim().length > 0)).toBe(true)
  })

  it.concurrent('splits the English catalog into bounded queue batches', () => {
    const batches = __translationWorkerTestUtils__.buildBatches(sourceMessages as Record<string, string>)

    expect(batches.length).toBeGreaterThan(1)
    expect(batches.every(batch => batch.length <= 60)).toBe(true)
  })

  it.concurrent('includes usage context in translation batch payloads', () => {
    const payload = __translationWorkerTestUtils__.translationBatchPayload([
      ['Current', 'Current', 'Used in Capgo web console areas: pages/settings/organization. Role: filter or date-range option label.'],
      ['save', 'Save', ''],
    ])

    expect(payload).toEqual({
      messages: {
        Current: {
          text: 'Current',
          context: 'Used in Capgo web console areas: pages/settings/organization. Role: filter or date-range option label.',
        },
        save: {
          text: 'Save',
        },
      },
    })
    expect(__translationWorkerTestUtils__.translationPrompt('fr')).toContain('Use context to disambiguate')
  })

  it.concurrent('keeps source text when translation drops a placeholder', () => {
    expect(__translationWorkerTestUtils__.keepTranslation('Used {count} times', 'Utilise plusieurs fois')).toBe('Used {count} times')
  })

  it.concurrent('escapes raw and adjacent at signs for Vue i18n', () => {
    expect(__translationWorkerTestUtils__.escapeVueI18nAtSigns('Sans le signe @.')).toBe('Sans le signe {\'@\'}.')
    expect(__translationWorkerTestUtils__.escapeVueI18nAtSigns('@@capgo/cli@latest')).toBe('{\'@\'}{\'@\'}capgo/cli{\'@\'}latest')
  })

  it.concurrent('preserves escaped at signs across repeated passes', () => {
    const escaped = 'Sans le signe {\'@\'}.'

    expect(__translationWorkerTestUtils__.escapeVueI18nAtSigns(escaped)).toBe(escaped)
    expect(__translationWorkerTestUtils__.escapeVueI18nAtSigns(
      __translationWorkerTestUtils__.escapeVueI18nAtSigns('Sans le signe @.'),
    )).toBe(escaped)
  })

  it.concurrent('normalizes invalid queued batch indexes to the first batch', () => {
    expect(__translationWorkerTestUtils__.normalizeBatchIndex(-1)).toBe(0)
    expect(__translationWorkerTestUtils__.normalizeBatchIndex(1.5)).toBe(0)
    expect(__translationWorkerTestUtils__.normalizeBatchIndex(2)).toBe(2)
  })

  it.concurrent('maps claimed queue batch indexes back to their batch', () => {
    const marker = __translationWorkerTestUtils__.translationBatchClaimMarker(2)

    expect(marker).toBeGreaterThan(2)
    expect(__translationWorkerTestUtils__.claimedTranslationBatchIndex(marker)).toBe(2)
    expect(__translationWorkerTestUtils__.claimedTranslationBatchIndex(2)).toBeNull()
    expect(__translationWorkerTestUtils__.translationBatchIndexFromStore(marker)).toBe(2)
  })

  it.concurrent('keeps ready translations long enough to reuse while pending refreshes', () => {
    expect(__translationWorkerTestUtils__.translationStoreTtlSeconds({ status: 'ready' })).toBeGreaterThan(
      __translationWorkerTestUtils__.translationStoreTtlSeconds({ status: 'pending' }),
    )
  })

  it.concurrent('keeps active batch claims leased past stale polling checks', () => {
    type TranslationStoreEntryForTest = Parameters<typeof __translationWorkerTestUtils__.isTranslationBatchLeaseExpired>[0]

    const now = Math.floor(Date.now() / 1000)
    const entry: TranslationStoreEntryForTest = {
      checksum: 'checksum',
      messages: {},
      model: 'model',
      nextBatchIndex: __translationWorkerTestUtils__.translationBatchClaimMarker(0),
      status: 'pending',
      targetLanguage: 'fr',
      updatedAt: now - 61,
    }

    expect(__translationWorkerTestUtils__.isTranslationBatchLeaseExpired(entry)).toBe(false)
    expect(__translationWorkerTestUtils__.isTranslationBatchLeaseExpired({ ...entry, updatedAt: now - (15 * 60 + 1) })).toBe(true)
  })

  it.concurrent('checks ready translation freshness with a 5 minute window', () => {
    const now = Math.floor(Date.now() / 1000)

    expect(__translationWorkerTestUtils__.isReadyTranslationFresh({
      checksum: 'checksum',
      messages: {},
      model: 'model',
      nextBatchIndex: 1,
      status: 'ready',
      targetLanguage: 'fr',
      updatedAt: now - 299,
    })).toBe(true)
    expect(__translationWorkerTestUtils__.isReadyTranslationFresh({
      checksum: 'checksum',
      messages: {},
      model: 'model',
      nextBatchIndex: 1,
      status: 'ready',
      targetLanguage: 'fr',
      updatedAt: now - 300,
    })).toBe(false)
  })

  it('serves a recent saved translation without queueing a refresh', async () => {
    stubWorkerCache()
    const now = Math.floor(Date.now() / 1000)
    const latestReadyEntry = {
      checksum: 'previous-checksum',
      messages: JSON.stringify({ 'account': 'Compte', 'discord-username-help': 'Sans le signe @.' }),
      model: 'model',
      next_batch_index: 1,
      status: 'ready',
      target_language: 'fr',
      updated_at: now - 30,
    }
    const db = createTranslationStoreMock(latestReadyEntry)
    const queue = {
      send: vi.fn(),
    }
    const response = await translationWorker.fetch(new Request('https://api.capgo.app/translation/messages', {
      body: JSON.stringify({ targetLanguage: 'fr' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }), {
      DB_TRANSLATIONS: db,
      TRANSLATION_MESSAGES_QUEUE: queue,
    } as any)
    const payload = await response.json() as { checksum: string, messages: Record<string, string>, status: string }

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-capgo-translation-stale')).toBe('1')
    expect(payload).toEqual({
      checksum: 'previous-checksum',
      messages: { 'account': 'Compte', 'discord-username-help': 'Sans le signe {\'@\'}.' },
      model: 'model',
      status: 'ready',
    })
    expect(queue.send).not.toHaveBeenCalled()
  })

  it('sanitizes legacy ready translation cache hits', async () => {
    stubWorkerCache(new Response(JSON.stringify({
      checksum: 'checksum',
      messages: { 'discord-username-help': 'Sans le signe @.' },
      model: 'model',
      status: 'ready',
    })))
    const response = await translationWorker.fetch(new Request('https://api.capgo.app/translation/messages', {
      body: JSON.stringify({ targetLanguage: 'fr' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }), {} as any)
    const payload = await response.json() as { messages: Record<string, string> }

    expect(response.status).toBe(200)
    expect(payload.messages['discord-username-help']).toBe('Sans le signe {\'@\'}.')
  })

  it('serves the last saved translation and queues a refresh when the checksum changed', async () => {
    stubWorkerCache()
    const now = Math.floor(Date.now() / 1000)
    const latestReadyEntry = {
      checksum: 'previous-checksum',
      messages: JSON.stringify({ account: 'Compte' }),
      model: 'model',
      next_batch_index: 1,
      status: 'ready',
      target_language: 'fr',
      updated_at: now - 301,
    }
    const db = createTranslationStoreMock(latestReadyEntry)
    const queue = {
      send: vi.fn(),
    }
    const response = await translationWorker.fetch(new Request('https://api.capgo.app/translation/messages', {
      body: JSON.stringify({ targetLanguage: 'fr' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }), {
      DB_TRANSLATIONS: db,
      TRANSLATION_MESSAGES_QUEUE: queue,
    } as any)
    const payload = await response.json() as { checksum: string, messages: Record<string, string>, status: string }

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(payload.status).toBe('ready')
    expect(payload.checksum).toBe('previous-checksum')
    expect(queue.send).toHaveBeenCalledTimes(1)
  })

  it('queues the first translation and tells the frontend to retry later', async () => {
    stubWorkerCache()
    const db = createTranslationStoreMock(null)
    const queue = {
      send: vi.fn(),
    }
    const response = await translationWorker.fetch(new Request('https://api.capgo.app/translation/messages', {
      body: JSON.stringify({ targetLanguage: 'fr' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }), {
      DB_TRANSLATIONS: db,
      TRANSLATION_MESSAGES_QUEUE: queue,
    } as any)
    const payload = await response.json() as { status: string }

    expect(response.status).toBe(202)
    expect(payload.status).toBe('pending')
    expect(queue.send).toHaveBeenCalledTimes(1)
  })

  it('rejects supported aliases outside the public generation allow-list before queueing', async () => {
    const queue = {
      send: vi.fn(),
    }
    const response = await translationWorker.fetch(new Request('https://api.capgo.app/translation/messages', {
      body: JSON.stringify({ targetLanguage: 'pt-br' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }), {
      TRANSLATION_MESSAGES_QUEUE: queue,
    } as any)
    const payload = await response.json() as { error: string, message: string }

    expect(response.status).toBe(400)
    expect(payload.error).toBe('unsupported_translation_language')
    expect(payload.message).toBe('Target language is not enabled')
    expect(queue.send).not.toHaveBeenCalled()
  })

  it('ignores queued translations outside the generation allow-list before AI work', async () => {
    const ai = {
      run: vi.fn(),
    }
    const message = {
      ack: vi.fn(),
      body: {
        batchIndex: 0,
        checksum: 'checksum',
        model: 'model',
        targetLanguage: 'pt-br',
      },
      retry: vi.fn(),
    }

    await translationWorker.queue({ messages: [message] } as any, { AI: ai } as any, {} as any)

    expect(ai.run).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
  })
})
