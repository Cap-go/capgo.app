import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logPgError, serializePostgresError } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'

const { cloudlogErrMock } = vi.hoisted(() => ({
  cloudlogErrMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: cloudlogErrMock,
}))

function createContext() {
  return {
    get: (key: string) => {
      if (key === 'requestId')
        return 'a2331304eca21a55'
      if (key === 'databaseSource')
        return 'HYPERDRIVE_CAPGO_READ_EU'
      return undefined
    },
    req: {
      method: 'POST',
      path: '/stats',
      header: (name: string) => {
        if (name === 'cf-ray')
          return 'a2331304eca21a55-FRA'
        if (name === 'user-agent')
          return 'CapacitorUpdater/8.43.2'
        return undefined
      },
      raw: {
        cf: {
          colo: 'FRA',
          continent: 'EU',
          country: 'BE',
        },
      },
    },
    res: {
      headers: new Headers([
        ['X-Database-Source', 'HYPERDRIVE_CAPGO_READ_EU'],
        ['X-Worker-Source', 'capgo_plugin-eu-prod'],
      ]),
    },
  } as any
}

describe('plugin PostgreSQL error logging', () => {
  beforeEach(() => {
    cloudlogErrMock.mockReset()
  })

  it('serializes nested Drizzle and PostgreSQL diagnostics', () => {
    const postgresError = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      severity: 'FATAL',
      detail: 'The database system is shutting down.',
      hint: 'Retry the connection.',
      position: '42',
      internalPosition: '7',
      internalQuery: 'SELECT 1',
      where: 'parallel worker',
      schema: 'public',
      table: 'apps',
      column: 'owner_org',
      dataType: 'uuid',
      constraint: 'apps_owner_org_fkey',
      file: 'postgres.c',
      line: '3211',
      routine: 'ProcessInterrupts',
    })
    const drizzleError = Object.assign(new Error('Failed query: select ...'), {
      name: 'DrizzleQueryError',
      query: 'select "apps"."owner_org" from "apps" where "apps"."app_id" = $1',
      params: ['co.spencer.app'],
      cause: postgresError,
    })

    expect(serializePostgresError(drizzleError)).toMatchObject({
      type: 'Error',
      name: 'DrizzleQueryError',
      message: 'Failed query: select ...',
      query: expect.stringContaining('owner_org'),
      parameterCount: 1,
      cause: {
        type: 'Error',
        name: 'Error',
        message: 'terminating connection due to administrator command',
        code: '57P01',
        severity: 'FATAL',
        detail: 'The database system is shutting down.',
        hint: 'Retry the connection.',
        position: '42',
        internalPosition: '7',
        internalQuery: 'SELECT 1',
        where: 'parallel worker',
        schema: 'public',
        table: 'apps',
        column: 'owner_org',
        dataType: 'uuid',
        constraint: 'apps_owner_org_fkey',
        file: 'postgres.c',
        line: '3211',
        routine: 'ProcessInterrupts',
      },
    })
  })

  it('serializes network failures and aggregate connection errors', () => {
    const firstAddress = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), {
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
      address: '10.0.0.1',
      port: 5432,
    })
    const secondAddress = Object.assign(new Error('connect ETIMEDOUT 10.0.0.2:5432'), {
      code: 'ETIMEDOUT',
      errno: -60,
      syscall: 'connect',
      address: '10.0.0.2',
      port: 5432,
    })
    const aggregateError = new AggregateError([firstAddress, secondAddress], 'All connection attempts failed')

    expect(serializePostgresError(aggregateError)).toMatchObject({
      type: 'AggregateError',
      message: 'All connection attempts failed',
      errors: [
        {
          code: 'ECONNREFUSED',
          errno: -61,
          syscall: 'connect',
          address: '10.0.0.1',
          port: 5432,
        },
        {
          code: 'ETIMEDOUT',
          errno: -60,
          syscall: 'connect',
          address: '10.0.0.2',
          port: 5432,
        },
      ],
    })
  })

  it('serializes a shared aggregate error independently in each branch', () => {
    const sharedError = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
    })
    const aggregateError = new AggregateError([sharedError, sharedError], 'All connection attempts failed')

    expect(serializePostgresError(aggregateError)).toMatchObject({
      errors: [
        { message: 'connection reset', code: 'ECONNRESET' },
        { message: 'connection reset', code: 'ECONNRESET' },
      ],
    })
  })

  it('bounds large aggregate connection errors and records omitted entries', () => {
    const aggregateError = new AggregateError(
      Array.from({ length: 55 }, (_, index) => new Error(`connection-${index}`)),
      'All connection attempts failed',
    )
    const serialized = serializePostgresError(aggregateError)
    const errors = serialized.errors as Record<string, unknown>[]

    expect(errors).toHaveLength(51)
    expect(errors[0]).toMatchObject({ message: 'connection-0' })
    expect(errors[49]).toMatchObject({ message: 'connection-49' })
    expect(errors[50]).toEqual({ type: 'truncated', omitted: 5 })
  })

  it('keeps primitive throws and hostile properties safe to log', () => {
    expect(serializePostgresError(null)).toEqual({ type: 'null', value: null })
    expect(serializePostgresError('connection reset')).toEqual({ type: 'string', value: 'connection reset' })
    expect(serializePostgresError(42n)).toEqual({ type: 'bigint', value: '42' })

    const hostileError = new Error('hostile property')
    Object.defineProperty(hostileError, 'code', {
      get() {
        throw new Error('getter exploded')
      },
    })

    expect(serializePostgresError(hostileError)).toMatchObject({
      message: 'hostile property',
      code: '[unreadable property: getter exploded]',
    })
  })

  it('bounds cyclic structured PostgreSQL fields and remains JSON serializable', () => {
    const query: Record<string, unknown> = {
      text: 'SELECT $1',
      values: ['must-not-appear-in-logs'],
    }
    query.self = query
    const postgresError = Object.assign(new Error('query failed'), { query })
    const serialized = serializePostgresError(postgresError)

    expect(serialized).toMatchObject({
      query: {
        text: 'SELECT $1',
        self: '[circular]',
        values: '[redacted]',
      },
    })
    expect(() => JSON.stringify(serialized)).not.toThrow()
    expect(JSON.stringify(serialized)).not.toContain('must-not-appear-in-logs')
  })

  it('blocks prototype-pollution keys without changing object prototypes', () => {
    const maliciousQuery = JSON.parse(`{
      "__proto__": { "polluted": true },
      "constructor": { "prototype": { "polluted": true } },
      "prototype": { "polluted": true },
      "text": "SELECT 1"
    }`)
    const serialized = serializePostgresError(Object.assign(new Error('query failed'), {
      query: maliciousQuery,
    }))
    const query = serialized.query as Record<string, unknown>

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(query)).toBeNull()
    expect(query).toMatchObject({
      text: 'SELECT 1',
      __blockedKeys: ['__proto__', 'constructor', 'prototype'],
    })
    expect(Object.prototype.hasOwnProperty.call(query, '__proto__')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(query, 'constructor')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(query, 'prototype')).toBe(false)
  })

  it('does not invoke accessors while serializing structured fields', () => {
    let getterCalled = false
    const query = { text: 'SELECT 1' } as Record<string, unknown>
    Object.defineProperty(query, 'hostile', {
      enumerable: true,
      get() {
        getterCalled = true
        return 'must-not-be-read'
      },
    })

    const serialized = serializePostgresError(Object.assign(new Error('query failed'), { query }))
    expect(getterCalled).toBe(false)
    expect(serialized).toMatchObject({
      query: { hostile: '[accessor property omitted]' },
    })
  })

  it('redacts Drizzle parameter lines from messages and stacks', () => {
    const error = new Error('Failed query: SELECT $1\nparams: super-secret-token')
    error.stack = 'Error: Failed query\nparams: super-secret-token\n    at query.ts:1:1'

    const serialized = serializePostgresError(error)
    expect(serialized.message).toBe('Failed query: SELECT $1\nparams: [redacted]')
    expect(serialized.stack).toBe('Error: Failed query\nparams: [redacted]\n    at query.ts:1:1')
    expect(JSON.stringify(serialized)).not.toContain('super-secret-token')
  })

  it('logs filterable Worker, replica, request, and app diagnostics', () => {
    const postgresError = Object.assign(new Error('server closed the connection unexpectedly'), {
      code: '57P01',
      severity: 'FATAL',
    })
    const drizzleError = Object.assign(new Error('Failed query'), {
      name: 'DrizzleQueryError',
      cause: postgresError,
    })

    logPgError(createContext(), 'getAppOwnerPostgres', drizzleError, {
      appId: 'co.spencer.app',
      functionName: 'caller-cannot-override',
      planActions: ['mau'],
      request: { method: 'DELETE' },
      version: 999,
    })

    expect(cloudlogErrMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'a2331304eca21a55',
      message: 'getAppOwnerPostgres - PostgreSQL Error',
      error: expect.objectContaining({
        name: 'DrizzleQueryError',
        cause: expect.objectContaining({
          code: '57P01',
          severity: 'FATAL',
        }),
      }),
      diagnostics: {
        appId: 'co.spencer.app',
        planActions: ['mau'],
        version: 1,
        functionName: 'getAppOwnerPostgres',
        databaseSource: 'HYPERDRIVE_CAPGO_READ_EU',
        workerSource: 'capgo_plugin-eu-prod',
        runtime: expect.any(String),
        request: {
          method: 'POST',
          path: '/stats',
          rayId: 'a2331304eca21a55-FRA',
          userAgent: 'CapacitorUpdater/8.43.2',
          colo: 'FRA',
          continent: 'EU',
          country: 'BE',
        },
      },
    }))
  })

  it('blocks prototype-pollution keys in caller diagnostics', () => {
    const maliciousDiagnostics = JSON.parse(`{
      "__proto__": { "polluted": true },
      "constructor": { "prototype": { "polluted": true } },
      "prototype": { "polluted": true },
      "appId": "co.safe.app"
    }`)

    logPgError(createContext(), 'getAppOwnerPostgres', new Error('failed'), maliciousDiagnostics)

    const payload = cloudlogErrMock.mock.calls[0][0]
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(payload.diagnostics)).toBe(Object.prototype)
    expect(payload.diagnostics).toMatchObject({
      appId: 'co.safe.app',
      __blockedKeys: ['__proto__', 'constructor', 'prototype'],
      version: 1,
      functionName: 'getAppOwnerPostgres',
    })
    expect(Object.prototype.hasOwnProperty.call(payload.diagnostics, '__proto__')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(payload.diagnostics, 'constructor')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(payload.diagnostics, 'prototype')).toBe(false)
  })

  it('bounds circular and excessively deep cause chains', () => {
    const circularError = new Error('circular')
    circularError.cause = circularError

    expect(serializePostgresError(circularError)).toMatchObject({
      message: 'circular',
      cause: { circular: true },
    })

    let deepError: Error = new Error('root')
    for (let index = 0; index < 10; index++)
      deepError = new Error(`level-${index}`, { cause: deepError })

    let current: Record<string, unknown> = serializePostgresError(deepError)
    for (let index = 0; index < 8; index++)
      current = current.cause as Record<string, unknown>
    expect(current).toMatchObject({ truncated: true })
  })
})
