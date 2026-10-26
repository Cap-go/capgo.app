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

interface QueueStoreStatement {
  params: unknown[]
  sql: string
}

// Enough D1 for one queue step: a pending catalog entry, batch claims, and translation memory.
function createQueueStoreMock(memory: Map<string, string>) {
  const writes: QueueStoreStatement[] = []
  // Rows only match the pipeline that wrote them (draft-model, review disabled).
  const memoryRows = (params: unknown[]) => (params[1] === 'draft-model' ? params.slice(2) : [])
    .filter((hash): hash is string => typeof hash === 'string' && memory.has(hash))
    .map(hash => ({ source_hash: hash, translated: memory.get(hash) }))
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...nextParams: unknown[]) => statement(sql, nextParams),
    first: async () => {
      if (sql.includes('SELECT checksum, messages')) {
        return {
          checksum: params[1],
          messages: '{}',
          model: 'draft-model',
          next_batch_index: 0,
          status: 'pending',
          target_language: params[0],
          updated_at: Math.floor(Date.now() / 1000),
        }
      }
      return null
    },
    run: async () => {
      writes.push({ sql, params })
      return { meta: { changes: 1 } }
    },
  })
  return {
    writes,
    db: {
      prepare: vi.fn((sql: string) => statement(sql)),
      batch: vi.fn(async (statements: QueueStoreStatement[]) => statements.map((item) => {
        if (item.sql.includes(`SELECT source_hash`))
          return { results: memoryRows(item.params) }
        writes.push(item)
        return { results: [] }
      })),
    },
  }
}

async function rememberAllMessagesExcept(skippedKeys: string[]) {
  const memory = new Map<string, string>()
  const contexts = sourceMessageContexts as Record<string, string>
  await Promise.all(Object.entries(sourceMessages as Record<string, unknown>).map(async ([key, text]) => {
    if (key === '$schema' || typeof text !== 'string' || skippedKeys.includes(key))
      return
    memory.set(await __translationWorkerTestUtils__.translationMemoryHash(text, contexts[key]?.trim() ?? ''), `fr:${key}`)
  }))
  return memory
}

async function runQueueStep(memory: Map<string, string>, ai: { run: ReturnType<typeof vi.fn> }) {
  stubWorkerCache()
  const store = createQueueStoreMock(memory)
  const queue = { send: vi.fn() }
  const message = {
    ack: vi.fn(),
    body: {
      batchIndex: 0,
      checksum: await __translationWorkerTestUtils__.currentSourceChecksum({ TRANSLATION_REVIEW_MODEL: 'none' }),
      model: 'draft-model',
      targetLanguage: 'fr',
    },
    retry: vi.fn(),
  }
  await translationWorker.queue({ messages: [message] } as any, {
    AI: ai,
    DB_TRANSLATIONS: store.db,
    TRANSLATION_MESSAGES_QUEUE: queue,
    TRANSLATION_REVIEW_MODEL: 'none',
  } as any, {} as any)
  expect(message.ack).toHaveBeenCalledTimes(1)
  return { queue, writes: store.writes }
}

function readyCatalogWrite(writes: QueueStoreStatement[]) {
  const write = writes.find(item => item.sql.includes(`UPDATE translation_messages_cache`) && item.params[1] === 'ready')
  return write ? JSON.parse(write.params[2] as string) as Record<string, string> : null
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

  it.concurrent('adds the French glossary only to French prompts', () => {
    const frenchPrompt = __translationWorkerTestUtils__.translationPrompt('fr')
    expect(frenchPrompt).toContain('channel -> canal')
    expect(frenchPrompt).toContain('AI -> IA')
    expect(__translationWorkerTestUtils__.reviewPrompt('fr')).toContain('channel -> canal')

    const germanPrompt = __translationWorkerTestUtils__.translationPrompt('de')
    expect(germanPrompt).toContain('to German')
    expect(germanPrompt).toContain('Keep the English developer terms')
    expect(germanPrompt).not.toContain('channel -> canal')
  })

  it.concurrent('disables thinking only for hybrid reasoning models', () => {
    const batch: [string, string, string][] = [['save', 'Save', '']]
    expect(__translationWorkerTestUtils__.translationRequest('@cf/deepseek-ai/deepseek-v4.1-flash-1017', 'fr', batch))
      .toMatchObject({ chat_template_kwargs: { enable_thinking: false }, temperature: 0 })
    expect(__translationWorkerTestUtils__.translationRequest('@cf/meta/llama-3.1-8b-instruct-fast', 'fr', batch))
      .not.toHaveProperty('chat_template_kwargs')
  })

  it.concurrent('applies the review pass and keeps drafts when the review fails', async () => {
    const batch: [string, string, string][] = [['channel', 'Channel', ''], ['observe', 'Observe', ''], ['save', 'Save', '']]
    const reviewedAi = {
      run: vi.fn()
        .mockResolvedValueOnce({ response: JSON.stringify({ translations: { channel: 'Chaîne', observe: 'Observer', save: 'Enregistrer' } }) })
        .mockResolvedValueOnce({ response: JSON.stringify({ translations: { channel: 'Canal', observe: 'Observe' } }) }),
    }
    // A review back to the English source is kept; a missing review entry keeps the draft.
    await expect(__translationWorkerTestUtils__.translateBatch(reviewedAi, 'translator', 'fr', batch, 'reviewer'))
      .resolves
      .toEqual({
        messages: { channel: 'Canal', observe: 'Observe', save: 'Enregistrer' },
        remembered: { channel: 'Canal', observe: 'Observe' },
      })
    expect(reviewedAi.run).toHaveBeenLastCalledWith('reviewer', expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.stringContaining('"draft":"Chaîne"') }),
      ]),
    }))

    const failingReviewAi = {
      run: vi.fn()
        .mockResolvedValueOnce({ response: JSON.stringify({ translations: { channel: 'Canal', save: 'Enregistrer' } }) })
        .mockRejectedValue(new Error('review unavailable')),
    }
    // Unreviewed drafts are served but not remembered, so a later catalog change reviews them.
    await expect(__translationWorkerTestUtils__.translateBatch(failingReviewAi, 'translator', 'fr', batch, 'reviewer'))
      .resolves
      .toEqual({ messages: { channel: 'Canal', observe: 'Observe', save: 'Enregistrer' }, remembered: {} })
  })

  it.concurrent('reviews with DeepSeek V4.1 Flash by default and lets env override or disable it', () => {
    expect(__translationWorkerTestUtils__.getTranslationReviewModel({})).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017')
    expect(__translationWorkerTestUtils__.getTranslationReviewModel({ TRANSLATION_REVIEW_MODEL: '@cf/custom/model' })).toBe('@cf/custom/model')
    expect(__translationWorkerTestUtils__.getTranslationReviewModel({ TRANSLATION_REVIEW_MODEL: 'none' })).toBeNull()
  })

  it.concurrent('replaces typographic non-breaking hyphens in translations', () => {
    expect(__translationWorkerTestUtils__.keepTranslation('Are you sure?', 'Êtes\u2011vous sûr ?')).toBe('Êtes-vous sûr ?')
  })

  it.concurrent('keeps source text when translation drops a placeholder', () => {
    expect(__translationWorkerTestUtils__.keepTranslation('Used {count} times', 'Utilise plusieurs fois')).toBe('Used {count} times')
  })

  it.concurrent('unwraps AI {text,context} blobs before keeping translations', () => {
    expect(__translationWorkerTestUtils__.unwrapTranslatedMessage(
      '{"text":"Mot de passe","context":"Used in Capgo web console areas: pages."}',
    )).toBe('Mot de passe')
    expect(__translationWorkerTestUtils__.keepTranslation(
      'Password',
      '{"text":"Mot de passe","context":"Used in Capgo web console areas: pages."}',
    )).toBe('Mot de passe')
    expect(__translationWorkerTestUtils__.keepTranslation(
      'Create a free account',
      '{"text":"Créer un compte gratuit"}',
    )).toBe('Créer un compte gratuit')
    expect(__translationWorkerTestUtils__.unwrapTranslatedMessage('Compte')).toBe('Compte')
    expect(__translationWorkerTestUtils__.unwrapTranslatedMessage('Save ')).toBe('Save ')
    expect(__translationWorkerTestUtils__.keepTranslation('Save ', 'Save ')).toBe('Save ')
    expect(__translationWorkerTestUtils__.unwrapTranslatedMessage('{"text":" "}')).toBeNull()
    expect(__translationWorkerTestUtils__.unwrapTranslatedMessage({ text: ' ' })).toBeNull()
    expect(__translationWorkerTestUtils__.unwrapTranslatedMessage('{}')).toBeNull()
    expect(__translationWorkerTestUtils__.unwrapTranslatedMessage('{"context":"x"}')).toBeNull()
    expect(__translationWorkerTestUtils__.keepTranslation('Password', '{}')).toBe('Password')
    expect(__translationWorkerTestUtils__.keepTranslation('Password', '{"text":" "}')).toBe('Password')
    expect(__translationWorkerTestUtils__.keepTranslation('Password', { text: 'Mot de passe ' })).toBe('Mot de passe ')
    expect(__translationWorkerTestUtils__.unwrapTranslatedMessage({ text: ' Mot de passe ' })).toBe(' Mot de passe ')
    expect(__translationWorkerTestUtils__.unwrapTranslatedMessage('{not-json')).toBe('{not-json')
  })

  it.concurrent('parses object-shaped translation values from Workers AI', () => {
    expect(__translationWorkerTestUtils__.parseTranslationObject({
      translations: {
        password: { text: 'Mot de passe', context: 'short UI label' },
        save: 'Enregistrer ',
      },
    })).toEqual({
      password: 'Mot de passe',
      save: 'Enregistrer ',
    })
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
      messages: JSON.stringify({
        'account': 'Compte',
        'discord-username-help': 'Sans le signe @.',
        'password': '{"text":"Mot de passe","context":"Used in Capgo web console areas: pages."}',
      }),
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
      messages: {
        'account': 'Compte',
        'discord-username-help': 'Sans le signe {\'@\'}.',
        'password': 'Mot de passe',
      },
      model: 'model',
      status: 'ready',
    })
    expect(queue.send).not.toHaveBeenCalled()
  })

  it('sanitizes legacy ready translation cache hits', async () => {
    stubWorkerCache(new Response(JSON.stringify({
      checksum: 'checksum',
      messages: {
        'discord-username-help': 'Sans le signe @.',
        'password': '{"text":"Mot de passe","context":"Used in Capgo web console areas: pages."}',
        'create-a-free-account': '{"text":"Créer un compte gratuit"}',
        'blank-wrapper': '{"text":" "}',
        'object-wrapper': { text: 'Valeur legacy', context: 'legacy object blob' },
        'save': 'Save ',
      },
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
    expect(payload.messages.password).toBe('Mot de passe')
    expect(payload.messages['create-a-free-account']).toBe('Créer un compte gratuit')
    expect(payload.messages['blank-wrapper']).toBeUndefined()
    expect(payload.messages['object-wrapper']).toBe('Valeur legacy')
    expect(payload.messages.save).toBe('Save ')
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
  it('only sends strings missing from translation memory to Workers AI', async () => {
    const changedKeys = ['account', 'password']
    const memory = await rememberAllMessagesExcept(changedKeys)
    const ai = {
      run: vi.fn(async () => ({ response: JSON.stringify({ translations: { account: 'Compte', password: 'Mot de passe' } }) })),
    }

    const { queue, writes } = await runQueueStep(memory, ai)

    expect(ai.run).toHaveBeenCalledTimes(1)
    const request = (ai.run.mock.calls[0] as unknown[])[1] as { messages: Array<{ content: string }> }
    expect(Object.keys(JSON.parse(request.messages[1].content).messages).sort()).toEqual(changedKeys)
    const catalog = readyCatalogWrite(writes)
    expect(catalog?.account).toBe('Compte')
    expect(catalog?.password).toBe('Mot de passe')
    expect(catalog?.dashboard).toBe('fr:dashboard')
    expect(Object.keys(catalog ?? {}).length).toBe(Object.keys(sourceMessages).filter(key => key !== '$schema').length)
    const remembered = writes.filter(item => item.sql.includes('INSERT INTO translation_memory'))
    expect(remembered.map(item => item.params[2]).sort()).toEqual(['Compte', 'Mot de passe'])
    expect(queue.send).not.toHaveBeenCalled()
  })

  it('finishes a catalog without Workers AI when every string is in translation memory', async () => {
    const ai = { run: vi.fn() }

    const { writes } = await runQueueStep(await rememberAllMessagesExcept([]), ai)

    expect(ai.run).not.toHaveBeenCalled()
    expect(readyCatalogWrite(writes)?.dashboard).toBe('fr:dashboard')
  })

  it('does not remember strings that fell back to English', async () => {
    const memory = await rememberAllMessagesExcept(['account', 'password'])
    const ai = {
      run: vi.fn(async () => ({ response: JSON.stringify({ translations: { password: 'Password' } }) })),
    }

    const { writes } = await runQueueStep(memory, ai)

    // A missing answer falls back to English and is not remembered; a valid answer equal
    // to the source (a name kept in English) is.
    expect(readyCatalogWrite(writes)?.account).toBe('Account')
    const remembered = writes.filter(item => item.sql.includes('INSERT INTO translation_memory'))
    expect(remembered.map(item => item.params[2])).toEqual(['Password'])
  })

  it.concurrent('changes the catalog checksum when the translation or review model changes', async () => {
    const checksum = await __translationWorkerTestUtils__.currentSourceChecksum({})

    expect(checksum).toBe(await __translationWorkerTestUtils__.currentSourceChecksum({}))
    expect(checksum).not.toBe(await __translationWorkerTestUtils__.currentSourceChecksum({ TRANSLATION_REVIEW_MODEL: 'none' }))
    expect(checksum).not.toBe(await __translationWorkerTestUtils__.currentSourceChecksum({ TRANSLATION_MODEL: '@cf/custom/model' }))
  })

  it.concurrent('keys translation memory by text and context', async () => {
    const hash = await __translationWorkerTestUtils__.translationMemoryHash('Save', 'button')

    expect(hash).toBe(await __translationWorkerTestUtils__.translationMemoryHash('Save', 'button'))
    expect(hash).not.toBe(await __translationWorkerTestUtils__.translationMemoryHash('Save', 'page title'))
    expect(hash).not.toBe(await __translationWorkerTestUtils__.translationMemoryHash('Save changes', 'button'))
  })
})
