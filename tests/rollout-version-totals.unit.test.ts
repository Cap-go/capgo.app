import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStatsVersionCF } from '../supabase/functions/_backend/utils/cloudflare.ts'
import {
  buildRolloutLegacyFailsCFQuery,
  buildRolloutVersionTotalsCFQuery,
  readRolloutVersionTotalsCF,
} from '../supabase/functions/_backend/utils/cloudflare_rollout_stats.ts'

// Rollout auto-pause reads all channels of one app with one version_usage and
// one app_log query. A small Analytics Engine stand-in over raw events checks
// that every channel gets the totals its own readStatsVersionCF read gives.

function context() {
  return {
    env: {
      CF_ANALYTICS_TOKEN: 'token',
      CF_ACCOUNT_ANALYTICS_ID: 'account',
      DEVICE_USAGE: {},
      BANDWIDTH_USAGE: {},
      VERSION_USAGE: {},
      APP_LOG: {},
    },
    get: vi.fn((key: string) => key === 'requestId' ? 'test-request' : undefined),
  } as unknown as Context
}

const NUMERIC = new Set(['mau', 'bandwidth', 'get', 'fail', 'install', 'uninstall', 'count'])

function aeResponse(rows: Record<string, unknown>[]) {
  const names = new Set<string>()
  for (const row of rows)
    Object.keys(row).forEach(name => names.add(name))
  const meta = [...names].map(name => ({ name, type: NUMERIC.has(name) || /^[ifl]\d+$/.test(name) ? 'Float64' : 'String' }))
  return new Response(JSON.stringify({ data: rows, meta, rows: rows.length }), { status: 200 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

interface VersionEvent { app: string, channelId: string, channelName: string, version: string, action: 'install' | 'fail' | 'get', at: string, sample?: number }
interface LogEvent { app: string, channelId: string, channelName: string, version: string, plugin: string, at: string, flagged?: boolean }

const END = '2026-11-17T12:00:00.000Z'

const versionEvents: VersionEvent[] = [
  // Channel 1 (app A, 1.1.0, window from 10:00)
  { app: 'app.a', channelId: '1', channelName: 'production', version: '1.1.0', action: 'install', at: '2026-11-17T10:30:00Z', sample: 40 },
  { app: 'app.a', channelId: '1', channelName: 'production', version: '1.1.0', action: 'fail', at: '2026-11-17T11:00:00Z', sample: 9 },
  { app: 'app.a', channelId: '1', channelName: 'production', version: '1.1.0', action: 'fail', at: '2026-11-17T09:00:00Z', sample: 100 }, // before window
  { app: 'app.a', channelId: '1', channelName: 'production', version: '1.0.0', action: 'fail', at: '2026-11-17T11:00:00Z', sample: 50 }, // other version
  // Legacy row without a channel id, matched by name
  { app: 'app.a', channelId: '', channelName: 'production', version: '1.1.0', action: 'install', at: '2026-11-17T11:30:00Z', sample: 5 },
  // Channel 2 (app A, beta, 1.2.0, window over two days)
  { app: 'app.a', channelId: '2', channelName: 'beta', version: '1.2.0', action: 'install', at: '2026-11-16T20:00:00Z', sample: 10 },
  { app: 'app.a', channelId: '2', channelName: 'beta', version: '1.2.0', action: 'fail', at: '2026-11-16T21:00:00Z', sample: 2 },
  { app: 'app.a', channelId: '2', channelName: 'beta', version: '1.2.0', action: 'fail', at: '2026-11-17T01:00:00Z', sample: 4 },
  // Channel 3 (staging) and an event of another app that must not count
  { app: 'app.b', channelId: '1', channelName: 'production', version: '1.1.0', action: 'fail', at: '2026-11-17T11:00:00Z', sample: 500 },
  { app: 'app.a', channelId: '3', channelName: 'staging', version: '3.0.0', action: 'install', at: '2026-11-17T11:50:00Z', sample: 7 },
  { app: 'app.a', channelId: '3', channelName: 'staging', version: '3.0.0', action: 'fail', at: '2026-11-17T11:55:00Z', sample: 1 },
  { app: 'app.a', channelId: '3', channelName: 'staging', version: '3.0.0', action: 'get', at: '2026-11-17T11:55:00Z', sample: 1000 },
]

const logEvents: LogEvent[] = [
  { app: 'app.a', channelId: '1', channelName: 'production', version: '1.1.0', plugin: '6.10.0', at: '2026-11-17T11:10:00Z' },
  { app: 'app.a', channelId: '1', channelName: 'production', version: '1.1.0', plugin: '6.10.0', at: '2026-11-17T11:11:00Z' },
  { app: 'app.a', channelId: '1', channelName: 'production', version: '1.1.0', plugin: '8.60.0', at: '2026-11-17T11:12:00Z' }, // fixed plugin
  { app: 'app.a', channelId: '1', channelName: 'production', version: '1.1.0', plugin: '6.10.0', at: '2026-11-17T11:13:00Z', flagged: true }, // already flagged
  // More legacy fails than recorded fails on 11-17 for channel 2: clamped at 0
  { app: 'app.a', channelId: '2', channelName: 'beta', version: '1.2.0', plugin: '5.2.0', at: '2026-11-17T02:00:00Z' },
  { app: 'app.a', channelId: '2', channelName: 'beta', version: '1.2.0', plugin: '5.2.0', at: '2026-11-17T02:00:00Z' },
  { app: 'app.a', channelId: '2', channelName: 'beta', version: '1.2.0', plugin: '5.2.0', at: '2026-11-17T02:00:00Z' },
  { app: 'app.a', channelId: '2', channelName: 'beta', version: '1.2.0', plugin: '5.2.0', at: '2026-11-17T02:00:00Z' },
  { app: 'app.a', channelId: '2', channelName: 'beta', version: '1.2.0', plugin: '5.2.0', at: '2026-11-17T02:00:00Z' },
]

const windows = [
  { appId: 'app.a', channel: { id: 1, name: 'production' }, versionName: '1.1.0', start: '2026-11-17T10:00:00.000Z' },
  { appId: 'app.a', channel: { id: 2, name: 'beta' }, versionName: '1.2.0', start: '2026-11-16T12:00:00.000Z' },
  { appId: 'app.a', channel: { id: 3, name: 'staging' }, versionName: '3.0.0', start: '2026-11-17T11:00:00.000Z' },
]

const day = (at: string) => at.slice(0, 10)
const inRange = (at: string, start: string, end: string) => new Date(at) >= new Date(start) && new Date(at) < new Date(end)
function matchesChannel(event: { channelId: string, channelName: string }, channel: { id: number, name: string }) {
  return event.channelId === String(channel.id) || (event.channelId === '' && event.channelName === channel.name)
}

function cfDate(value: string) {
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString()
}

function mockRolloutAnalyticsEngine(options: { failLegacy?: boolean } = {}) {
  const queries: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const query = String(init.body)
    queries.push(query)
    const isLog = query.includes('FROM app_log')
    if (isLog && options.failLegacy)
      return new Response('unavailable', { status: 503 })
    const end = cfDate(/timestamp < toDateTime\('([^']+)'\)/.exec(query)![1]!)

    if (query.includes(' AS i0') || query.includes(' AS l0')) {
      // Batched query: conditional sums per channel, grouped per day.
      const byKey = new Map<string, Record<string, unknown>>()
      const add = (key: string, base: Record<string, unknown>, column: string, value: number) => {
        const row = byKey.get(key) ?? { ...base }
        row[column] = Number(row[column] ?? 0) + value
        byKey.set(key, row)
      }
      if (!isLog) {
        for (const event of versionEvents) {
          windows.forEach((window, index) => {
            if (event.app === window.appId && matchesChannel(event, window.channel) && event.version === window.versionName && inRange(event.at, window.start, end) && event.action !== 'get')
              add(`${day(event.at)}|${event.app}`, { date: day(event.at), app_id: event.app }, `${event.action === 'install' ? 'i' : 'f'}${index}`, event.sample ?? 1)
          })
        }
        // Every column exists on every row, like a real SQL result.
        for (const row of byKey.values()) {
          windows.forEach((_window, index) => {
            row[`i${index}`] ??= 0
            row[`f${index}`] ??= 0
          })
        }
      }
      else {
        for (const event of logEvents.filter(event => !event.flagged)) {
          windows.forEach((window, index) => {
            if (event.app === window.appId && matchesChannel(event, window.channel) && event.version === window.versionName && inRange(event.at, window.start, end))
              add(`${day(event.at)}|${event.plugin}`, { bucket: day(event.at), plugin_version: event.plugin }, `l${index}`, 1)
          })
        }
      }
      return aeResponse([...byKey.values()])
    }

    // Single-channel readStatsVersionCF query.
    const start = cfDate(/timestamp >= toDateTime\('([^']+)'\)/.exec(query)![1]!)
    const window = windows.find(window => query.includes(`'${window.appId}'`) && query.includes(`= '${window.channel.id}'`))!
    const rows = new Map<string, Record<string, unknown>>()
    if (!isLog) {
      for (const event of versionEvents) {
        if (event.app !== window.appId || !matchesChannel(event, window.channel) || !inRange(event.at, start, end))
          continue
        const key = `${day(event.at)}|${event.version}`
        const row = rows.get(key) ?? { app_id: event.app, version_name: event.version, date: day(event.at), get: 0, fail: 0, install: 0, uninstall: 0 }
        row[event.action] = Number(row[event.action]) + (event.sample ?? 1)
        rows.set(key, row)
      }
    }
    else {
      for (const event of logEvents.filter(event => !event.flagged)) {
        if (event.app !== window.appId || !matchesChannel(event, window.channel) || !inRange(event.at, start, end))
          continue
        const key = `${day(event.at)}|${event.version}|${event.plugin}`
        const row = rows.get(key) ?? { bucket: day(event.at), version_name: event.version, plugin_version: event.plugin, count: 0 }
        row.count = Number(row.count) + 1
        rows.set(key, row)
      }
    }
    return aeResponse([...rows.values()])
  }))
  return queries
}

describe('batched rollout auto-pause reads', () => {
  it('gives every channel the totals of its own readStatsVersionCF read', async () => {
    const queries = mockRolloutAnalyticsEngine()
    const c = context()

    const batched = await readRolloutVersionTotalsCF(c, windows, END)
    expect(queries).toHaveLength(2)

    queries.length = 0
    const single = []
    for (const window of windows) {
      const rows = await readStatsVersionCF(c, window.appId, window.start, END, window.channel)
      single.push(rows
        .filter(row => row.version_name === window.versionName)
        .reduce((acc, row) => ({ installs: acc.installs + Number(row.install ?? 0), failures: acc.failures + Number(row.fail ?? 0) }), { installs: 0, failures: 0 }))
    }
    expect(queries).toHaveLength(2 * windows.length)

    expect(batched).toEqual(single)
    expect(batched).toEqual([
      { installs: 45, failures: 7 },
      { installs: 10, failures: 2 },
      { installs: 7, failures: 1 },
    ])
  })

  it('returns null when a query fails so the channels are retried', async () => {
    mockRolloutAnalyticsEngine({ failLegacy: true })
    await expect(readRolloutVersionTotalsCF(context(), windows, END)).resolves.toBeNull()
  })

  it('refuses to mix apps in one query', () => {
    expect(() => buildRolloutVersionTotalsCFQuery([...windows, { ...windows[0]!, appId: 'app.b' }], END)).toThrow('exactly one app')
  })

  it('keeps each channel inside its window, channel and version', () => {
    const query = buildRolloutVersionTotalsCFQuery(windows, END)
    expect(query).toContain(`index1 = 'app.a'`)
    expect(query).toContain(`timestamp >= toDateTime('2026-11-16 12:00:00')`)
    expect(query).toContain(`(timestamp >= toDateTime('2026-11-17 11:00:00')) AND (blob2 = '3.0.0') AND ((blob5 = '3' OR (blob5 = '' AND blob4 = 'staging')))`)
    const legacy = buildRolloutLegacyFailsCFQuery(windows, END)
    expect(legacy).toContain(`(blob3 = '1.1.0') AND ((blob9 = '1' OR (blob9 = '' AND blob8 = 'production')))`)
    expect(legacy).toContain(`AND blob10 = ''`)
  })
})
