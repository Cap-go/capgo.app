import type { Context } from 'hono'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getPgClient, logPgError } from '../supabase/functions/_backend/utils/pg.ts'

const { cloudlogErrMock, poolOnMock, PoolMock } = vi.hoisted(() => {
  const poolOnMock = vi.fn()
  return {
    cloudlogErrMock: vi.fn(),
    poolOnMock,
    PoolMock: vi.fn(function PoolMock(this: { on: typeof poolOnMock }) {
      this.on = poolOnMock
    }),
  }
})

vi.mock('pg', async (importOriginal) => ({
  ...await importOriginal<typeof import('pg')>(),
  Pool: PoolMock,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/logging.ts')>(),
  cloudlog: vi.fn(),
  cloudlogErr: cloudlogErrMock,
}))

vi.mock('../supabase/functions/_backend/utils/geolocation.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/geolocation.ts')>(),
  getClientDbRegionSB: () => 'EU',
}))

function createContext() {
  const variables = new Map<string, unknown>([
    ['requestId', 'test-request'],
    ['databaseSource', 'HYPERDRIVE_CAPGO_DIRECT_EU'],
  ])
  return {
    env: {
      HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://test-db' },
    },
    get: (key: string) => variables.get(key),
    set: (key: string, value: unknown) => variables.set(key, value),
    header: vi.fn(),
    res: new Response(null, { headers: { 'X-Worker-Source': 'test-api-worker' } }),
  } as unknown as Context
}

describe('API/trigger PostgreSQL error logging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retains the original driver cause from a real Drizzle query error', () => {
    const driverError = new Error('connection terminated unexpectedly')
    Object.defineProperties(driverError, {
      code: { value: '58000' },
      severity: { value: 'FATAL' },
      retryable: { value: true },
    })
    const error = new DrizzleQueryError(
      'select "management_email" from "orgs" where "id" = $1',
      ['test-org-id'],
      driverError,
    )

    logPgError(createContext(), 'getOrgInfo', error)

    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'test-request',
      message: 'getOrgInfo - PostgreSQL Error',
      databaseSource: 'HYPERDRIVE_CAPGO_DIRECT_EU',
      error: expect.objectContaining({
        name: 'DrizzleQueryError',
        parameterCount: 1,
        cause: expect.objectContaining({
          message: 'connection terminated unexpectedly',
          stack: expect.any(String),
          code: '58000',
          severity: 'FATAL',
          retryable: true,
        }),
      }),
    }))
    expect(JSON.stringify(cloudlogErrMock.mock.calls)).not.toContain('test-org-id')
  })

  it('redacts parameters from the wrapper message, stack, and structured query', () => {
    const error = new DrizzleQueryError('SELECT $1', ['test-secret'], new Error('query failed'))
    Object.assign(error, { query: { text: 'SELECT $1', values: ['test-secret'] } })

    logPgError(createContext(), 'getOrgInfo', error)

    const payload = cloudlogErrMock.mock.calls[0][0]
    expect(payload.error.message).toContain('params: [redacted]')
    expect(payload.error.query).toMatchObject({ text: 'SELECT $1', values: '[redacted]' })
    expect(JSON.stringify(payload)).not.toContain('test-secret')
  })

  it('serializes pool errors explicitly without copying the client or credentials', async () => {
    await getPgClient(createContext())
    const listener = poolOnMock.mock.calls.find(([event]) => event === 'error')?.[1]
    expect(listener).toBeTypeOf('function')
    const error = Object.assign(new Error('failed to acquire a connection'), {
      code: '58000',
      retryable: true,
      client: { connectionParameters: { password: 'test-db-password' } },
    })

    listener(error)

    const payload = cloudlogErrMock.mock.calls[0][0]
    expect(payload).toMatchObject({
      requestId: 'test-request',
      message: 'PG Pool Error',
      databaseSource: 'HYPERDRIVE_CAPGO_DIRECT_EU',
      error: { message: 'failed to acquire a connection', code: '58000', retryable: true },
    })
    expect(payload.error.stack).toBeTypeOf('string')
    expect(payload.error).not.toHaveProperty('client')
    expect(JSON.stringify(payload)).not.toContain('test-db-password')
  })

  it('redacts multiline parameters while retaining the underlying cause and stack frames', () => {
    const error = new DrizzleQueryError('SELECT $1', ['first-secret\nsecond-secret'], new Error('connection reset'))
    Object.defineProperty(error, 'stack', {
      value: `DrizzleQueryError: ${error.message}\n    at query.ts:1:1`,
    })

    logPgError(createContext(), 'getOrgInfo', error)

    const payload = cloudlogErrMock.mock.calls[0][0]
    expect(payload.error.message).toBe('Failed query: SELECT $1\nparams: [redacted]')
    expect(payload.error.stack).toContain('at ')
    expect(payload.error.cause.message).toBe('connection reset')
    expect(JSON.stringify(payload)).not.toContain('first-secret')
    expect(JSON.stringify(payload)).not.toContain('second-secret')
  })

  it.each([null, undefined, 'connection reset', 42n])('does not throw when logging a non-Error: %s', (error) => {
    expect(() => logPgError(createContext(), 'getOrgInfo', error)).not.toThrow()
    expect(() => JSON.stringify(cloudlogErrMock.mock.calls)).not.toThrow()
  })
})
