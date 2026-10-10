import type { PluginPgClient } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cloudlogMock } = vi.hoisted(() => ({
  cloudlogMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: cloudlogMock,
  cloudlogErr: vi.fn(),
  serializeError: vi.fn(error => error),
}))

function createContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'req-1' : undefined,
    res: { headers: new Headers() },
  } as any
}

describe('withReadOnlyPgTransientRetry', () => {
  beforeEach(() => {
    cloudlogMock.mockReset()
  })

  it('retries once on a transient drizzle failure with a fresh session', async () => {
    const { withReadOnlyPgTransientRetry } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext()
    let sessions = 0
    let runCalls = 0
    const run = vi.fn(async () => {
      runCalls++
      if (runCalls === 1) {
        throw Object.assign(new Error('Failed query: SELECT 1'), {
          name: 'DrizzleQueryError',
          cause: new Error('Client has encountered a connection error and is not queryable'),
        })
      }
      return 'ok'
    })

    const result = await withReadOnlyPgTransientRetry(c, 'test', async () => {
      sessions++
      return {
        pgClient: { id: sessions } as unknown as PluginPgClient,
        drizzle: {} as any,
        cleanup: vi.fn(async () => undefined),
      }
    }, async (session) => {
      expect(session.pgClient).toEqual({ id: sessions })
      return run()
    })

    expect(result).toBe('ok')
    expect(sessions).toBe(2)
    expect(run).toHaveBeenCalledTimes(2)
    expect(cloudlogMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'read_only_pg_transient_retry',
      context: 'test',
    }))
  })

  it('does not retry non-transient drizzle failures', async () => {
    const { withReadOnlyPgTransientRetry } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext()
    let sessions = 0

    await expect(withReadOnlyPgTransientRetry(c, 'test', async () => {
      sessions++
      return {
        pgClient: {} as PluginPgClient,
        drizzle: {} as any,
        cleanup: vi.fn(async () => undefined),
      }
    }, async () => {
      throw Object.assign(new Error('Failed query: SELECT 1'), {
        name: 'DrizzleQueryError',
        cause: Object.assign(new Error('invalid input syntax for type uuid'), {
          code: '22P02',
        }),
      })
    })).rejects.toMatchObject({ name: 'DrizzleQueryError' })

    expect(sessions).toBe(1)
    expect(cloudlogMock).not.toHaveBeenCalled()
  })
})
