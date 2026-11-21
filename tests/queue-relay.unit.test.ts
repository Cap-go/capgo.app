import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types'
import type { HttpDispatchRow } from '../supabase/functions/_backend/utils/http_dispatch.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PGMQ_RELAY_RETRY_DELAY_SECONDS, processPgmqRelayBatch } from '../cloudflare_workers/api/pgmq_relay.ts'
import { MAX_QUEUE_READS, RELAYED_QUEUE_CONCURRENCY, relayedQueueClaimSql } from '../supabase/functions/_backend/triggers/queue_consumer.ts'
import {
  parsePgmqRelayWakeup,
  PGMQ_RELAY_BUDGET_MS,
  PGMQ_RELAY_DELIVERY_GRACE_SECONDS,
  PGMQ_RELAY_MAX_MESSAGES_PER_CLAIM,
  PGMQ_RELAY_MAX_MESSAGES_PER_WAKEUP,
  PGMQ_RELAY_SEND_BATCH_SIZE,
  pgmqRelayReadSql,
  pgmqRelayReleaseSql,
  relayPgmqWakeups,
} from '../supabase/functions/_backend/triggers/queue_relay.ts'

const { queryMock, closeClientMock, discordMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  closeClientMock: vi.fn(),
  discordMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({ query: queryMock })),
  closeClient: closeClientMock,
}))
vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({ sendDiscordAlert: discordMock }))

const ORIGIN = 'https://project.supabase.co'
const CONSUMER_URL = `${ORIGIN}/functions/v1/triggers/queue_consumer/sync`
const CF_URL = 'https://api.capgo.test'

function wakeup(queueName: string, overrides: Partial<HttpDispatchRow> = {}): HttpDispatchRow {
  return {
    id: '1',
    target: queueName,
    url: CONSUMER_URL,
    body: { queue_name: queueName, batch_size: 950, wait_for_completion: false },
    timeout_ms: 8000,
    calls: 1,
    runtime: 'cloudflare',
    ...overrides,
  }
}

// Answers the relay read with `limit` messages (msg_id from 1), or the rows given.
function readReturning(rows?: { msg_id: number, read_ct: number }[]) {
  return async (sql: string, params: unknown[]) => {
    if (!sql.includes('FOR UPDATE SKIP LOCKED') || sql.includes('http_dispatch_outbox'))
      return { rows: [] }
    const limit = params[1] as number
    return { rows: rows ?? Array.from({ length: limit }, (_, index) => ({ msg_id: String(index + 1), read_ct: 1 })) }
  }
}

const context = { get: () => 'request-id' } as never

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('pgmq relay wakeups', () => {
  it.concurrent('reads what the wakeup asks for, within the per-wakeup cap', () => {
    expect(parsePgmqRelayWakeup(wakeup('on_app_update', { calls: 3, body: { queue_name: 'on_app_update', batch_size: 100 } }))).toEqual({
      queueName: 'on_app_update',
      maxMessages: 300,
      visibilityTimeoutSeconds: 120 + PGMQ_RELAY_DELIVERY_GRACE_SECONDS,
      waitForCompletion: false,
    })
    expect(parsePgmqRelayWakeup(wakeup('on_app_update', { calls: 10 }))?.maxMessages).toBe(PGMQ_RELAY_MAX_MESSAGES_PER_WAKEUP)
    expect(parsePgmqRelayWakeup(wakeup('on_app_update', { calls: 50, body: { queue_name: 'on_app_update', batch_size: 50 } }))?.maxMessages).toBe(500)
    expect(parsePgmqRelayWakeup(wakeup('on_app_update', { body: { queue_name: 'on_app_update', wait_for_completion: true } }))).toMatchObject({ maxMessages: 950, waitForCompletion: true })
  })

  it.concurrent('keeps the per-queue batch limits of the HTTP consumer', () => {
    expect(parsePgmqRelayWakeup(wakeup('on_version_update', { calls: 10 }))).toMatchObject({ maxMessages: 400, visibilityTimeoutSeconds: 900 + PGMQ_RELAY_DELIVERY_GRACE_SECONDS })
    expect(parsePgmqRelayWakeup(wakeup('cron_onboarding_refresh_apps'))?.maxMessages).toBe(4)
    expect(parsePgmqRelayWakeup(wakeup('on_manifest_create'))?.visibilityTimeoutSeconds).toBe(900 + PGMQ_RELAY_DELIVERY_GRACE_SECONDS)
  })

  it.concurrent('rejects a wakeup whose queue is not its target or not a pgmq name', () => {
    expect(parsePgmqRelayWakeup(wakeup('on_app_update', { body: { queue_name: 'on_user_update' } }))).toBeNull()
    expect(parsePgmqRelayWakeup(wakeup('Bad"Name', { body: { queue_name: 'Bad"Name' } }))).toBeNull()
    expect(parsePgmqRelayWakeup(wakeup('on_app_update', { body: null }))).toBeNull()
  })

  it.concurrent('only builds queue SQL for pgmq queue names', () => {
    for (const sql of [pgmqRelayReadSql('on_app_update'), pgmqRelayReleaseSql('on_app_update'), relayedQueueClaimSql('on_app_update')])
      expect(sql).toMatch(/^UPDATE pgmq\."q_on_app_update" AS m/)
    for (const name of ['on_app_update"; DROP TABLE x; --', 'On_app', '', 'a'.repeat(48)]) {
      expect(() => pgmqRelayReadSql(name)).toThrow()
      expect(() => pgmqRelayReleaseSql(name)).toThrow()
      expect(() => relayedQueueClaimSql(name)).toThrow()
    }
  })

  it.concurrent('bounds the relay read by an indexable cutoff in vt order', () => {
    const sql = pgmqRelayReadSql('on_app_update')
    expect(sql).toContain('readable.vt <= pg_catalog.now()')
    expect(sql).not.toMatch(/vt <= pg_catalog\.clock_timestamp/)
    expect(sql).toContain('ORDER BY readable.vt')
    expect(sql).toContain('m.msg_id = ANY (ARRAY(')
  })

  it.concurrent('counts a read when the consumer claims a message, never when relaying it', () => {
    expect(pgmqRelayReadSql('on_app_update')).not.toContain('read_ct =')
    expect(pgmqRelayReleaseSql('on_app_update')).not.toMatch(/SET[^]*read_ct[^]*FROM/)
    expect(relayedQueueClaimSql('on_app_update')).toContain('read_ct = m.read_ct + 1')
    expect(relayedQueueClaimSql('on_app_update')).toContain('m.read_ct = relayed.read_ct')
  })

  it('sends the read message ids to Cloudflare Queues in batches of 100', async () => {
    const query = vi.fn(readReturning())
    const sendBatch = vi.fn(async (_messages: Iterable<unknown>) => {})

    const result = await relayPgmqWakeups(context, { query } as never, { sendBatch }, [
      wakeup('on_app_update', { body: { queue_name: 'on_app_update', batch_size: 125, wait_for_completion: true } }),
      wakeup('on_app_update', { id: '2', calls: 2, body: { queue_name: 'on_app_update', batch_size: 125, wait_for_completion: true } }),
    ])

    expect(result).toEqual({ relayed: 250, released: 0, rejected: 0, deferred: 0 })
    // The two identical wakeups are coalesced into one read of 2 x 125.
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(pgmqRelayReadSql('on_app_update'), [120 + PGMQ_RELAY_DELIVERY_GRACE_SECONDS, 250])
    const sent = sendBatch.mock.calls.map(([messages]) => [...messages])
    expect(sent.map(messages => messages.length)).toEqual([PGMQ_RELAY_SEND_BATCH_SIZE, PGMQ_RELAY_SEND_BATCH_SIZE, 50])
    expect(sent[0][0]).toEqual({ body: { queue_name: 'on_app_update', msg_id: 1, read_ct: 1, wait_for_completion: true }, contentType: 'json' })
  })

  it('releases the unsent messages and stops when Cloudflare Queues fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const query = vi.fn(readReturning())
    const sendBatch = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('queue unavailable'))

    const result = await relayPgmqWakeups(context, { query } as never, { sendBatch }, [
      wakeup('on_app_update', { body: { queue_name: 'on_app_update', batch_size: 250 } }),
      wakeup('on_user_update', { id: '2', body: { queue_name: 'on_user_update', batch_size: 250 } }),
    ])

    expect(result).toEqual({ relayed: 100, released: 150, rejected: 0, deferred: 0 })
    expect(query).toHaveBeenCalledTimes(2)
    const [releaseSql, releaseParams] = query.mock.calls[1] as unknown as [string, [number[], number[]]]
    expect(releaseSql).toBe(pgmqRelayReleaseSql('on_app_update'))
    expect(releaseParams[0]).toEqual(Array.from({ length: 150 }, (_, index) => index + 101))
    expect(releaseParams[1]).toEqual(Array.from({ length: 150 }, () => 1))
  })

  it('moves on to the next queue when a read fails and reports invalid wakeups', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const read = readReturning([{ msg_id: 7, read_ct: 2 }])
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('q_on_app_update'))
        throw new Error('read failed')
      return read(sql, params)
    })
    const sendBatch = vi.fn(async () => {})

    const result = await relayPgmqWakeups(context, { query } as never, { sendBatch }, [
      wakeup('on_app_update'),
      wakeup('on_user_update', { id: '2' }),
      wakeup('on_user_update', { id: '3', body: { queue_name: 'on_app_update' } }),
    ])

    expect(result).toEqual({ relayed: 1, released: 0, rejected: 1, deferred: 0 })
    expect(sendBatch).toHaveBeenCalledWith([{ body: { queue_name: 'on_user_update', msg_id: 7, read_ct: 2 }, contentType: 'json' }])
  })

  it('leaves the rest in pgmq once the claim budget or the message cap is reached', async () => {
    const sendBatch = vi.fn(async () => {})
    const queues = ['q_a', 'q_b', 'q_c', 'q_d', 'q_e', 'q_f']
    const rows = queues.map((queue, index) => wakeup(queue, { id: String(index), calls: 2, body: { queue_name: queue } }))

    const capped = await relayPgmqWakeups(context, { query: vi.fn(readReturning()) } as never, { sendBatch }, rows)
    expect(capped).toEqual({ relayed: PGMQ_RELAY_MAX_MESSAGES_PER_CLAIM, released: 0, rejected: 0, deferred: 1 })

    let clock = 0
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      clock += PGMQ_RELAY_BUDGET_MS / 2
      return readReturning([{ msg_id: 1, read_ct: 1 }])(sql, params)
    })
    const timed = await relayPgmqWakeups(context, { query } as never, { sendBatch }, rows, () => clock)
    expect(timed).toEqual({ relayed: 2, released: 0, rejected: 0, deferred: 4 })
  })
})

describe('pgmq relay send budget', () => {
  it('gives the unsent rest back when sending outlasts the budget', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let clock = 0
    const query = vi.fn(readReturning())
    const sendBatch = vi.fn(async () => {
      clock += PGMQ_RELAY_BUDGET_MS * 3 / 8
    })

    const result = await relayPgmqWakeups(context, { query } as never, { sendBatch }, [
      wakeup('on_app_update', { calls: 2, body: { queue_name: 'on_app_update', batch_size: 500 } }),
      wakeup('on_user_update', { id: '2' }),
    ], () => clock)

    expect(result).toEqual({ relayed: 300, released: 700, rejected: 0, deferred: 0 })
    expect(sendBatch).toHaveBeenCalledTimes(3)
    // The release, and no read of the second queue.
    expect(query).toHaveBeenCalledTimes(2)
    const [releaseSql, [releasedIds]] = query.mock.calls[1] as unknown as [string, [number[]]]
    expect(releaseSql).toBe(pgmqRelayReleaseSql('on_app_update'))
    expect(releasedIds).toEqual(Array.from({ length: 700 }, (_, index) => index + 301))
  })
})

describe('http_dispatch claim relays Cloudflare queue wakeups', () => {
  async function claim(rows: HttpDispatchRow[], env: Record<string, unknown>) {
    const { app } = await import('../supabase/functions/_backend/triggers/http_dispatch.ts')
    vi.stubEnv('API_SECRET', 'secret')
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('DELETE FROM public.http_dispatch_outbox'))
        return { rows }
      return readReturning([{ msg_id: 3, read_ct: 1 }])(sql, params)
    })
    const response = await app.request('/claim', { method: 'POST', headers: { apisecret: 'secret' } }, { API_SECRET: 'secret', ...env })
    expect(response.status).toBe(200)
    return (await response.json() as { rows: HttpDispatchRow[] }).rows
  }

  const cachePurge = wakeup('updates_cache_purge', { id: '9', url: `${ORIGIN}/functions/v1/triggers/updates_cache_purge`, body: { wake: true } })
  const supabaseQueue = wakeup('on_user_update', { id: '8', runtime: 'supabase' })

  it('relays them instead of returning them', async () => {
    const sendBatch = vi.fn(async () => {})
    const rows = await claim([wakeup('on_app_update'), cachePurge, supabaseQueue], { PGMQ_RELAY_QUEUE: { sendBatch } })

    expect(rows).toEqual([cachePurge, supabaseQueue])
    expect(sendBatch).toHaveBeenCalledWith([{ body: { queue_name: 'on_app_update', msg_id: 3, read_ct: 1 }, contentType: 'json' }])
    expect(closeClientMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the Supabase consumer when the relay queue is not bound', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const rows = await claim([wakeup('on_app_update'), cachePurge], {})

    expect(rows).toEqual([cachePurge, { ...wakeup('on_app_update'), runtime: 'supabase' }])
    expect(queryMock).toHaveBeenCalledTimes(1)
  })
})

describe('pgmq relay consumer', () => {
  function queueMessage(body: unknown, id = 'cf-message') {
    return { id, body, ack: vi.fn(), retry: vi.fn() }
  }

  function batch(messages: ReturnType<typeof queueMessage>[]) {
    return { queue: 'capgo-pgmq-prod', messages } as unknown as MessageBatch<unknown>
  }

  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext

  function pgmqRow(msgId: number, readCount = 1) {
    return {
      msg_id: String(msgId),
      read_ct: readCount,
      message: { function_name: 'on_app_update', function_type: 'cloudflare', payload: { record: { id: msgId } } },
    }
  }

  function stubRuntime() {
    vi.stubEnv('API_SECRET', 'secret')
    vi.stubEnv('CLOUDFLARE_FUNCTION_URL', CF_URL)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  it('claims the current copies, runs their triggers on Cloudflare and acks the batch', async () => {
    stubRuntime()
    queryMock.mockImplementation(async (sql: string) => {
      // Another copy of message 2 was claimed first, so this claim matches no row.
      if (sql === relayedQueueClaimSql('on_app_update'))
        return { rows: [pgmqRow(1)] }
      return { rows: [] }
    })
    const fetchMock = vi.fn(async () => Response.json({ status: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)
    // Relayed with the read count before the claim; the claim returns it counted.
    const first = queueMessage({ queue_name: 'on_app_update', msg_id: 1, read_ct: 0 }, 'a')
    const relayedAgain = queueMessage({ queue_name: 'on_app_update', msg_id: 2, read_ct: 0 }, 'b')
    const invalid = queueMessage({ queue_name: 'on_app_update', msg_id: 'x' }, 'c')

    await processPgmqRelayBatch(batch([first, relayedAgain, invalid]), {} as never, ctx)

    expect(queryMock.mock.calls[0]).toEqual([relayedQueueClaimSql('on_app_update'), [[1, 2], [0, 0], 120]])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${CF_URL}/triggers/on_app_update`)
    expect(init.headers).toMatchObject({ 'apisecret': 'secret', 'x-capgo-queue-name': 'on_app_update', 'x-capgo-queue-msg-id': '1', 'x-capgo-queue-read-count': '1' })
    expect(queryMock).toHaveBeenCalledWith('WITH capgo_pgmq_uncached AS (SELECT now()) SELECT pgmq.delete($1, $2::bigint[])', ['on_app_update', [1]])
    for (const message of [first, relayedAgain, invalid]) {
      expect(message.ack).toHaveBeenCalledTimes(1)
      expect(message.retry).not.toHaveBeenCalled()
    }
    expect(closeClientMock).toHaveBeenCalledTimes(1)
  })

  it('leaves failed work and exhausted retries to pgmq', async () => {
    stubRuntime()
    queryMock.mockImplementation(async (sql: string) => {
      if (sql === relayedQueueClaimSql('on_app_update'))
        return { rows: [pgmqRow(1), pgmqRow(2, MAX_QUEUE_READS + 1)] }
      return { rows: [] }
    })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'boom' }, { status: 500 })))
    const failing = queueMessage({ queue_name: 'on_app_update', msg_id: 1, read_ct: 0 })
    const exhausted = queueMessage({ queue_name: 'on_app_update', msg_id: 2, read_ct: MAX_QUEUE_READS })

    await processPgmqRelayBatch(batch([failing, exhausted]), {} as never, ctx)

    const statements = queryMock.mock.calls.map(([sql]) => sql as string)
    expect(statements.some(sql => sql.includes('pgmq.archive'))).toBe(true)
    expect(statements.some(sql => sql.includes('pgmq.delete'))).toBe(false)
    expect(failing.ack).toHaveBeenCalledTimes(1)
    expect(exhausted.ack).toHaveBeenCalledTimes(1)
    expect(failing.retry).not.toHaveBeenCalled()
  })

  it('retries the batch later when the database cannot be reached', async () => {
    stubRuntime()
    queryMock.mockRejectedValue(new Error('connection refused'))
    const first = queueMessage({ queue_name: 'on_app_update', msg_id: 1, read_ct: 1 })
    const second = queueMessage({ queue_name: 'on_user_update', msg_id: 4, read_ct: 3 })

    await processPgmqRelayBatch(batch([first, second]), {} as never, ctx)

    for (const message of [first, second]) {
      expect(message.ack).not.toHaveBeenCalled()
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: PGMQ_RELAY_RETRY_DELAY_SECONDS })
    }
  })

  it('never takes more messages per batch than it can send at once', async () => {
    const { readFileSync } = await import('node:fs')
    const config = JSON.parse(readFileSync(new URL('../cloudflare_workers/api/wrangler.jsonc', import.meta.url), 'utf8'))
    const consumers = config.env.prod.queues.consumers.filter((consumer: { queue: string }) => consumer.queue === 'capgo-pgmq-prod')
    expect(consumers).toHaveLength(1)
    expect(consumers[0].max_batch_size).toBeLessThanOrEqual(RELAYED_QUEUE_CONCURRENCY)
  })
})
