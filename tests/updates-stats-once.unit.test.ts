import { beforeEach, describe, expect, it, vi } from 'vitest'

const createStatsMauMock = vi.fn(() => Promise.resolve())
const createStatsVersionMock = vi.fn(() => Promise.resolve())
const sendStatsAndDeviceMock = vi.fn(() => Promise.resolve())
const backgroundTaskMock = vi.fn((_c: unknown, task: Promise<unknown>) => task)

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts', () => ({
  createStatsMau: createStatsMauMock,
  createStatsVersion: createStatsVersionMock,
  sendStatsAndDevice: sendStatsAndDeviceMock,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/utils.ts', () => ({
  backgroundTask: backgroundTaskMock,
}))

const { recordUpdatesMauOnce, recordUpdatesVersionGetStatsOnce } = await import('../supabase/functions/_backend/plugin_runtime/utils/update.ts')

// Each call gets a fresh raw request: the "once" bookkeeping is keyed by c.req.raw.
function createContext() {
  return { req: { raw: {} } } as any
}

const device = { device_id: 'device-1' } as any
const channel = { id: 42, name: 'production' }

beforeEach(() => {
  vi.clearAllMocks()
  createStatsMauMock.mockResolvedValue(undefined)
  createStatsVersionMock.mockResolvedValue(undefined)
  sendStatsAndDeviceMock.mockResolvedValue(undefined)
})

describe('recordUpdatesMauOnce', () => {
  it('records MAU at most once per raw request', async () => {
    const c = createContext()

    await recordUpdatesMauOnce(c, 'device-1', 'com.test.app', 'org-1', 'ios', '1.0.0')
    await recordUpdatesMauOnce(c, 'device-1', 'com.test.app', 'org-1', 'ios', '1.0.0')

    expect(createStatsMauMock).toHaveBeenCalledTimes(1)
    expect(backgroundTaskMock).toHaveBeenCalledTimes(1)
  })

  it('propagates MAU write failures and retries on the next call', async () => {
    const mauError = new Error('mau write failed')
    createStatsMauMock.mockReturnValueOnce(Promise.reject(mauError))
    const c = createContext()

    await expect(recordUpdatesMauOnce(c, 'device-1', 'com.test.app', 'org-1', 'ios', '1.0.0'))
      .rejects
      .toBe(mauError)
    await recordUpdatesMauOnce(c, 'device-1', 'com.test.app', 'org-1', 'ios', '1.0.0')
    expect(createStatsMauMock).toHaveBeenCalledTimes(2)
  })
})

describe('recordUpdatesVersionGetStatsOnce', () => {
  it.each([
    { failing: 'sendStatsAndDevice', versionCalls: 1, deviceCalls: 2 },
    { failing: 'createStatsVersion', versionCalls: 2, deviceCalls: 1 },
  ])('retries only $failing when it failed first', async ({ failing, versionCalls, deviceCalls }) => {
    const failingMock = failing === 'createStatsVersion' ? createStatsVersionMock : sendStatsAndDeviceMock
    failingMock.mockRejectedValueOnce(new Error(`${failing} failed`))
    const c = createContext()

    await expect(recordUpdatesVersionGetStatsOnce(c, device, '1.2.3', 'com.test.app', channel))
      .rejects
      .toThrow(`${failing} failed`)
    await recordUpdatesVersionGetStatsOnce(c, device, '1.2.3', 'com.test.app', channel)

    expect(createStatsVersionMock).toHaveBeenCalledTimes(versionCalls)
    expect(sendStatsAndDeviceMock).toHaveBeenCalledTimes(deviceCalls)
  })

  it('records version get stats at most once per raw request', async () => {
    const c = createContext()

    await recordUpdatesVersionGetStatsOnce(c, device, '1.2.3', 'com.test.app', channel)
    await recordUpdatesVersionGetStatsOnce(c, device, '1.2.3', 'com.test.app', channel)

    expect(createStatsVersionMock).toHaveBeenCalledTimes(1)
    expect(sendStatsAndDeviceMock).toHaveBeenCalledTimes(1)
  })
})
