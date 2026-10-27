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
  // Not-queryable Hyperdrive errors are not shared-transient; exhausted retries still
  // surface as drizzle_error (500 + PostHog) via on_error, same as main.
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

  it('retries once when hyperdrive times out creating a server connection', async () => {
    const { withReadOnlyPgTransientRetry } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext()
    let sessions = 0

    const result = await withReadOnlyPgTransientRetry(c, 'test', async () => {
      sessions++
      return {
        pgClient: {} as PluginPgClient,
        drizzle: {} as any,
        cleanup: vi.fn(async () => undefined),
      }
    }, async () => {
      if (sessions === 1) {
        throw Object.assign(new Error('Failed query: SELECT 1'), {
          name: 'DrizzleQueryError',
          cause: new Error('Timed out while creating a new server connection.'),
        })
      }
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(sessions).toBe(2)
  })

  it('rethrows after exactly two attempts when both fail with connection errors', async () => {
    const { withReadOnlyPgTransientRetry } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext()
    let sessions = 0
    let runCalls = 0
    const connectionError = Object.assign(new Error('Failed query: SELECT 1'), {
      name: 'DrizzleQueryError',
      cause: new Error('Client has encountered a connection error and is not queryable'),
    })

    await expect(withReadOnlyPgTransientRetry(c, 'test', async () => {
      sessions++
      return {
        pgClient: {} as PluginPgClient,
        drizzle: {} as any,
        cleanup: vi.fn(async () => undefined),
      }
    }, async () => {
      runCalls++
      throw connectionError
    })).rejects.toBe(connectionError)

    expect(sessions).toBe(2)
    expect(runCalls).toBe(2)
    expect(cloudlogMock).toHaveBeenCalledTimes(1)
  })

  it('retries when session creation fails with a connection error', async () => {
    const { withReadOnlyPgTransientRetry } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext()
    let createCalls = 0
    const connectionError = Object.assign(new Error('Failed query: SELECT 1'), {
      name: 'DrizzleQueryError',
      cause: new Error('Client has encountered a connection error and is not queryable'),
    })

    const result = await withReadOnlyPgTransientRetry(c, 'test', async () => {
      createCalls++
      if (createCalls === 1)
        throw connectionError
      return {
        pgClient: {} as PluginPgClient,
        drizzle: {} as any,
        cleanup: vi.fn(async () => undefined),
      }
    }, async () => 'ok')

    expect(result).toBe('ok')
    expect(createCalls).toBe(2)
    expect(cloudlogMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry capacity or DNS or socket timeout errors', async () => {
    const { withReadOnlyPgTransientRetry } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const { isReadOnlyPgConnectionRetryError: isConnectionRetry } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg_errors.ts')
    const cases = [
      Object.assign(new Error('too many clients already'), { name: 'DrizzleQueryError', code: '53300' }),
      Object.assign(new Error('getaddrinfo ENOTFOUND db.example.com'), { name: 'DrizzleQueryError', code: 'ENOTFOUND' }),
      Object.assign(new Error('connect ETIMEDOUT'), { name: 'DrizzleQueryError', code: 'ETIMEDOUT' }),
    ]
    for (const error of cases) {
      expect(isConnectionRetry(error)).toBe(false)
    }

    const c = createContext()
    for (const error of cases) {
      let sessions = 0
      await expect(withReadOnlyPgTransientRetry(c, 'test', async () => {
        sessions++
        return {
          pgClient: {} as PluginPgClient,
          drizzle: {} as any,
          cleanup: vi.fn(async () => undefined),
        }
      }, async () => {
        throw error
      })).rejects.toBe(error)
      expect(sessions).toBe(1)
    }
    expect(cloudlogMock).not.toHaveBeenCalled()
  })

  it('does not retry statement timeout errors', async () => {
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
        cause: Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014',
        }),
      })
    })).rejects.toMatchObject({ name: 'DrizzleQueryError' })

    expect(sessions).toBe(1)
    expect(cloudlogMock).not.toHaveBeenCalled()
  })

  it('still retries when cleanup fails after a connection error on the first attempt', async () => {
    const { withReadOnlyPgTransientRetry } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext()
    let sessions = 0
    let runCalls = 0
    const connectionError = Object.assign(new Error('Failed query: SELECT 1'), {
      name: 'DrizzleQueryError',
      cause: new Error('Client has encountered a connection error and is not queryable'),
    })

    const result = await withReadOnlyPgTransientRetry(c, 'test', async () => {
      sessions++
      return {
        pgClient: {} as PluginPgClient,
        drizzle: {} as any,
        cleanup: vi.fn(async () => {
          if (sessions === 1)
            throw new Error('cleanup failed')
        }),
      }
    }, async () => {
      runCalls++
      if (runCalls === 1)
        throw connectionError
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(sessions).toBe(2)
    expect(runCalls).toBe(2)
  })

  it('rethrows the query error when cleanup fails on the final attempt', async () => {
    const { withReadOnlyPgTransientRetry } = await import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')
    const c = createContext()
    const connectionError = Object.assign(new Error('Failed query: SELECT 1'), {
      name: 'DrizzleQueryError',
      cause: new Error('Client has encountered a connection error and is not queryable'),
    })

    await expect(withReadOnlyPgTransientRetry(c, 'test', async () => ({
      pgClient: {} as PluginPgClient,
      drizzle: {} as any,
      cleanup: vi.fn(async () => {
        throw new Error('cleanup failed')
      }),
    }), async () => {
      throw connectionError
    })).rejects.toBe(connectionError)
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
