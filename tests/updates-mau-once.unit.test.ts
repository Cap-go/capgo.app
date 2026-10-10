import { describe, expect, it, vi } from 'vitest'

const createStatsMauMock = vi.fn(() => Promise.resolve())
const backgroundTaskMock = vi.fn((_c: unknown, task: Promise<unknown>) => task)

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts', () => ({
  createStatsMau: createStatsMauMock,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/utils.ts', () => ({
  backgroundTask: backgroundTaskMock,
}))

function createContext() {
  const raw = { id: 'raw-req-1' }
  return {
    req: { raw },
  } as any
}

describe('recordUpdatesMauOnce', () => {
  it('records MAU at most once per raw request', async () => {
    const { recordUpdatesMauOnce } = await import('../supabase/functions/_backend/plugin_runtime/utils/update.ts')
    createStatsMauMock.mockClear()
    backgroundTaskMock.mockClear()
    const c = createContext()

    await recordUpdatesMauOnce(c, 'device-1', 'com.test.app', 'org-1', 'ios', '1.0.0')
    await recordUpdatesMauOnce(c, 'device-1', 'com.test.app', 'org-1', 'ios', '1.0.0')

    expect(createStatsMauMock).toHaveBeenCalledTimes(1)
    expect(backgroundTaskMock).toHaveBeenCalledTimes(1)
  })

  it('propagates MAU write failures', async () => {
    const { recordUpdatesMauOnce } = await import('../supabase/functions/_backend/plugin_runtime/utils/update.ts')
    createStatsMauMock.mockClear()
    backgroundTaskMock.mockClear()
    const mauError = new Error('mau write failed')
    createStatsMauMock.mockReturnValue(Promise.reject(mauError))
    const c = createContext()

    await expect(recordUpdatesMauOnce(c, 'device-1', 'com.test.app', 'org-1', 'ios', '1.0.0'))
      .rejects.toBe(mauError)

    createStatsMauMock.mockResolvedValue(undefined)
    await recordUpdatesMauOnce(c, 'device-1', 'com.test.app', 'org-1', 'ios', '1.0.0')
    expect(createStatsMauMock).toHaveBeenCalledTimes(2)
  })
})
