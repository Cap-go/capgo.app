import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Repro of capgo-repro-20260805T180852Z / CAPGO-BUG-REPORT:
 * POST /stats with custom_id="" stays cloud-OK.
 * POST /stats with any non-empty custom_id hit primary; when that owner lookup
 * fails (null), Capgo sticky-caches the app as onprem and returns on_premise_app.
 *
 * Prod failure mode modeled here: replica finds the app, primary returns null.
 */

const PRIMARY_CLIENT = { kind: 'primary' }
const REPLICA_CLIENT = { kind: 'replica' }

const getPgClientMock = vi.fn(async (_c: unknown, readOnly = false) => (
  readOnly ? REPLICA_CLIENT : PRIMARY_CLIENT
))
const getDrizzleClientMock = vi.fn((client: { kind: string }) => client)
const getAppOwnerPostgresMock = vi.fn(async (_c: unknown, _appId: string, drizzleClient: { kind: string }) => {
  // Replica healthy; primary owner lookup fails closed as null (the misclassify).
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
const getAppVersionPostgresMock = vi.fn(async () => ({ id: 1, owner_org: 'org-1' }))
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
  getAppVersionPostgres: getAppVersionPostgresMock,
  getDrizzleClient: getDrizzleClientMock,
  getEffectiveDeviceChannelNamePostgres: getEffectiveDeviceChannelNamePostgresMock,
  getPgClient: getPgClientMock,
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

function statsEvent(customId: string) {
  return {
    platform: 'android',
    device_id: 'ac4135b3-fda6-449e-b0fe-88680ab67105',
    app_id: 'com.sunder.sales',
    version_build: '5.5.2',
    version_name: '5.5.6',
    plugin_version: '8.51.0',
    version_os: '17',
    action: 'app_moved_to_foreground',
    custom_id: customId,
    is_emulator: false,
    is_prod: true,
  }
}

async function postStats(customId: string) {
  const { app } = await import('../supabase/functions/_backend/plugin_runtime/plugins/stats.ts')
  return app.fetch(new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([statsEvent(customId)]),
  }), {}, { waitUntil: () => {} } as any)
}

describe('stats custom_id primary onprem misclassify repro', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPgClientMock.mockImplementation(async (_c: unknown, readOnly = false) => (
      readOnly ? REPLICA_CLIENT : PRIMARY_CLIENT
    ))
    getAppOwnerPostgresMock.mockImplementation(async (_c: unknown, _appId: string, drizzleClient: { kind: string }) => {
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
    getAppStatusMock.mockResolvedValue({
      status: null,
      allow_device_custom_id: true,
      block_provider_infra_requests: false,
      cacheHit: false,
    })
  })

  it('keeps cloud app healthy for empty custom_id (control, matches customer phase 2)', async () => {
    const response = await postStats('')
    const body = await response.json() as { status: string, results: Array<{ status: string, error?: string }> }

    expect(response.status).toBe(200)
    expect(body).toEqual({ status: 'ok', results: [{ status: 'ok', index: 0 }] })
    expect(getPgClientMock).toHaveBeenCalledWith(expect.anything(), true)
    expect(setAppStatusMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'com.sunder.sales',
      'onprem',
      expect.anything(),
      expect.anything(),
    )
  })

  it('must not classify cloud app as onprem when custom_id is set (customer phase 3+4)', async () => {
    // Same bytes as phase 2 except custom_id. Replica still has the app.
    // Bug: custom_id forces primary; primary owner null => sticky onprem.
    const response = await postStats('qa-probe-1')
    const body = await response.json() as { status: string, results: Array<{ status: string, error?: string }> }

    expect(response.status).toBe(200)
    expect(body.results?.[0]?.status).toBe('ok')
    expect(body.results?.[0]?.error).not.toBe('on_premise_app')
    expect(getPgClientMock.mock.calls.every(call => call[1] === true)).toBe(true)
    expect(setAppStatusMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'com.sunder.sales',
      'onprem',
      expect.anything(),
      expect.anything(),
    )
  })
})
