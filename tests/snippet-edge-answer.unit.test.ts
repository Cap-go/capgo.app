import { Buffer } from 'node:buffer'
import { gzipSync } from 'node:zlib'
import { Hono } from 'hono/tiny'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SNIPPET_EDGE_ANSWERS_TAG as SETTER_PURGE_TAG } from '../scripts/set-updates-edge-cache.ts'

import { isStaleSnippetEdgeReplay, markSnippetEdgeReplay, setSnippetIpLimitHeader, setSnippetStatsFill, setSnippetUpdatesFill, SNIPPET_EDGE_ANSWERS_TAG, SNIPPET_EDGE_FILL_HEADER, SNIPPET_EDGE_IP_LIMIT_HEADER, SNIPPET_EDGE_STATS_ACTIONS } from '../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeAnswer.ts'
import { buildReplayRequest, chunkSnippetEdgeRecords, decodeSnippetEdgeStat, getR2NotificationObjectKey, groupForSendBatch, handleSnippetEdgeStatsMessage, isSnippetEdgeFileResumeMessage, isSnippetEdgeReplayMessage, parseLogpushLine, readLogpushRecords, recordSize, replaySnippetEdgeRecords } from '../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'

(globalThis as any).EdgeRuntime = undefined

const createStatsMau = vi.fn(() => Promise.resolve())
const sendStatsAndDevice = vi.fn(() => Promise.resolve())

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts', () => ({
  createStatsBandwidth: vi.fn(() => Promise.resolve()),
  createStatsMau,
  createStatsVersion: vi.fn(() => Promise.resolve()),
  onPremStats: vi.fn(),
  sendStatsAndDevice,
}))

const getAppOwnerWithEdgeCache = vi.fn(async () => ({ value: { owner_org: 'org-1', allow_device_custom_id: false } as any, hit: true }))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pluginEdgeCacheReads.ts', () => ({
  getAppOwnerWithEdgeCache,
  getAppVersionWithEdgeCache: vi.fn(),
  getChannelByNameWithEdgeCache: vi.fn(),
  getCompatibleChannelsWithEdgeCache: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: vi.fn((error: unknown) => error),
}))

const ANSWER = { versionName: '1.2.3', keyId: null, planValidUntil: null }
const STATS_FILL = { blockProviderInfraRequests: false, planValidUntil: null }
const ENABLED_ENV = { SNIPPET_EDGE_ANSWER: 'on', CF_CACHE_PURGE_TOKEN: 'token' }

function encodeStat(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

const ENV_KEYS = ['SNIPPET_EDGE_ANSWER', 'SNIPPET_EDGE_ANSWER_TTL_SECONDS', 'CF_CACHE_PURGE_TOKEN', 'CF_ANALYTICS_TOKEN', 'UPDATES_CACHE_LOCAL_PURGE_URL', 'LIMITED_APPS']

// Outside workerd, getEnv reads process.env.
async function fillFrom(env: Record<string, string>, handler: (c: any) => void) {
  for (const key of ENV_KEYS)
    vi.stubEnv(key, env[key] ?? '')
  try {
    const app = new Hono()
    app.get('/', (c) => {
      handler(c)
      return c.json({ ok: true })
    })
    const response = await app.request('/')
    return response.headers
  }
  finally {
    vi.unstubAllEnvs()
  }
}

function readFill(headers: Headers) {
  const value = headers.get(SNIPPET_EDGE_FILL_HEADER)
  return value ? JSON.parse(decodeURIComponent(value)) : null
}

describe('snippet edge answer fills', () => {
  it('describe the up-to-date answer with both purge tags and the global one', async () => {
    const headers = await fillFrom(ENABLED_ENV, c => setSnippetUpdatesFill(c, 'com.edge.app', { ...ANSWER, versionName: 'v1 é' }, { blockProviderInfraRequests: false, legacyChannelSelfStore: true }))
    // No owner org: the device can read the stat header the snippet builds from the fill.
    expect(readFill(headers)).toEqual({
      v: 2,
      bps: 10000,
      ttl: 900,
      tags: 'capgo-updates-com.edge.app,capgo-updates-com.edge.app:versions,capgo-snippet-edge-answers',
      e: 'updates',
      n: 'v1 é',
      k: null,
      cs: true,
    })
    expect(SETTER_PURGE_TAG).toBe(SNIPPET_EDGE_ANSWERS_TAG)
  })

  it('never outlive the trial behind a valid plan', async () => {
    const soon = { ...ANSWER, planValidUntil: Date.now() + 120_000 }
    const ttl = readFill(await fillFrom(ENABLED_ENV, c => setSnippetUpdatesFill(c, 'com.edge.app', soon, { blockProviderInfraRequests: false, legacyChannelSelfStore: false }))).ttl
    expect(ttl).toBeGreaterThan(110)
    expect(ttl).toBeLessThanOrEqual(120)
    expect(readFill(await fillFrom(ENABLED_ENV, c => setSnippetStatsFill(c, 'com.edge.app', { ...STATS_FILL, planValidUntil: Date.now() + 500 })))).toBeNull()
  })

  it('list the stats actions the snippet may answer, never installs or failures', async () => {
    const fill = readFill(await fillFrom(ENABLED_ENV, c => setSnippetStatsFill(c, 'com.edge.app', STATS_FILL)))
    expect(fill.actions).toEqual(SNIPPET_EDGE_STATS_ACTIONS)
    expect(fill.actions).toContain('ping')
    expect(fill.actions).not.toContain('set')
    expect(fill.actions.some((action: string) => action.endsWith('_fail'))).toBe(false)
  })

  it('stay off without the switch, a purge target, or for apps the snippet cannot check', async () => {
    const write = (c: any) => setSnippetUpdatesFill(c, 'com.edge.app', ANSWER, { blockProviderInfraRequests: false, legacyChannelSelfStore: false })
    expect(readFill(await fillFrom({ CF_CACHE_PURGE_TOKEN: 'token' }, write))).toBeNull()
    expect(readFill(await fillFrom({ SNIPPET_EDGE_ANSWER: 'on' }, write))).toBeNull()
    expect(readFill(await fillFrom({ ...ENABLED_ENV, LIMITED_APPS: JSON.stringify([{ id: 'com.edge.app', ignore: 0.5 }]) }, write))).toBeNull()
    expect(readFill(await fillFrom(ENABLED_ENV, c => setSnippetUpdatesFill(c, 'com.edge.app', ANSWER, { blockProviderInfraRequests: true, legacyChannelSelfStore: false })))).toBeNull()
    expect(readFill(await fillFrom(ENABLED_ENV, c => setSnippetStatsFill(c, 'com.edge.app', { ...STATS_FILL, blockProviderInfraRequests: true })))).toBeNull()
  })

  it('carry the share and TTL settings', async () => {
    const headers = await fillFrom({ ...ENABLED_ENV, SNIPPET_EDGE_ANSWER: '2.5%', SNIPPET_EDGE_ANSWER_TTL_SECONDS: '99999' }, c => setSnippetStatsFill(c, 'com.edge.app', STATS_FILL))
    expect(readFill(headers)).toMatchObject({ e: 'stats', bps: 250, ttl: 3600 })
  })

  it('tell the snippet about limited IPs only while answers are on', async () => {
    const resetAt = Date.UTC(2026, 9, 6, 12, 0, 0)
    expect((await fillFrom(ENABLED_ENV, c => setSnippetIpLimitHeader(c, resetAt))).get(SNIPPET_EDGE_IP_LIMIT_HEADER)).toBe(String(resetAt / 1000))
    expect((await fillFrom({}, c => setSnippetIpLimitHeader(c, resetAt))).get(SNIPPET_EDGE_IP_LIMIT_HEADER)).toBeNull()
  })
})

describe('snippet edge stats replay', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  const updatesStat = { e: 'updates', b: '{"app_id":"com.edge.app"}', n: '1.2.3' }

  function logLine(stat: unknown, extra: Record<string, unknown> = {}) {
    return JSON.stringify({ ClientIP: '203.0.113.7', ClientCountry: 'fr', ResponseHeaders: { 'x-capgo-edge-stat': encodeStat(stat) }, ...extra })
  }

  it('decodes the snippet stat header and Logpush lines', () => {
    expect(decodeSnippetEdgeStat(encodeStat(updatesStat))).toEqual(updatesStat)
    expect(decodeSnippetEdgeStat(encodeStat({ e: 'updates', b: '{}' }))).toBeNull()
    expect(decodeSnippetEdgeStat('%%%')).toBeNull()
    expect(parseLogpushLine(logLine(updatesStat))).toEqual({ ...updatesStat, ip: '203.0.113.7', country: 'FR' })
    expect(parseLogpushLine(logLine(updatesStat, { EdgeStartTimestamp: 1791892800123456789 }))?.t).toBe(1791892800123)
    expect(parseLogpushLine(JSON.stringify({ ClientIP: '203.0.113.7', ResponseHeaders: {} }))).toBeNull()
    const stats = { invalid: 0 }
    expect(parseLogpushLine('not json x-capgo-edge-stat', stats)).toBeNull()
    expect(parseLogpushLine(JSON.stringify({ ResponseHeaders: { 'x-capgo-edge-stat': encodeStat(updatesStat).slice(0, 20) } }), stats)).toBeNull()
    expect(stats.invalid).toBe(2)
  })

  it('streams gzip Logpush files line by line', async () => {
    const file = gzipSync([logLine(updatesStat), JSON.stringify({ ClientIP: '1.1.1.1' }), logLine({ e: 'stats', b: '[]' })].join('\n'))
    const records = []
    for await (const record of readLogpushRecords(new Response(file).body!, true))
      records.push(record)
    expect(records.map(record => record.e)).toEqual(['updates', 'stats'])
  })

  it('chunks records under the Analytics Engine and queue limits', () => {
    const many = Array.from({ length: 120 }, () => ({ e: 'updates' as const, b: '{}', n: '1' }))
    const chunks = chunkSnippetEdgeRecords(many)
    expect(chunks.map(chunk => chunk.length)).toEqual([50, 50, 20])

    const batch = { e: 'stats' as const, b: JSON.stringify(Array.from({ length: 30 }, () => ({}))) }
    expect(chunkSnippetEdgeRecords([batch, batch]).map(chunk => chunk.length)).toEqual([1, 1])
    // Too big to ever fit a chunk: dropped instead of failing the file.
    const huge = { e: 'stats' as const, b: JSON.stringify(Array.from({ length: 60 }, () => ({}))) }
    expect(chunkSnippetEdgeRecords([huge])).toEqual([])

    const groups = groupForSendBatch(Array.from({ length: 250 }, () => [many[0]!]))
    expect(groups.map(group => group.length)).toEqual([100, 100, 50])
  })

  it('sizes chunks in UTF-8 bytes, as the queue limit does', () => {
    // 1000 emoji: 2000 UTF-16 units, 4000 UTF-8 bytes each.
    const emoji = { e: 'stats' as const, b: JSON.stringify({ metadata: { message: '😀'.repeat(1000) } }) }
    expect(recordSize(emoji)).toBeGreaterThan(4000)
    for (const chunk of chunkSnippetEdgeRecords(Array.from<typeof emoji>({ length: 60 }).fill(emoji)))
      expect(new TextEncoder().encode(JSON.stringify({ snippetEdgeStats: chunk })).byteLength).toBeLessThan(128 * 1024)
  })

  it('recognises queue message shapes', () => {
    expect(isSnippetEdgeReplayMessage({ snippetEdgeStats: [] })).toBe(true)
    expect(isSnippetEdgeReplayMessage({ object: { key: 'a' } })).toBe(false)
    expect(isSnippetEdgeFileResumeMessage({ snippetEdgeStatsFile: 'a.log.gz', fromGroup: 2 })).toBe(true)
    expect(isSnippetEdgeFileResumeMessage({ snippetEdgeStatsFile: 'a.log.gz' })).toBe(false)
    expect(getR2NotificationObjectKey({ action: 'PutObject', object: { key: '20261006/a.log.gz' } })).toBe('20261006/a.log.gz')
    expect(getR2NotificationObjectKey({ action: 'DeleteObject', object: { key: 'a' } })).toBeNull()
  })

  it('replays an up-to-date answer as its stats only', async () => {
    const { app } = await import('../supabase/functions/_backend/plugin_runtime/plugins/updates.ts')
    const body = {
      app_id: 'com.edge.app',
      device_id: '00000000-0000-4000-8000-00000000000A',
      platform: 'ios',
      version_name: '1.2.3',
      version_build: '2.0',
      plugin_version: '7.40.0',
      is_emulator: false,
      is_prod: true,
    }
    const request = buildReplayRequest({ e: 'updates', b: JSON.stringify(body), n: '1.2.3', ip: '203.0.113.7', country: 'FR' })
    expect(request.headers.get('cf-connecting-ip')).toBe('203.0.113.7')
    expect((request as any).cf).toEqual({ country: 'FR' })

    const outer = new Hono()
    outer.route('/updates', app)
    const result = await replaySnippetEdgeRecords(
      [{ e: 'updates', b: JSON.stringify(body), n: '1.2.3' }],
      replayRequest => outer.fetch(replayRequest),
    )
    expect(result).toEqual({ replayed: 1, failed: [], rejected: 0 })
    // Owner and custom id setting come from the owner cache, not from the header.
    expect(getAppOwnerWithEdgeCache).toHaveBeenCalledWith(expect.anything(), 'com.edge.app', expect.anything(), ['mau', 'bandwidth'])
    expect(createStatsMau).toHaveBeenCalledWith(expect.anything(), body.device_id.toLowerCase(), 'com.edge.app', 'org-1', 'ios', '2.0.0')
    expect(sendStatsAndDevice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ device_id: body.device_id.toLowerCase(), custom_id: undefined }), [{ action: 'noNew', versionName: '1.2.3' }])
  })

  it('skips an up-to-date answer of a deleted app', async () => {
    const { app } = await import('../supabase/functions/_backend/plugin_runtime/plugins/updates.ts')
    getAppOwnerWithEdgeCache.mockResolvedValueOnce({ value: null, hit: false })
    const outer = new Hono()
    outer.route('/updates', app)
    const body = { app_id: 'com.edge.app', device_id: '00000000-0000-4000-8000-00000000000A', platform: 'ios', version_name: '1.2.3', version_build: '2.0', plugin_version: '7.40.0', is_emulator: false, is_prod: true }
    expect(await replaySnippetEdgeRecords([{ e: 'updates', b: JSON.stringify(body), n: '1.2.3' }], replayRequest => outer.fetch(replayRequest))).toEqual({ replayed: 1, failed: [], rejected: 0 })
    expect(sendStatsAndDevice).not.toHaveBeenCalled()
  })

  it('returns failed records for another attempt and counts rejected events', async () => {
    const records = [
      { e: 'stats' as const, b: '"5xx"' },
      { e: 'stats' as const, b: '"throw"' },
      { e: 'stats' as const, b: '"4xx"' },
      { e: 'stats' as const, b: '"error"' },
      { e: 'stats' as const, b: '"batch"' },
      { e: 'stats' as const, b: '"ok"' },
    ]
    const result = await replaySnippetEdgeRecords(records, async (request) => {
      const kind = JSON.parse(await request.text())
      if (kind === 'throw')
        throw new Error('rate limiter down')
      if (kind === '5xx')
        return new Response('{}', { status: 503 })
      if (kind === '4xx')
        return Response.json({ error: 'invalid_json_body' }, { status: 400 })
      if (kind === 'error')
        return Response.json({ error: 'semver_error' })
      if (kind === 'batch')
        return Response.json({ status: 'ok', results: [{ status: 'ok' }, { status: 'error' }, { status: 'error' }] })
      return Response.json({ status: 'ok' })
    })
    expect(result.failed.map(record => record.b).sort()).toEqual(['"5xx"', '"throw"'])
    expect(result.rejected).toBe(4)
    expect(result.replayed).toBe(4)
  })

  it('marks old replays so they skip device state', () => {
    const now = Date.now()
    const context = (eventTime?: number) => {
      const request = new Request('https://plugin.capgo.app/stats')
      markSnippetEdgeReplay(request, { endpoint: 'stats', eventTime })
      return { req: { raw: request } } as any
    }
    expect(isStaleSnippetEdgeReplay(context(now - 60_000), now)).toBe(false)
    expect(isStaleSnippetEdgeReplay(context(now - 11 * 60_000), now)).toBe(true)
    expect(isStaleSnippetEdgeReplay(context(undefined), now)).toBe(false)
    expect(isStaleSnippetEdgeReplay({ req: { raw: new Request('https://plugin.capgo.app/stats') } } as any, now)).toBe(false)
  })
})

describe('snippet edge stats queue', () => {
  const stat = (n: number) => ({ e: 'updates' as const, b: `{"app_id":"com.edge.app","n":${n}}`, n: '1.2.3' })

  function logFile(count: number) {
    return Array.from({ length: count }, (_, index) => JSON.stringify({ ResponseHeaders: { 'x-capgo-edge-stat': encodeStat(stat(index)) } })).join('\n')
  }

  function buildEnv(file: string | null) {
    const objects = new Map<string, string>(file === null ? [] : [['20261014/a.log', file]])
    const sent: unknown[] = []
    const env = {
      SNIPPET_EDGE_STATS_LOGS: {
        get: vi.fn(async (key: string) => objects.has(key) ? { body: new Response(objects.get(key)).body } : null),
        delete: vi.fn(async (key: string) => {
          objects.delete(key)
        }),
      },
      SNIPPET_EDGE_STATS_REPLAY: {
        sendBatch: vi.fn(async (messages: { body: unknown }[]) => {
          sent.push(...messages.map(message => message.body))
        }),
        send: vi.fn(async (body: unknown) => {
          sent.push(body)
        }),
      },
    }
    return { env: env as any, objects, sent }
  }

  const notification = { action: 'PutObject', object: { key: '20261014/a.log' } }

  it('queues a file once, then deletes it so a repeated notification replays nothing', async () => {
    const { env, objects, sent } = buildEnv(logFile(120))
    await handleSnippetEdgeStatsMessage(env, 'm1', notification, vi.fn())
    expect(sent.flatMap(message => (message as any).snippetEdgeStats)).toHaveLength(120)
    expect(objects.size).toBe(0)

    await handleSnippetEdgeStatsMessage(env, 'm2', notification, vi.fn())
    expect(sent.flatMap(message => (message as any).snippetEdgeStats)).toHaveLength(120)
  })

  it('resumes a file from the group whose send failed, without sending earlier groups again', async () => {
    const { env, objects, sent } = buildEnv(logFile(6000))
    let calls = 0
    env.SNIPPET_EDGE_STATS_REPLAY.sendBatch.mockImplementation(async (messages: { body: unknown }[]) => {
      if (++calls === 2)
        throw new Error('queue unavailable')
      sent.push(...messages.map(message => message.body))
    })
    await handleSnippetEdgeStatsMessage(env, 'm1', notification, vi.fn())
    const resume = sent.find(message => isSnippetEdgeFileResumeMessage(message))
    expect(resume).toEqual({ snippetEdgeStatsFile: '20261014/a.log', fromGroup: 1 })
    expect(objects.size).toBe(1)

    await handleSnippetEdgeStatsMessage(env, 'm2', resume, vi.fn())
    const replayed = sent.flatMap(message => (message as any).snippetEdgeStats ?? []).map((record: any) => record.b)
    expect(replayed).toHaveLength(6000)
    expect(new Set(replayed).size).toBe(6000)
    expect(objects.size).toBe(0)
    // Group 0, the failed group 1, then only group 1 again on resume.
    expect(calls).toBe(3)
  })

  it('queues only the failed records again, up to the attempt limit', async () => {
    const { env, sent } = buildEnv(null)
    const records = [stat(1), stat(2)]
    const handler = vi.fn(async (request: Request) => (await request.text()).includes('"n":1') ? new Response('{}', { status: 503 }) : Response.json({ status: 'ok' }))
    await handleSnippetEdgeStatsMessage(env, 'm1', { snippetEdgeStats: records }, handler)
    expect(sent).toEqual([{ snippetEdgeStats: [records[0]], attempt: 1 }])

    await handleSnippetEdgeStatsMessage(env, 'm2', { snippetEdgeStats: [records[0]], attempt: 2 }, handler)
    expect(sent).toHaveLength(1)
  })
})
