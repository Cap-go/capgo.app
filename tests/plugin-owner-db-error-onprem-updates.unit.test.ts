import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAppOwnerPostgresMock = vi.fn()
const setAppStatusMock = vi.fn(() => Promise.resolve())

;(globalThis as any).EdgeRuntime = undefined

function connectionTerminatedError() {
  return Object.assign(new Error('Failed query: select from apps'), {
    name: 'DrizzleQueryError',
    cause: new Error('Connection terminated unexpectedly'),
  })
}

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts', () => ({
  getAppStatus: vi.fn(() => Promise.resolve({
    status: null,
    allow_device_custom_id: true,
    block_provider_infra_requests: false,
    cacheHit: false,
  })),
  setAppStatus: setAppStatusMock,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/channelSelfStore.ts', () => ({
  getChannelSelfOverride: vi.fn(() => Promise.resolve(null)),
  isChannelSelfStoreEnabled: vi.fn(() => false),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/notifications.ts', () => ({
  sendNotifOrgCached: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/org_email_notifications.ts', () => ({
  sendNotifToOrgMembersCached: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', () => ({
  closeClient: vi.fn(() => Promise.resolve()),
  getAppOwnerPostgres: getAppOwnerPostgresMock,
  getDrizzleClient: vi.fn(() => ({})),
  getPgClient: vi.fn(() => Promise.resolve({ client: 'pg' })),
  requestInfosChannelDevicePostgres: vi.fn(() => Promise.resolve(null)),
  requestInfosChannelPostgres: vi.fn(() => Promise.resolve(null)),
  requestInfosPostgres: vi.fn(() => Promise.resolve({ channelData: null, channelOverride: null })),
  setReplicationLagHeader: vi.fn(() => Promise.resolve()),
  createLazyPgClient: vi.fn(),
  getReadReplicaBinding: vi.fn(() => null),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts', () => ({
  createStatsMau: vi.fn(() => Promise.resolve()),
  createStatsVersion: vi.fn(() => Promise.resolve()),
  onPremStats: vi.fn(() => Promise.resolve(new Response('{}'))),
  sendStatsAndDevice: vi.fn(() => Promise.resolve()),
}))

function createContext() {
  return {
    get: (key: string) => (key === 'requestId' ? '2180aba7' : undefined),
    set: vi.fn(),
    header: vi.fn(),
    res: { headers: new Headers() },
    req: {
      method: 'POST',
      path: '/updates',
      header: () => undefined,
      raw: { cf: {} },
    },
  } as any
}

describe('/updates owner lookup DB errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAppOwnerPostgresMock.mockRejectedValue(connectionTerminatedError())
  })

  it('does not return on_premise_app when owner lookup fails', async () => {
    const { updateWithPG } = await import('../supabase/functions/_backend/plugin_runtime/utils/update.ts')
    const app = new Hono()
    const body = {
      app_id: 'com.trial.app',
      device_id: '11111111-1111-4111-8111-111111111111',
      platform: 'ios',
      version_build: '1.0.0',
      version_name: '1.0.0',
      version_os: '17.0',
      plugin_version: '7.34.0',
      defaultChannel: '',
      is_emulator: false,
      is_prod: true,
    }
    app.get('/', c => updateWithPG(c, body as any, {} as any))

    const response = await app.fetch(new Request('http://localhost/'), createContext(), { waitUntil: () => {} } as any)

    expect(response.status).toBe(500)
    expect(getAppOwnerPostgresMock).toHaveBeenCalledWith(
      expect.anything(),
      'com.trial.app',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
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
