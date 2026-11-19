import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A /stats batch carries one app_id: on the Postgres path it must read the
 * app owner once, each bundle once and each device channel once, not about
 * three times per event, and an oversized batch is refused before any read.
 */

const PRIMARY_CLIENT = { kind: 'primary' }
const REPLICA_CLIENT = { kind: 'replica' }

const getPgClientMock = vi.fn(async (_c: unknown, readOnly = false) => (
  readOnly ? REPLICA_CLIENT : PRIMARY_CLIENT
))
const getDrizzleClientMock = vi.fn((client: { kind: string }) => client)
const getAppOwnerPostgresMock = vi.fn(async (_c: unknown, _appId: string, drizzleClient: { kind: string }) => {
  // The plugin path reads the replica only.
  if (drizzleClient?.kind === 'replica') {
    return {
      allow_device_custom_id: true,
      block_provider_infra_requests: false,
      channel_device_count: 0,
      expose_metadata: false,
      manifest_bundle_count: 0,
      owner_org: 'org-1',
      orgs: { created_by: 'user-1', id: 'org-1', management_email: 'owner@example.com' },
      plan_valid: true,
      rollout_channel_count: 0,
      rollout_paused_version_names: [],
    }
  }
  return null
})
const setAppStatusMock = vi.fn(() => Promise.resolve())
const getAppStatusMock = vi.fn(async () => ({
  status: null,
  allow_device_custom_id: true,
  block_provider_infra_requests: false,
  cacheHit: false,
}))
const onPremStatsMock = vi.fn(() => Promise.resolve())
const sendStatsAndDeviceMock = vi.fn(() => Promise.resolve())
const createStatsMauMock = vi.fn(() => Promise.resolve())
const createStatsVersionMock = vi.fn(() => Promise.resolve())
const lookupAppVersionPostgresMock = vi.fn(async (): Promise<{ value: { id: number, owner_org: string } | null, failed: boolean }> => ({ value: { id: 1, owner_org: 'org-1' }, failed: false }))
const getEffectiveDeviceChannelNamePostgresMock = vi.fn(async () => null)

;(globalThis as any).EdgeRuntime = undefined

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts', () => ({
  getAppStatus: getAppStatusMock,
  setAppStatus: setAppStatusMock,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/discord.ts', () => ({
  sendDiscordAlert500: vi.fn(() => Promise.resolve()),
  sendDiscordAlert: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/invalids_ip.ts', () => ({
  invalidIpInfo: vi.fn(async () => ({ blocked: false })),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/notifications.ts', () => ({
  sendNotifOrgCached: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', () => ({
  closeClient: vi.fn(() => Promise.resolve()),
  getAppOwnerPostgres: getAppOwnerPostgresMock,
  getDrizzleClient: getDrizzleClientMock,
  getEffectiveDeviceChannelNamePostgres: getEffectiveDeviceChannelNamePostgresMock,
  getPgClient: getPgClientMock,
  getReadReplicaBinding: vi.fn(() => null),
  lookupAppVersionPostgres: lookupAppVersionPostgresMock,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts', () => ({
  createStatsMau: createStatsMauMock,
  createStatsVersion: createStatsVersionMock,
  onPremStats: onPremStatsMock,
  sendStatsAndDevice: sendStatsAndDeviceMock,
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

const APP_ID = 'com.batch.stats'
const DEVICE_ID = 'ac4135b3-fda6-449e-b0fe-88680ab67105'

function statsEvent(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'android',
    device_id: DEVICE_ID,
    app_id: APP_ID,
    version_build: '5.5.2',
    version_name: '5.5.6',
    plugin_version: '8.51.0',
    version_os: '17',
    action: 'set',
    is_emulator: false,
    is_prod: true,
    ...overrides,
  }
}

async function postStats(body: unknown) {
  const { app } = await import('../supabase/functions/_backend/plugin_runtime/plugins/stats.ts')
  return app.fetch(new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), {}, { waitUntil: () => {} } as any)
}

describe('stats batch reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the owner, bundle and channel once for a batch of one app and device', async () => {
    const events = Array.from({ length: 50 }, () => statsEvent({ old_version_name: '5.5.5' }))
    const response = await postStats(events)
    const body = await response.json() as { status: string, results: Array<{ status: string }> }

    expect(response.status).toBe(200)
    expect(body.results).toHaveLength(50)
    expect(body.results.every(result => result.status === 'ok')).toBe(true)
    expect(getAppOwnerPostgresMock).toHaveBeenCalledTimes(1)
    // 5.5.6 and 5.5.5: one read per distinct bundle name.
    expect(lookupAppVersionPostgresMock).toHaveBeenCalledTimes(2)
    expect(getEffectiveDeviceChannelNamePostgresMock).toHaveBeenCalledTimes(1)
    expect(getPgClientMock).toHaveBeenCalledTimes(1)
  })

  it('reads the channel once per distinct device', async () => {
    const response = await postStats([
      statsEvent(),
      statsEvent({ device_id: 'bc4135b3-fda6-449e-b0fe-88680ab67105' }),
      statsEvent(),
    ])

    expect(response.status).toBe(200)
    expect(getAppOwnerPostgresMock).toHaveBeenCalledTimes(1)
    expect(getEffectiveDeviceChannelNamePostgresMock).toHaveBeenCalledTimes(2)
  })

  it('retries a failed bundle read on the next event instead of keeping it', async () => {
    lookupAppVersionPostgresMock.mockResolvedValueOnce({ value: null, failed: true })
    const response = await postStats([statsEvent(), statsEvent(), statsEvent()])

    expect(response.status).toBe(200)
    // First read failed: the second event reads again, the third reuses it.
    expect(lookupAppVersionPostgresMock).toHaveBeenCalledTimes(2)
    expect(createStatsVersionMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a missing bundle for the rest of the batch', async () => {
    lookupAppVersionPostgresMock.mockResolvedValueOnce({ value: null, failed: false })
    const response = await postStats([statsEvent(), statsEvent(), statsEvent()])

    expect(response.status).toBe(200)
    expect(lookupAppVersionPostgresMock).toHaveBeenCalledTimes(1)
    expect(createStatsVersionMock).not.toHaveBeenCalled()
  })

  it('retries a rejected owner read on the next event', async () => {
    getAppOwnerPostgresMock.mockRejectedValueOnce(new Error('connection lost'))
    const response = await postStats([statsEvent(), statsEvent()])
    const body = await response.json() as { results: Array<{ status: string }> }

    expect(response.status).toBe(200)
    expect(body.results.map(result => result.status)).toEqual(['error', 'ok'])
    expect(getAppOwnerPostgresMock).toHaveBeenCalledTimes(2)
  })

  it('refuses a batch over the cap before any database read', async () => {
    const { MAX_STATS_BATCH_SIZE } = await import('../supabase/functions/_backend/plugin_runtime/plugins/stats.ts')
    const response = await postStats(Array.from({ length: MAX_STATS_BATCH_SIZE + 1 }, () => statsEvent()))
    const body = await response.json() as { error: string }

    expect(response.status).toBe(413)
    expect(body.error).toBe('stats_batch_too_large')
    expect(getPgClientMock).not.toHaveBeenCalled()
    expect(getAppOwnerPostgresMock).not.toHaveBeenCalled()
  })

  it('accepts a batch at the cap', async () => {
    const { MAX_STATS_BATCH_SIZE } = await import('../supabase/functions/_backend/plugin_runtime/plugins/stats.ts')
    const response = await postStats(Array.from({ length: MAX_STATS_BATCH_SIZE }, () => statsEvent({ action: 'app_moved_to_foreground' })))

    expect(response.status).toBe(200)
    expect(getAppOwnerPostgresMock).toHaveBeenCalledTimes(1)
  })
})
