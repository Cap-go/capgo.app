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
      planActions: ['mau'],
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
        appId: 'co.spencer.app',
        planActions: ['mau'],
      },
    }))
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
