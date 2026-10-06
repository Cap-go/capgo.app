import { Buffer } from 'node:buffer'
import { gzipSync } from 'node:zlib'
import { Hono } from 'hono/tiny'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSnippetIpLimitHeader, setSnippetStatsFill, setSnippetUpdatesFill, SNIPPET_EDGE_FILL_HEADER, SNIPPET_EDGE_IP_LIMIT_HEADER } from '../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeAnswer.ts'
import { buildReplayRequest, chunkSnippetEdgeRecords, decodeSnippetEdgeStat, getR2NotificationObjectKey, groupForSendBatch, isSnippetEdgeReplayMessage, parseLogpushLine, readLogpushRecords, replaySnippetEdgeRecords } from '../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'

;

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

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: vi.fn((error: unknown) => error),
}))

const ANSWER = { ownerOrg: 'org-1', allowDeviceCustomId: true, versionName: '1.2.3', keyId: null }
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
  it('describe the up-to-date answer with both purge tags', async () => {
    const headers = await fillFrom(ENABLED_ENV, c => setSnippetUpdatesFill(c, 'com.edge.app', { ...ANSWER, versionName: 'v1 é' }, { blockProviderInfraRequests: false, legacyChannelSelfStore: true }))
    expect(readFill(headers)).toEqual({
      v: 1,
      bps: 10000,
      ttl: 900,
      tags: 'capgo-updates-com.edge.app,capgo-updates-com.edge.app:versions',
      e: 'updates',
      n: 'v1 é',
      k: null,
      o: 'org-1',
      a: true,
      cs: true,
    })
  })

  it('stay off without the switch, a purge target, or for apps the snippet cannot check', async () => {
    const write = (c: any) => setSnippetUpdatesFill(c, 'com.edge.app', ANSWER, { blockProviderInfraRequests: false, legacyChannelSelfStore: false })
    expect(readFill(await fillFrom({ CF_CACHE_PURGE_TOKEN: 'token' }, write))).toBeNull()
    expect(readFill(await fillFrom({ SNIPPET_EDGE_ANSWER: 'on' }, write))).toBeNull()
    expect(readFill(await fillFrom({ ...ENABLED_ENV, LIMITED_APPS: JSON.stringify([{ id: 'com.edge.app', ignore: 0.5 }]) }, write))).toBeNull()
    expect(readFill(await fillFrom(ENABLED_ENV, c => setSnippetUpdatesFill(c, 'com.edge.app', ANSWER, { blockProviderInfraRequests: true, legacyChannelSelfStore: false })))).toBeNull()
    expect(readFill(await fillFrom(ENABLED_ENV, c => setSnippetStatsFill(c, 'com.edge.app', true)))).toBeNull()
  })

  it('carry the share and TTL settings', async () => {
    const headers = await fillFrom({ ...ENABLED_ENV, SNIPPET_EDGE_ANSWER: '2.5%', SNIPPET_EDGE_ANSWER_TTL_SECONDS: '99999' }, c => setSnippetStatsFill(c, 'com.edge.app', false))
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

  const updatesStat = { e: 'updates', b: '{"app_id":"com.edge.app"}', o: 'org-1', a: false, n: '1.2.3' }

  function logLine(stat: unknown, extra: Record<string, unknown> = {}) {
    return JSON.stringify({ ClientIP: '203.0.113.7', ClientCountry: 'fr', ResponseHeaders: { 'x-capgo-edge-stat': encodeStat(stat) }, ...extra })
  }

  it('decodes the snippet stat header and Logpush lines', () => {
    expect(decodeSnippetEdgeStat(encodeStat(updatesStat))).toEqual(updatesStat)
    expect(decodeSnippetEdgeStat(encodeStat({ e: 'updates', b: '{}' }))).toBeNull()
    expect(decodeSnippetEdgeStat('%%%')).toBeNull()
    expect(parseLogpushLine(logLine(updatesStat))).toEqual({ ...updatesStat, ip: '203.0.113.7', country: 'FR' })
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
    const many = Array.from({ length: 120 }, () => ({ e: 'updates' as const, b: '{}', o: 'org', a: true, n: '1' }))
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

  it('recognises queue message shapes', () => {
    expect(isSnippetEdgeReplayMessage({ snippetEdgeStats: [] })).toBe(true)
    expect(isSnippetEdgeReplayMessage({ object: { key: 'a' } })).toBe(false)
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
    const request = buildReplayRequest({ e: 'updates', b: JSON.stringify(body), o: 'org-1', a: false, n: '1.2.3', ip: '203.0.113.7', country: 'FR' })
    expect(request.headers.get('cf-connecting-ip')).toBe('203.0.113.7')
    expect((request as any).cf).toEqual({ country: 'FR' })

    const outer = new Hono()
    outer.route('/updates', app)
    const result = await replaySnippetEdgeRecords(
      [{ e: 'updates', b: JSON.stringify(body), o: 'org-1', a: false, n: '1.2.3' }],
      replayRequest => outer.fetch(replayRequest),
    )
    expect(result).toEqual({ replayed: 1, failed: 0 })
    expect(createStatsMau).toHaveBeenCalledWith(expect.anything(), body.device_id.toLowerCase(), 'com.edge.app', 'org-1', 'ios', '2.0.0')
    expect(sendStatsAndDevice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ device_id: body.device_id.toLowerCase(), custom_id: undefined }), [{ action: 'noNew', versionName: '1.2.3' }])
  })
})
