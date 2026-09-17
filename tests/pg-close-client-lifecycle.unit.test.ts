import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cloudlogErrMock } = vi.hoisted(() => ({ cloudlogErrMock: vi.fn() }))

// backgroundTask defers pool.end() to waitUntil on workerd. Pass it through here
// so the test can await the end() promise directly.
vi.mock('../supabase/functions/_backend/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>()
  return {
    ...actual,
    backgroundTask: vi.fn((_c: any, p: any) => p),
  }
})

vi.mock('../supabase/functions/_backend/utils/logging.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/logging.ts')>()
  return {
    ...actual,
    cloudlogErr: cloudlogErrMock,
  }
})

function createContext() {
  return {
    get: (key: string) => (key === 'requestId' ? 'req-1' : undefined),
  } as any
}

describe('main pg.ts closeClient lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    cloudlogErrMock.mockClear()
  })

  it('ends the request-scoped pool (no longer a workerd no-op)', async () => {
    const { closeClient } = await import('../supabase/functions/_backend/utils/pg.ts')
    const end = vi.fn(async () => undefined)

    await closeClient(createContext(), { end } as any)

    expect(end).toHaveBeenCalledTimes(1)
  })

  it('logs and swallows end() failures without throwing', async () => {
    const { closeClient } = await import('../supabase/functions/_backend/utils/pg.ts')
    const end = vi.fn(async () => {
      throw new Error('end unsupported')
    })

    await expect(closeClient(createContext(), { end } as any)).resolves.toBeUndefined()
    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'PG client end failed' }))
  })
})
