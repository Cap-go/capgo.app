import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { countDevicesCF, countInstallSourcesCF, readBandwidthUsageCF } from '../supabase/functions/_backend/utils/cloudflare.ts'
import { countInstallSources, readStatsBandwidth } from '../supabase/functions/_backend/utils/stats.ts'
import { countDevicesSB, countInstallSourcesSB, readBandwidthUsageSB } from '../supabase/functions/_backend/utils/supabase.ts'

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: vi.fn((c: Context) => (c as Context & { env?: Record<string, string> }).env ?? {}),
    getRuntimeKey: vi.fn(),
  }
})

vi.mock('../supabase/functions/_backend/utils/cloudflare.ts', () => ({
  countDevicesCF: vi.fn(),
  countInstallSourcesCF: vi.fn(),
  readBandwidthUsageCF: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  countDevicesSB: vi.fn(),
  countInstallSourcesSB: vi.fn(),
  readBandwidthUsageSB: vi.fn(),
}))

function createContextMock(env: Record<string, unknown>) {
  return {
    env,
    get: vi.fn((key: string) => key === 'requestId' ? 'test-request' : undefined),
  } as unknown as Context
}

describe('countInstallSources routing', () => {
  beforeEach(() => {
    vi.mocked(getRuntimeKey).mockReset()
    vi.mocked(countDevicesCF).mockReset()
    vi.mocked(countDevicesSB).mockReset()
    vi.mocked(countInstallSourcesCF).mockReset()
    vi.mocked(countInstallSourcesSB).mockReset()
    vi.mocked(readBandwidthUsageCF).mockReset()
    vi.mocked(readBandwidthUsageSB).mockReset()
  })

  it('fails install-source counts when Worker writes use Analytics Engine but read config is missing', () => {
    vi.mocked(getRuntimeKey).mockReturnValue('workerd')

    expect(() => countInstallSources(
      createContextMock({ DEVICE_INFO: {} }),
      'com.example.app',
    )).toThrow('Cannot count install sources without Analytics Engine read configuration')

    expect(countInstallSourcesCF).not.toHaveBeenCalled()
    expect(countInstallSourcesSB).not.toHaveBeenCalled()
  })

  it('uses Analytics Engine for install-source counts when read config is available', async () => {
    vi.mocked(getRuntimeKey).mockReturnValue('workerd')
    vi.mocked(countInstallSourcesCF).mockReturnValue(Promise.resolve({ app_store: 4 }))

    await expect(countInstallSources(
      createContextMock({
        DEVICE_INFO: {},
        CF_ANALYTICS_TOKEN: 'token',
        CF_ACCOUNT_ANALYTICS_ID: 'account',
      }),
      'com.example.app',
    )).resolves.toEqual({ app_store: 4 })

    expect(countInstallSourcesCF).toHaveBeenCalledTimes(1)
    expect(countInstallSourcesSB).not.toHaveBeenCalled()
    expect(countDevicesCF).not.toHaveBeenCalled()
    expect(countDevicesSB).not.toHaveBeenCalled()
  })
})

describe('readStatsBandwidth routing', () => {
  beforeEach(() => {
    vi.mocked(readBandwidthUsageCF).mockReset()
    vi.mocked(readBandwidthUsageSB).mockReset()
  })

  it('fails when Worker bandwidth writes use Analytics Engine but read config is missing', () => {
    expect(() => readStatsBandwidth(
      createContextMock({ BANDWIDTH_USAGE: {} }),
      'com.example.app',
      '2026-06-01',
      '2026-07-01',
    )).toThrow('Cannot read bandwidth usage without Analytics Engine read configuration')

    expect(readBandwidthUsageCF).not.toHaveBeenCalled()
    expect(readBandwidthUsageSB).not.toHaveBeenCalled()
  })

  it('uses Analytics Engine for bandwidth reads when read config is available', async () => {
    vi.mocked(readBandwidthUsageCF).mockResolvedValue([{ date: '2026-06-20', bandwidth: 4096, app_id: 'com.example.app' }])

    await expect(readStatsBandwidth(
      createContextMock({
        BANDWIDTH_USAGE: {},
        CF_ANALYTICS_TOKEN: 'token',
        CF_ACCOUNT_ANALYTICS_ID: 'account',
      }),
      'com.example.app',
      '2026-06-01',
      '2026-07-01',
    )).resolves.toEqual([{ date: '2026-06-20', bandwidth: 4096, app_id: 'com.example.app' }])

    expect(readBandwidthUsageCF).toHaveBeenCalledWith(
      expect.anything(),
      'com.example.app',
      '2026-06-01',
      '2026-07-01',
      { throwOnError: true },
    )
    expect(readBandwidthUsageSB).not.toHaveBeenCalled()
  })
})
