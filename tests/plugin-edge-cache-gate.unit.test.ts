import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * One switch (UPDATES_EDGE_CACHE) and one per-device decision drive the edge
 * cache of every plugin endpoint. The cached path is observable through the
 * client it opens: the lazy client (connects on first query, sets
 * X-Updates-Cache) vs the eager getPgClient of today's path.
 */

const eagerClient = { query: vi.fn() }
const getPgClientMock = vi.fn(async () => eagerClient)
const lazyClose = vi.fn(async () => {})
const createLazyPgClientMock = vi.fn(() => ({ client: { query: vi.fn() }, isConnected: () => false, close: lazyClose }))

;(globalThis as any).EdgeRuntime = undefined

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')>()
  return {
    ...actual,
    closeClient: vi.fn(() => Promise.resolve()),
    createLazyPgClient: createLazyPgClientMock,
    getDatabaseURL: vi.fn(() => 'postgresql://replica.example/postgres'),
    getLazyPgQueryCount: vi.fn(() => 0),
    getPgClient: getPgClientMock,
    refreshReplicationLag: vi.fn(() => Promise.resolve()),
    setReplicationLagHeader: vi.fn(() => Promise.resolve()),
  }
})

// An on-prem app answers right after the client is chosen on every endpoint,
// so no query or other dependency is needed to see which path ran.
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts', () => ({
  getAppStatus: vi.fn(async () => ({ status: 'onprem', cacheHit: true, allow_device_custom_id: true, block_provider_infra_requests: false })),
  setAppStatus: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts', () => ({
  createStatsBandwidth: vi.fn(() => Promise.resolve()),
  createStatsMau: vi.fn(() => Promise.resolve()),
  createStatsVersion: vi.fn(() => Promise.resolve()),
  onPremStats: vi.fn(async () => new Response(JSON.stringify({ error: 'on_premise_app' }), { status: 429, headers: { 'Content-Type': 'application/json' } })),
  sendStatsAndDevice: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/updateOracleGuard.ts', () => ({
  isUpdateEnumerationLimited: vi.fn(async () => ({ limited: false })),
  recordUpdateEnumerationMiss: vi.fn(async () => ({ limited: false })),
  updateEnumerationLimitedResponse: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/channelSelfRateLimit.ts', () => ({
  checkChannelSelfIPRateLimit: vi.fn(async () => ({ limited: false })),
  isChannelSelfRateLimited: vi.fn(async () => ({ limited: false })),
  recordChannelSelfIPRequest: vi.fn(() => Promise.resolve()),
  recordChannelSelfRequest: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: vi.fn((error: unknown) => error),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/discord.ts', () => ({
  sendDiscordAlert500: vi.fn(() => Promise.resolve()),
  sendDiscordAlert: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/utils.ts')>()
  return {
    ...actual,
    backgroundTask: vi.fn((_c: unknown, p: Promise<unknown>) => Promise.resolve(p).catch(() => undefined)),
    isLimited: vi.fn(() => false),
  }
})

const APP_ID = 'com.example.edgegate'
type Endpoint = 'updates' | 'stats' | 'channel_self' | 'channel_self_list'
const ENDPOINTS: Endpoint[] = ['updates', 'stats', 'channel_self', 'channel_self_list']

function deviceId(i: number) {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
}

function baseBody(device: string) {
  return {
    app_id: APP_ID,
    device_id: device,
    platform: 'android',
    version_name: '1.0.0',
    version_build: '1.0.0',
    version_code: '1',
    version_os: '13',
    plugin_version: '7.40.0',
    custom_id: '',
    is_emulator: false,
    is_prod: true,
  }
}

async function call(endpoint: Endpoint, device: string, extra: Record<string, unknown> = {}) {
  const modules = {
    updates: () => import('../supabase/functions/_backend/plugin_runtime/plugins/updates.ts'),
    stats: () => import('../supabase/functions/_backend/plugin_runtime/plugins/stats.ts'),
    channel_self: () => import('../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts'),
    channel_self_list: () => import('../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts'),
  }
  const { app } = await modules[endpoint]()
  if (endpoint === 'channel_self_list') {
    const query = new URLSearchParams(Object.entries(baseBody(device)).map(([key, value]) => [key, String(value)]))
    return app.fetch(new Request(`http://plugin.example.test/?${query}`, { method: 'GET' }), {}, { waitUntil: () => {} } as any)
  }
  const body = { ...baseBody(device), ...(endpoint === 'stats' ? { action: 'app_moved_to_foreground' } : {}), ...extra }
  return app.fetch(new Request('http://plugin.example.test/', {
    method: endpoint === 'channel_self' ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), {}, { waitUntil: () => {} } as any)
}

/** Which path served the request: 'cached' (lazy client) or 'live' (eager client). */
async function pathOf(endpoint: Endpoint, device: string) {
  getPgClientMock.mockClear()
  createLazyPgClientMock.mockClear()
  const response = await call(endpoint, device)
  const lazy = createLazyPgClientMock.mock.calls.length > 0
  const eager = getPgClientMock.mock.calls.length > 0
  expect(lazy && eager, `${endpoint} opened both clients`).toBe(false)
  expect(lazy || eager, `${endpoint} opened no client (status ${response.status})`).toBe(true)
  if (lazy)
    expect(response.headers.get('X-Updates-Cache')).toBe('hit')
  else
    expect(response.headers.get('X-Updates-Cache')).toBeNull()
  return lazy ? 'cached' : 'live'
}

describe('plugin edge cache gate (UPDATES_EDGE_CACHE)', () => {
  beforeEach(() => {
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'mock-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(ENDPOINTS)('%s keeps the live path when the flag is off or unset', async (endpoint) => {
    vi.stubEnv('UPDATES_EDGE_CACHE', 'off')
    expect(await pathOf(endpoint, deviceId(1))).toBe('live')
    vi.stubEnv('UPDATES_EDGE_CACHE', '')
    expect(await pathOf(endpoint, deviceId(1))).toBe('live')
  })

  it.each(ENDPOINTS)('%s uses the cached path when the flag is on', async (endpoint) => {
    vi.stubEnv('UPDATES_EDGE_CACHE', 'on')
    expect(await pathOf(endpoint, deviceId(1))).toBe('cached')
  })

  it.each(ENDPOINTS)('%s stays live without a purge target even with the flag on', async (endpoint) => {
    vi.stubEnv('UPDATES_EDGE_CACHE', 'on')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', '')
    vi.stubEnv('CF_ANALYTICS_TOKEN', '')
    vi.stubEnv('UPDATES_CACHE_LOCAL_PURGE_URL', '')
    expect(await pathOf(endpoint, deviceId(1))).toBe('live')
  })

  it('never serves legacy primary-backed /channel_self requests from the edge cache', async () => {
    vi.stubEnv('UPDATES_EDGE_CACHE', 'on')
    createLazyPgClientMock.mockClear()
    getPgClientMock.mockClear()
    // Plugin < 7.34 without the channel_self KV store reads and writes channel_devices on the primary.
    await call('channel_self', deviceId(1), { plugin_version: '7.20.0' })
    expect(createLazyPgClientMock).not.toHaveBeenCalled()
    expect(getPgClientMock).toHaveBeenCalledTimes(1)
    for (const [, readOnly] of getPgClientMock.mock.calls as unknown as [unknown, boolean][])
      expect(readOnly).toBe(false)
  })

  it('applies a percentage with the same per-device decision on every endpoint', async () => {
    const { updatesEdgeCacheBucket } = await import('../supabase/functions/_backend/plugin_runtime/utils/updatesEdgeCache.ts')
    vi.stubEnv('UPDATES_EDGE_CACHE', '50%')
    const seen = new Set<string>()
    for (let i = 0; i < 16; i++) {
      const device = deviceId(i)
      const expected = updatesEdgeCacheBucket(APP_ID, device) < 5000 ? 'cached' : 'live'
      seen.add(expected)
      for (const endpoint of ENDPOINTS)
        expect(await pathOf(endpoint, device), `${endpoint} ${device}`).toBe(expected)
    }
    // The sample covers both sides of the split.
    expect(seen).toEqual(new Set(['cached', 'live']))
  })
})
