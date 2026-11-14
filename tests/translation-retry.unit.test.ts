import type { D1Database } from '@cloudflare/workers-types'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import translationWorker, { __translationWorkerTestUtils__ as utils } from '../cloudflare_workers/translation/index.ts'
import sourceMessages from '../messages/en.json'
import sourceContexts from '../messages/en.context.json'

// Execute the worker's real SQL so claims, persisted progress and HTTP polling
// exercise the same state instead of assuming every D1 write succeeds.
const sqlite = new DatabaseSync(':memory:')
let beforeRun: ((sql: string, params: unknown[]) => void) | undefined
function statement(sql: string, params: unknown[] = []) {
  return {
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...params as never[]),
    run: async () => {
      beforeRun?.(sql, params)
      return { meta: { changes: Number(sqlite.prepare(sql).run(...params as never[]).changes) } }
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...params as never[]) }),
  }
}
const db = {
  prepare: statement,
  batch: async (statements: ReturnType<typeof statement>[]) => Promise.all(statements.map(item => item.all())),
} as unknown as D1Database
const env = {
  AI: { run: vi.fn() },
  DB_TRANSLATIONS: db,
  TRANSLATION_MESSAGES_QUEUE: { send: vi.fn() },
  TRANSLATION_MODEL: 'draft-model',
  TRANSLATION_REVIEW_MODEL: 'reviewer',
}
let checksum: string
const request = (clientChecksum?: string) => new Request('https://api.capgo.app/translation/messages', {
  method: 'POST',
  body: JSON.stringify({ targetLanguage: 'fr', checksum: clientChecksum }),
})
function message(attempts = 1) {
  return {
    attempts,
    body: { targetLanguage: 'fr', model: 'draft-model', checksum, batchIndex: 1 },
    ack: vi.fn(),
    retry: vi.fn(),
  }
}
async function consume(item: ReturnType<typeof message>) {
  await translationWorker.queue({ messages: [item] } as any, env as any, {} as any)
}
function pending() {
  return sqlite.prepare('SELECT * FROM translation_messages_cache WHERE checksum = ?').get(checksum)!
}
function rateLimit() {
  return new Error('AiError: 3021: rate limiting: inference request per min rate reached')
}

beforeAll(async () => {
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: { match: async () => null, put: async () => {} } },
  })
  checksum = await utils.currentSourceChecksum({ TRANSLATION_MODEL: env.TRANSLATION_MODEL, TRANSLATION_REVIEW_MODEL: env.TRANSLATION_REVIEW_MODEL })
  await translationWorker.fetch(request(), env as any)
})
beforeEach(() => {
  vi.resetAllMocks()
  beforeRun = undefined
  sqlite.exec('DELETE FROM translation_messages_cache; DELETE FROM translation_memory')
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'translation_queue_cooldowns'").get())
    sqlite.exec('DELETE FROM translation_queue_cooldowns')
  const messages = Object.fromEntries(Object.keys(sourceMessages)
    .filter(key => !['$schema', 'account', 'password'].includes(key))
    .map(key => [key, `fr:${key}`]))
  sqlite.prepare(`INSERT INTO translation_messages_cache
    (target_language, checksum, model, status, messages, next_batch_index, expires_at, updated_at)
    VALUES ('fr', ?, 'draft-model', 'pending', ?, 1, unixepoch() + 3600, unixepoch())`)
    .run(checksum, JSON.stringify(messages))
})
afterAll(() => sqlite.close())

describe('translation queue recovery', () => {
  it('caps retry delays and distinguishes rate limits from other failures', () => {
    expect(utils.translationRetryDelay({ status: 429 }, 2)).toBeGreaterThanOrEqual(240)
    expect(utils.translationRetryDelay({ code: 3021 }, 20)).toBe(3600)
    expect(utils.translationRetryDelay(new Error('D1 unavailable'), 5)).toBe(30)
  })

  it('defers a throttled draft after one call and keeps polling from bypassing its cooldown', async () => {
    env.AI.run.mockRejectedValue(rateLimit())
    const item = message()
    await consume(item)

    expect(env.AI.run).toHaveBeenCalledTimes(1)
    expect(item.ack).not.toHaveBeenCalled()
    expect(item.retry.mock.calls[0][0].delaySeconds).toBeGreaterThanOrEqual(120)
    expect(item.retry.mock.calls[0][0].delaySeconds).toBeLessThan(150)
    expect(pending().status).toBe('pending')
    expect(pending().next_batch_index).toBe(1)
    // Reproduce a browser poll after the old 60-second stale threshold.
    sqlite.exec('UPDATE translation_messages_cache SET updated_at = unixepoch() - 61')
    const response = await translationWorker.fetch(request(), env as any)
    expect(response.status).toBe(202)
    expect(env.TRANSLATION_MESSAGES_QUEUE.send).not.toHaveBeenCalled()

    const duplicate = message()
    await consume(duplicate)
    expect(env.AI.run).toHaveBeenCalledTimes(1)
    expect(duplicate.ack).not.toHaveBeenCalled()
    expect(duplicate.retry).toHaveBeenCalledTimes(1)
    expect(pending().expires_at as number).toBeGreaterThan(Math.floor(Date.now() / 1000) + 96 * 60 * 60)

    // Retry the same delivery after the stored cooldown, without another browser request.
    sqlite.exec('UPDATE translation_queue_cooldowns SET retry_after = unixepoch() - 1')
    env.AI.run.mockResolvedValue({ response: '{"translations":{"account":"Compte","password":"Mot de passe"}}' })
    const resumed = message(2)
    await consume(resumed)
    expect(resumed.ack).toHaveBeenCalledTimes(1)
    expect(resumed.retry).not.toHaveBeenCalled()
    expect(pending().status).toBe('ready')
    expect(JSON.parse(pending().messages as string).account).toBe('Compte')
  })

  it('checks cooldowns atomically when claiming after a racing failed delivery', async () => {
    beforeRun = (sql) => {
      if (!sql.includes('AND NOT EXISTS'))
        return
      beforeRun = undefined
      sqlite.prepare(`INSERT INTO translation_queue_cooldowns VALUES ('fr', ?, unixepoch() + 120)`).run(checksum)
    }
    const duplicate = message()
    await consume(duplicate)
    expect(env.AI.run).not.toHaveBeenCalled()
    expect(pending().next_batch_index).toBe(1)
  })

  it('does not publish an unreviewed catalog when the reviewer is rate limited', async () => {
    env.AI.run.mockResolvedValueOnce({ response: '{"translations":{"account":"Compte","password":"Mot de passe"}}' })
      .mockRejectedValue(rateLimit())
    const item = message(3)
    await consume(item)

    expect(env.AI.run).toHaveBeenCalledTimes(2)
    expect(item.ack).not.toHaveBeenCalled()
    expect(item.retry.mock.calls[0][0].delaySeconds).toBeGreaterThanOrEqual(480)
    expect(pending().status).toBe('pending')
    expect(pending().next_batch_index).toBe(1)
    expect(JSON.parse(pending().messages as string)).not.toHaveProperty('account')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM translation_memory').get()?.count).toBe(0)
  })

  it('refreshes legacy fallback catalogs while reusing their reviewed translation memory', async () => {
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const messages = Object.fromEntries(Object.entries(sourceMessages).filter(([key, value]) => key !== '$schema' && typeof value === 'string'))
    const contexts = Object.fromEntries(Object.entries(sourceContexts).filter(([key, value]) => key !== '$schema' && typeof value === 'string'))
    const pipeline = 'draft-model reviewed by reviewer'
    // Use the pre-fix checksum and memory format, as existing clients/D1 do.
    const legacyChecksum = hash([hash({ contexts, messages, pipelineVersion: 5 }), pipeline])
    expect(checksum).not.toBe(legacyChecksum)
    sqlite.prepare(`UPDATE translation_messages_cache SET checksum = ?, status = 'ready',
      messages = json_set(messages, '$.account', 'Account', '$.password', 'Mot de passe'),
      updated_at = unixepoch() - 301`).run(legacyChecksum)
    const insert = sqlite.prepare(`INSERT OR REPLACE INTO translation_memory (target_language, source_hash, translated, model)
      VALUES ('fr', ?, ?, ?)`)
    for (const [key, text] of Object.entries(messages)) {
      if (key !== 'account')
        insert.run(hash([5, text, contexts[key]?.trim() ?? '']), `fr:${key}`, pipeline)
    }

    const stale = await translationWorker.fetch(request(legacyChecksum), env as any)
    expect(stale.headers.get('x-capgo-translation-stale')).toBe('1')
    expect((await stale.json() as any).checksum).toBe(legacyChecksum)
    expect(env.TRANSLATION_MESSAGES_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ checksum, batchIndex: 0 }), { contentType: 'json' })

    env.AI.run.mockResolvedValue({ response: '{"translations":{"account":"Compte"}}' })
    const refresh = message()
    refresh.body.batchIndex = 0
    await consume(refresh)
    expect(refresh.ack).toHaveBeenCalledTimes(1)
    const input = env.AI.run.mock.calls[0][1] as { messages: { content: string }[] }
    expect(Object.keys(JSON.parse(input.messages[1].content).messages)).toEqual(['account'])
    expect(pending().status).toBe('ready')

    const fresh = await translationWorker.fetch(request(legacyChecksum), env as any)
    const payload = await fresh.json() as any
    expect(payload.checksum).toBe(checksum)
    expect(payload.messages.account).toBe('Compte')
    expect(await (await translationWorker.fetch(request(checksum), env as any)).json())
      .toEqual({ checksum, status: 'not_modified' })
  })

  it('keeps missing AI answers pending and translates only those strings on the next delivery', async () => {
    env.AI.run.mockResolvedValue({ response: '{"translations":{"password":"Mot de passe"}}' })
    const partial = message()
    await consume(partial)

    expect(partial.ack).toHaveBeenCalledTimes(1)
    expect(pending().status).toBe('pending')
    expect(JSON.parse(pending().messages as string)).not.toHaveProperty('account')
    expect(JSON.parse(pending().messages as string).password).toBe('Mot de passe')
    expect(env.TRANSLATION_MESSAGES_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ batchIndex: 2 }), { contentType: 'json' })

    env.AI.run.mockClear().mockResolvedValue({ response: '{"translations":{"account":"Compte"}}' })
    const resumed = message()
    resumed.body.batchIndex = 2
    await consume(resumed)
    const input = env.AI.run.mock.calls[0][1] as { messages: { content: string }[] }
    expect(Object.keys(JSON.parse(input.messages[1].content).messages)).toEqual(['account'])
    expect(resumed.ack).toHaveBeenCalledTimes(1)
    expect(pending().status).toBe('ready')
    expect(JSON.parse(pending().messages as string).account).toBe('Compte')
  })

  it('uses the existing retry budget when a batch makes no valid progress', async () => {
    env.AI.run.mockResolvedValue({ response: '{"translations":{"account":"","password":""}}' })
    const failed = message(5)
    await consume(failed)
    expect(failed.ack).not.toHaveBeenCalled()
    expect(failed.retry).toHaveBeenCalledTimes(1)
    expect(pending().status).toBe('pending')
    expect(pending().next_batch_index).toBe(1)
    expect(env.TRANSLATION_MESSAGES_QUEUE.send).not.toHaveBeenCalled()
    expect(JSON.parse(pending().messages as string)).not.toHaveProperty('account')
  })

  it('waits out an orphaned lease after D1 fails to release it, then resumes without polling', async () => {
    beforeRun = (sql, params) => {
      if (sql.includes('SET next_batch_index = ?') && params[0] === 1) {
        beforeRun = undefined
        throw new Error('D1 unavailable during claim release')
      }
    }
    env.AI.run.mockRejectedValue(new Error('AI temporarily unavailable'))
    const failed = message()
    await consume(failed)
    expect(failed.retry).toHaveBeenCalledTimes(1)
    expect(pending().next_batch_index).toBe(utils.translationBatchClaimMarker(1))
    const aiCalls = env.AI.run.mock.calls.length

    const earlyRetry = message(2)
    await consume(earlyRetry)
    expect(earlyRetry.ack).not.toHaveBeenCalled()
    const delaySeconds = earlyRetry.retry.mock.calls[0][0].delaySeconds
    expect(Math.floor(Date.now() / 1000) + delaySeconds).toBeGreaterThanOrEqual(Number(pending().updated_at) + 15 * 60)
    expect(delaySeconds).toBeLessThanOrEqual(15 * 60)
    expect(env.AI.run).toHaveBeenCalledTimes(aiCalls)

    sqlite.exec('UPDATE translation_messages_cache SET updated_at = unixepoch() - 901')
    env.AI.run.mockResolvedValue({ response: '{"translations":{"account":"Compte","password":"Mot de passe"}}' })
    const resumed = message(3)
    await consume(resumed)
    expect(resumed.ack).toHaveBeenCalledTimes(1)
    expect(resumed.retry).not.toHaveBeenCalled()
    expect(pending().status).toBe('ready')
    expect(env.TRANSLATION_MESSAGES_QUEUE.send).not.toHaveBeenCalled()
  })

  it('does not release a lease renewed after an expired-lease read', async () => {
    sqlite.prepare('UPDATE translation_messages_cache SET next_batch_index = ?, updated_at = unixepoch() - 901')
      .run(utils.translationBatchClaimMarker(1))
    beforeRun = (sql, params) => {
      if (sql.includes('SET next_batch_index = ?') && params[0] === 1) {
        beforeRun = undefined
        sqlite.exec('UPDATE translation_messages_cache SET updated_at = unixepoch()')
      }
    }
    await consume(message(2))
    expect(env.AI.run).not.toHaveBeenCalled()
    expect(pending().next_batch_index).toBe(utils.translationBatchClaimMarker(1))
  })

  it('recovers a continuation send failure on redelivery without repeating AI work', async () => {
    // The previous attempt saved batch 1, then failed to send batch 2.
    sqlite.exec('UPDATE translation_messages_cache SET next_batch_index = 2')
    env.TRANSLATION_MESSAGES_QUEUE.send.mockRejectedValueOnce(new Error('Queue temporarily unavailable'))
    const failed = message(2)
    await consume(failed)
    expect(failed.ack).not.toHaveBeenCalled()
    expect(failed.retry).toHaveBeenCalledTimes(1)

    const recovered = message(3)
    await consume(recovered)
    expect(recovered.ack).toHaveBeenCalledTimes(1)
    expect(env.TRANSLATION_MESSAGES_QUEUE.send).toHaveBeenLastCalledWith(expect.objectContaining({ batchIndex: 2 }), { contentType: 'json' })
    expect(env.AI.run).not.toHaveBeenCalled()
  })
})
