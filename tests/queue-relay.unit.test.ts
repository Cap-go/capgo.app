import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types'
import type { HttpDispatchRow } from '../supabase/functions/_backend/utils/http_dispatch.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGMQ_RELAY_RETRY_DELAY_SECONDS, processPgmqRelayBatch } from '../cloudflare_workers/api/pgmq_relay.ts'
import { __queueConsumerTestUtils__, getRelayedQueueConcurrency, MAX_QUEUE_READS, RELAYED_QUEUE_CONCURRENCY, relayedQueueClaimSql } from '../supabase/functions/_backend/triggers/queue_consumer.ts'
import {
  parsePgmqRelayWakeup,
  PGMQ_RELAY_BUDGET_MS,
  PGMQ_RELAY_DELIVERY_GRACE_SECONDS,
  PGMQ_RELAY_MAX_MESSAGES_PER_CLAIM,
  PGMQ_RELAY_SEND_BATCH_SIZE,
  pgmqRelayReadSql,
  pgmqRelayReleaseSql,
  relayPgmqWakeups,
} from '../supabase/functions/_backend/triggers/queue_relay.ts'

const { queryMock, closeClientMock, discordMock, getPgClientMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  closeClientMock: vi.fn(),
  discordMock: vi.fn(),
  getPgClientMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: getPgClientMock,
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

// Relays the wakeups in their claim order instead of a random one.
function inClaimOrder() {
  let next = 0
  return () => next++
}

// The read limit of each relay read, in order.
function readLimits(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls
    .filter(([sql]) => (sql as string).includes('FOR UPDATE SKIP LOCKED'))
    .map(([sql, params]) => [(sql as string).match(/pgmq\."q_(\w+)"/)?.[1], (params as number[])[1]])
}

beforeEach(() => {
  getPgClientMock.mockImplementation(async () => ({ query: queryMock }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('pgmq relay wakeups', () => {
  it.concurrent('reads what the Supabase consumers it replaces would read', () => {
    expect(parsePgmqRelayWakeup(wakeup('on_app_update', { calls: 3, body: { queue_name: 'on_app_update', batch_size: 100 } }))).toEqual({
      queueName: 'on_app_update',
      maxMessages: 300,
      visibilityTimeoutSeconds: 120 + PGMQ_RELAY_DELIVERY_GRACE_SECONDS,
      waitForCompletion: false,
    })
    expect(parsePgmqRelayWakeup(wakeup('on_manifest_create', { calls: 10 }))?.maxMessages).toBe(9500)
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
    ], Date.now, inClaimOrder())

    expect(result).toEqual({ relayed: 100, released: 150, rejected: 0, deferred: 1 })
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

    // 2 x 950 each, more than the cap allows: each queue gets an equal share.
    const cappedQuery = vi.fn(readReturning())
    const capped = await relayPgmqWakeups(context, { query: cappedQuery } as never, { sendBatch }, rows, Date.now, inClaimOrder())
    expect(capped).toEqual({ relayed: PGMQ_RELAY_MAX_MESSAGES_PER_CLAIM, released: 0, rejected: 0, deferred: 0 })
    expect(readLimits(cappedQuery)).toEqual([['q_a', 834], ['q_b', 834], ['q_c', 833], ['q_d', 833], ['q_e', 833], ['q_f', 833]])

    let clock = 0
    const slowSend = vi.fn(async () => {
      clock += PGMQ_RELAY_BUDGET_MS / 2
    })
    const query = vi.fn(readReturning([{ msg_id: 1, read_ct: 1 }]))
    const timed = await relayPgmqWakeups(context, { query } as never, { sendBatch: slowSend }, rows, () => clock, inClaimOrder())
    expect(timed).toEqual({ relayed: 2, released: 0, rejected: 0, deferred: 4 })
  })
})

describe('pgmq relay send budget', () => {
  it('gives each queue its share of the time when sending is slow, so none starves', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let clock = 0
    const query = vi.fn(readReturning())
    const sendBatch = vi.fn(async (_messages: Iterable<{ body: { queue_name: string } }>) => {
      clock += PGMQ_RELAY_BUDGET_MS * 3 / 8
    })

    // The busy queue is relayed first.
    const result = await relayPgmqWakeups(context, { query } as never, { sendBatch }, [
      wakeup('on_user_update', { id: '2', calls: 2 }),
      wakeup('on_app_update', { calls: 2, body: { queue_name: 'on_app_update', batch_size: 500 } }),
    ], () => clock, inClaimOrder())

    // It gets half the time, and the other queue gets the time left.
    expect(result).toEqual({ relayed: 300, released: 2600, rejected: 0, deferred: 0 })
    const sent = sendBatch.mock.calls.map(([messages]) => [...messages][0].body.queue_name)
    expect(sent).toEqual(['on_user_update', 'on_user_update', 'on_app_update'])
    const releases = query.mock.calls.filter(([sql]) => !(sql as string).includes('FOR UPDATE SKIP LOCKED')) as unknown as [string, [number[]]][]
    expect(releases.map(([sql, [ids]]) => [sql, ids[0], ids.length])).toEqual([
      [pgmqRelayReleaseSql('on_user_update'), 201, 1700],
      [pgmqRelayReleaseSql('on_app_update'), 101, 900],
    ])
  })

  it('keeps relaying every claim when each read is slower than a wakeup\'s share', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let clock = 0
    const read = readReturning()
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED'))
        clock += 700
      return read(sql, params)
    })
    const sendBatch = vi.fn(async () => {})
    const queues = ['q_a', 'q_b', 'q_c', 'q_d', 'q_e', 'q_f']
    const rows = queues.map((queue, index) => wakeup(queue, { id: String(index), body: { queue_name: queue, batch_size: 100 } }))

    // 700 ms is more than a sixth of the budget, but the claim still has time.
    for (let claim = 0; claim < 2; claim++) {
      clock = 0
      const result = await relayPgmqWakeups(context, { query } as never, { sendBatch }, rows, () => clock, inClaimOrder())
      // The sixth read ends past the budget, so only it is given back.
      expect(result).toEqual({ relayed: 500, released: 100, rejected: 0, deferred: 0 })
    }
  })

  it('never gives back the same queue on every claim when the budget keeps running out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let clock = 0
    const read = readReturning()
    const released = new Set<string>()
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED'))
        clock += 700
      else
        released.add(sql.match(/pgmq\."q_(\w+)"/)![1])
      return read(sql, params)
    })
    const sent = new Map<string, number>()
    const sendBatch = vi.fn(async (messages: Iterable<{ body: { queue_name: string } }>) => {
      const [first] = [...messages]
      sent.set(first.body.queue_name, (sent.get(first.body.queue_name) ?? 0) + 1)
    })
    const queues = ['q_a', 'q_b', 'q_c', 'q_d', 'q_e', 'q_f']
    const rows = queues.map((queue, index) => wakeup(queue, { id: String(index), body: { queue_name: queue, batch_size: 100 } }))
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31

    // pg_cron writes the same backlogged wakeups in the same order every tick.
    for (let claim = 0; claim < 12; claim++) {
      clock = 0
      expect(await relayPgmqWakeups(context, { query } as never, { sendBatch }, rows, () => clock, random)).toMatchObject({ relayed: 500, released: 100 })
    }
    expect([...sent.keys()].sort()).toEqual(queues)
    expect(released.size).toBeGreaterThan(1)
  })

  it('serves small requests in full and splits the rest of the cap between busy queues', async () => {
    const query = vi.fn(readReturning())
    const sendBatch = vi.fn(async () => {})

    // The quiet queue comes last, after the busy ones.
    const result = await relayPgmqWakeups(context, { query } as never, { sendBatch }, [
      wakeup('on_manifest_create', { calls: 10 }),
      wakeup('on_app_update', { id: '2', calls: 10 }),
      wakeup('on_user_update', { id: '3', body: { queue_name: 'on_user_update', batch_size: 100 } }),
    ], Date.now, inClaimOrder())

    expect(result).toEqual({ relayed: PGMQ_RELAY_MAX_MESSAGES_PER_CLAIM, released: 0, rejected: 0, deferred: 0 })
    expect(readLimits(query)).toEqual([['on_manifest_create', 2450], ['on_app_update', 2450], ['on_user_update', 100]])
  })

  it('gives a share a queue does not use to the next one', async () => {
    const read = readReturning()
    // The first queue has only 10 readable messages left.
    const query = vi.fn(async (sql: string, params: unknown[]) => sql.includes('q_on_manifest_create')
      ? { rows: Array.from({ length: 10 }, (_, index) => ({ msg_id: index + 1, read_ct: 0 })) }
      : read(sql, params))
    const sendBatch = vi.fn(async () => {})

    const result = await relayPgmqWakeups(context, { query } as never, { sendBatch }, [
      wakeup('on_manifest_create', { calls: 10 }),
      wakeup('on_app_update', { id: '2', calls: 10 }),
    ], Date.now, inClaimOrder())

    expect(result).toEqual({ relayed: 10 + 4990, released: 0, rejected: 0, deferred: 0 })
    expect(readLimits(query)).toEqual([['on_manifest_create', 2500], ['on_app_update', 4990]])
  })

  it('sends nothing when the read itself used up the budget', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let clock = 0
    const read = readReturning([{ msg_id: 1, read_ct: 0 }, { msg_id: 2, read_ct: 0 }])
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      clock += PGMQ_RELAY_BUDGET_MS
      return read(sql, params)
    })
    const sendBatch = vi.fn(async () => {})

    const result = await relayPgmqWakeups(context, { query } as never, { sendBatch }, [wakeup('on_app_update')], () => clock)

    expect(result).toEqual({ relayed: 0, released: 2, rejected: 0, deferred: 0 })
    expect(sendBatch).not.toHaveBeenCalled()
    expect(query.mock.calls[1]).toEqual([pgmqRelayReleaseSql('on_app_update'), [[1, 2], [0, 0]]])
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

  it('retries only the queue whose claim failed, after the other queue finished', async () => {
    stubRuntime()
    queryMock.mockImplementation(async (sql: string) => {
      if (sql === relayedQueueClaimSql('on_user_update'))
        throw new Error('statement timeout')
      if (sql === relayedQueueClaimSql('on_app_update'))
        return { rows: [pgmqRow(1)] }
      return { rows: [] }
    })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok' })))
    const failing = queueMessage({ queue_name: 'on_user_update', msg_id: 4, read_ct: 0 }, 'a')
    const healthy = queueMessage({ queue_name: 'on_app_update', msg_id: 1, read_ct: 0 }, 'b')

    await processPgmqRelayBatch(batch([failing, healthy]), {} as never, ctx)

    // The healthy queue still ran to its delete before the invocation ended.
    expect(queryMock.mock.calls.map(([sql]) => sql)).toEqual([
      relayedQueueClaimSql('on_user_update'),
      relayedQueueClaimSql('on_app_update'),
      'WITH capgo_pgmq_uncached AS (SELECT now()) SELECT pgmq.delete($1, $2::bigint[])',
    ])
    expect(failing.retry).toHaveBeenCalledWith({ delaySeconds: PGMQ_RELAY_RETRY_DELAY_SECONDS })
    expect(failing.ack).not.toHaveBeenCalled()
    expect(healthy.ack).toHaveBeenCalledTimes(1)
    expect(healthy.retry).not.toHaveBeenCalled()
  })

  it('archives a malformed claimed message and still runs the others', async () => {
    stubRuntime()
    queryMock.mockImplementation(async (sql: string) => {
      if (sql === relayedQueueClaimSql('on_app_update'))
        return { rows: [pgmqRow(1, MAX_QUEUE_READS), { msg_id: '2', read_ct: 1, message: { payload: {} } }] }
      return { rows: [] }
    })
    const fetchMock = vi.fn(async () => Response.json({ status: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)
    const valid = queueMessage({ queue_name: 'on_app_update', msg_id: 1, read_ct: MAX_QUEUE_READS - 1 }, 'a')
    const malformed = queueMessage({ queue_name: 'on_app_update', msg_id: 2, read_ct: 0 }, 'b')

    await processPgmqRelayBatch(batch([valid, malformed]), {} as never, ctx)

    expect(queryMock).toHaveBeenCalledWith('WITH capgo_pgmq_uncached AS (SELECT now()) SELECT pgmq.archive($1, $2::bigint[])', ['on_app_update', [2]])
    // The valid message ran on its last read instead of failing with its batch.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledWith('WITH capgo_pgmq_uncached AS (SELECT now()) SELECT pgmq.delete($1, $2::bigint[])', ['on_app_update', [1]])
    expect(valid.ack).toHaveBeenCalledTimes(1)
    expect(malformed.ack).toHaveBeenCalledTimes(1)
  })

  it('runs no more messages of a queue at once than the connections left allow', async () => {
    stubRuntime()
    const ids = [1, 2, 3, 4, 5]
    queryMock.mockImplementation(async (sql: string) => {
      if (sql === relayedQueueClaimSql('on_app_update'))
        return { rows: ids.map(id => pgmqRow(id)) }
      return { rows: [] }
    })
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      peak = Math.max(peak, ++inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return Response.json({ status: 'ok' })
    }))

    await processPgmqRelayBatch(batch(ids.map(id => queueMessage({ queue_name: 'on_app_update', msg_id: id, read_ct: 0 }, String(id)))), {} as never, ctx)

    // One connection is the database client, the rest are the trigger calls.
    expect(peak).toBe(getRelayedQueueConcurrency('on_app_update'))
    expect(1 + getRelayedQueueConcurrency('on_app_update')).toBeLessThanOrEqual(6)
    // A manifest message opens its own database client next to its storage read.
    expect(1 + 2 * getRelayedQueueConcurrency('on_manifest_create')).toBeLessThanOrEqual(6)
    expect(getRelayedQueueConcurrency('cron_onboarding_refresh_apps')).toBeLessThanOrEqual(4)
  })

  it('retries the whole batch when no database client can be opened', async () => {
    stubRuntime()
    getPgClientMock.mockRejectedValueOnce(new Error('too many connections'))
    const message = queueMessage({ queue_name: 'on_app_update', msg_id: 1, read_ct: 0 })

    await processPgmqRelayBatch(batch([message]), {} as never, ctx)

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: PGMQ_RELAY_RETRY_DELAY_SECONDS })
    expect(message.ack).not.toHaveBeenCalled()
  })

  it('never takes more messages per batch than it can send at once', async () => {
    const { readFileSync } = await import('node:fs')
    const config = JSON.parse(readFileSync(new URL('../cloudflare_workers/api/wrangler.jsonc', import.meta.url), 'utf8'))
    const consumers = config.env.prod.queues.consumers.filter((consumer: { queue: string }) => consumer.queue === 'capgo-pgmq-prod')
    expect(consumers).toHaveLength(1)
    expect(consumers[0].max_batch_size).toBeLessThanOrEqual(RELAYED_QUEUE_CONCURRENCY)
  })
})

describe('queue message validation', () => {
  const { takeValidQueueMessages } = __queueConsumerTestUtils__

  it('archives only the rows that can never be processed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const query = vi.fn(async () => ({ rows: [] }))
    const valid = { msg_id: '1', read_ct: 1, message: { function_name: 'on_app_update', payload: {} } }

    const messages = await takeValidQueueMessages(context, { query } as never, 'on_app_update', [
      valid,
      { msg_id: '2', read_ct: 1, message: { payload: {} } },
      { msg_id: 'x', read_ct: 1, message: {} },
    ])

    expect(messages).toEqual([{ ...valid, msg_id: 1 }])
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith('WITH capgo_pgmq_uncached AS (SELECT now()) SELECT pgmq.archive($1, $2::bigint[])', ['on_app_update', [2]])
  })

  it('still returns the valid rows when the archive fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const query = vi.fn(async () => {
      throw new Error('archive failed')
    })
    const valid = { msg_id: 3, read_ct: 2, message: { function_name: 'on_app_update' } }

    const messages = await takeValidQueueMessages(context, { query } as never, 'on_app_update', [valid, { msg_id: 4, read_ct: 1, message: null }])

    expect(messages).toEqual([valid])
  })
})

describe('queue message workers', () => {
  it('lets every worker finish before reporting a failure', async () => {
    const finished: number[] = []
    const run = __queueConsumerTestUtils__.mapWithConcurrency([0, 1, 2], 2, async (item) => {
      if (item === 0)
        throw new Error('boom')
      await new Promise(resolve => setTimeout(resolve, 5))
      finished.push(item)
      return item
    })

    await expect(run).rejects.toThrow('boom')
    // The sibling worker went on with the rest before the call failed.
    expect(finished).toEqual([1, 2])
  })
})
