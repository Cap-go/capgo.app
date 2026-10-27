// Owner lookup PG failures must surface as 5xx, not sticky onprem (regression for plugin-oc-prod drops).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setAppStatusMock = vi.fn(() => Promise.resolve())
const ownerLookupLimitMock = vi.fn()

;(globalThis as any).EdgeRuntime = undefined

function connectionTerminatedError() {
  return Object.assign(new Error('Failed query: select from apps'), {
    name: 'DrizzleQueryError',
    cause: new Error('Connection terminated unexpectedly'),
  })
}

function ownerLookupFailingDrizzle() {
  const error = connectionTerminatedError()
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          leftJoin: () => ({
            limit: () => {
              ownerLookupLimitMock()
              return Promise.reject(error)
            },
          }),
        }),
      }),
    }),
  } as any
}

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/logging.ts')>()
  return {
    ...actual,
    cloudlog: vi.fn(),
    cloudlogErr: vi.fn(),
  }
})

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts', () => ({
  getAppStatus: vi.fn(() => Promise.resolve({
    status: null,
    allow_device_custom_id: true,
    block_provider_infra_requests: false,
    cacheHit: false,
  })),
  setAppStatus: setAppStatusMock,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/discord.ts', () => ({
  sendDiscordAlert500: vi.fn(() => Promise.resolve()),
  sendDiscordAlert: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/invalids_ip.ts', () => ({
  invalidIpInfo: vi.fn(async () => ({ blocked: false })),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/notifications.ts', () => ({
  sendNotifOrgCached: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts', () => ({
  createStatsMau: vi.fn(() => Promise.resolve()),
  createStatsVersion: vi.fn(() => Promise.resolve()),
  onPremStats: vi.fn(() => Promise.resolve()),
  sendStatsAndDevice: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/utils.ts')>()
  return {
    ...actual,
    backgroundTask: vi.fn((_c: unknown, p: Promise<unknown> | (() => Promise<unknown>)) => {
      const result = typeof p === 'function' ? p() : p
      return Promise.resolve(result).catch(() => undefined)
    }),
    isLimited: vi.fn(() => false),
  }
})

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')>()
  return {
    ...actual,
    getPgClient: vi.fn(async () => ({})),
    getDrizzleClient: vi.fn(() => ownerLookupFailingDrizzle()),
    closeClient: vi.fn(async () => undefined),
    getReadReplicaBinding: vi.fn(() => null),
    getLazyPgQueryCount: vi.fn(() => 0),
    getEffectiveDeviceChannelNamePostgres: vi.fn(async () => null),
    getAppVersionPostgres: vi.fn(async () => null),
  }
})

function createContext() {
  return {
    get: (key: string) => (key === 'requestId' ? '1493ea04' : undefined),
    set: vi.fn(),
    header: vi.fn(),
    res: { headers: new Headers() },
    req: {
      method: 'POST',
      path: '/stats',
      header: () => undefined,
      raw: { cf: {} },
    },
  } as any
}

const statsEventBody = {
  platform: 'android',
  device_id: 'ac4135b3-fda6-449e-b0fe-88680ab67105',
  app_id: 'com.trial.app',
  version_build: '1.0.0',
  version_name: '1.0.0',
  plugin_version: '8.51.0',
  version_os: '17',
  action: 'app_moved_to_foreground',
  custom_id: '',
  is_emulator: false,
  is_prod: true,
}

async function fetchStatsLikeProduction(request: Request, context: ReturnType<typeof createContext>) {
  const { createAllCatch, createHono } = await import('../supabase/functions/_backend/plugin_runtime/utils/hono.ts')
  const { app } = await import('../supabase/functions/_backend/plugin_runtime/plugins/stats.ts')
  const { version } = await import('../supabase/functions/_backend/plugin_runtime/utils/version.ts')
  const wrapper = createHono('stats', version)
  wrapper.route('/', app)
  createAllCatch(wrapper, 'stats')
  return wrapper.fetch(request, context, { waitUntil: () => {} } as any)
}

describe('/stats owner lookup DB errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getAppOwnerPostgres rethrows connection loss instead of returning null', async () => {
    const { getAppOwnerPostgres } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')

    await expect(getAppOwnerPostgres(createContext(), 'com.trial.app', ownerLookupFailingDrizzle(), ['mau', 'bandwidth']))
      .rejects.toMatchObject({
        name: 'DrizzleQueryError',
        cause: { message: 'Connection terminated unexpectedly' },
      })
  })

  it('does not sticky-cache onprem when owner lookup fails', async () => {
    const response = await fetchStatsLikeProduction(new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(statsEventBody),
    }), createContext())

    expect(response.status).toBe(503)
    expect(ownerLookupLimitMock).toHaveBeenCalled()
    const text = await response.text()
    expect(text).not.toContain('on_premise_app')
    expect(setAppStatusMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'com.trial.app',
      'onprem',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('batch stats rethrows owner DB errors instead of per-event on_premise_app', async () => {
    const response = await fetchStatsLikeProduction(new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { ...statsEventBody, action: 'app_moved_to_foreground' },
        { ...statsEventBody, action: 'app_moved_to_background' },
      ]),
    }), createContext())

    expect(response.status).toBe(503)
    expect(ownerLookupLimitMock).toHaveBeenCalled()
    const text = await response.text()
    expect(text).not.toContain('on_premise_app')
    expect(setAppStatusMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'com.trial.app',
      'onprem',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })
})
