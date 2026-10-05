import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: vi.fn(error => error),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/utils.ts')>()
  return {
    ...actual,
    backgroundTask: vi.fn(() => Promise.resolve()),
  }
})

function createContext(env: Record<string, any>) {
  return {
    env,
    get: (key: string) => (key === 'requestId' ? 'request-id' : undefined),
    header: vi.fn(),
    json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status }),
    req: {
      raw: {
        cf: {},
        headers: new Headers(),
      },
      url: 'http://localhost/test',
    },
    res: {
      headers: new Headers(),
    },
  } as any
}

const device = {
  app_id: 'com.example.app',
  device_id: 'device-1',
  version_name: '1.0.0',
  platform: 'android',
  plugin_version: '8.0.0',
} as any

afterEach(() => {
  vi.restoreAllMocks()
})

describe('analytics engine write volume', () => {
  it.each(['download_10', 'download_50', 'download_90'])('drops %s progress from APP_LOG', async (action) => {
    const { createStatsLogs } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts')
    const writeDataPoint = vi.fn()
    await createStatsLogs(createContext({ APP_LOG: { writeDataPoint } }), 'com.example.app', 'device-1', action as any, '1.0.0')
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it.each(['download_0', 'download_complete', 'download_fail', 'get', 'set'])('keeps %s in APP_LOG', async (action) => {
    const { createStatsLogs } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts')
    const writeDataPoint = vi.fn()
    await createStatsLogs(createContext({ APP_LOG: { writeDataPoint } }), 'com.example.app', 'device-1', action as any, '1.0.0')
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
  })

  it('samples APP_LOG_EXTERNAL and stores the sample rate in double2', async () => {
    const { APP_LOG_EXTERNAL_SAMPLE_RATE, trackLogsCFExternal } = await import('../supabase/functions/_backend/plugin_runtime/utils/cloudflare.ts')
    const writeDataPoint = vi.fn()
    const c = createContext({ APP_LOG_EXTERNAL: { writeDataPoint } })

    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    await trackLogsCFExternal(c, 'com.example.app', 'device-1', 'get', '1.0.0')
    expect(writeDataPoint).not.toHaveBeenCalled()

    vi.spyOn(Math, 'random').mockReturnValue(0)
    await trackLogsCFExternal(c, 'com.example.app', 'device-1', 'get', '1.0.0')
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      doubles: [0, APP_LOG_EXTERNAL_SAMPLE_RATE],
      indexes: ['com.example.app'],
    }))
  })

  it('only logs real update checks from on-prem apps to APP_LOG_EXTERNAL', async () => {
    const { onPremStats } = await import('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts')
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const writeDataPoint = vi.fn()
    const c = createContext({ APP_LOG_EXTERNAL: { writeDataPoint } })

    await onPremStats(c, 'com.example.app', 'app_moved_to_foreground', device)
    expect(writeDataPoint).not.toHaveBeenCalled()

    await onPremStats(c, 'com.example.app', 'get', device)
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
    expect(writeDataPoint.mock.calls[0][0].blobs[1]).toBe('get')
  })

  it('scales the external update count by the stored sample rate', async () => {
    const { countUpdatesFromLogsExternalCF } = await import('../supabase/functions/_backend/utils/cloudflare.ts')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ meta: [{ name: 'count', type: 'Float64' }], data: [{ count: 1234.0 }] })))
    const c = createContext({ CF_ACCOUNT_ANALYTICS_ID: 'account', CF_ANALYTICS_TOKEN: 'token' })

    await expect(countUpdatesFromLogsExternalCF(c)).resolves.toBe(1234)
    const body = String(fetchMock.mock.calls[0][1]?.body)
    expect(body).toContain('SUM(_sample_interval * if(double2 > 0, double2, 1.0))')
  })
})
