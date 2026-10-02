import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CapgoDrizzleQueryLogger } from '../supabase/functions/_backend/utils/drizzle_query_logger.ts'
import { getUserIdFromApikey } from '../supabase/functions/_backend/utils/pg_files.ts'
import { withAuthPgRetry } from '../supabase/functions/_backend/utils/pg_auth_retry.ts'
import { onError } from '../supabase/functions/_backend/utils/on_error.ts'

const {
  executeMock,
  getPgClientMock,
  getDrizzleClientMock,
  recordFailedAuthMock,
  cloudlogMock,
} = vi.hoisted(() => ({
  executeMock: vi.fn(),
  getPgClientMock: vi.fn(() => ({})),
  getDrizzleClientMock: vi.fn(() => ({ execute: vi.fn() })),
  recordFailedAuthMock: vi.fn(async () => undefined),
  cloudlogMock: vi.fn(),
}))

getDrizzleClientMock.mockImplementation(() => ({ execute: executeMock }))

vi.mock('../supabase/functions/_backend/utils/logging.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/logging.ts')>(),
  cloudlog: cloudlogMock,
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  closeClient: vi.fn(async () => undefined),
  getDrizzleClient: getDrizzleClientMock,
  getPgClient: getPgClientMock,
  logPgError: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  isAPIKeyRateLimited: vi.fn(async () => ({ limited: false })),
  isIPRateLimited: vi.fn(async () => ({ limited: false })),
  recordAPIKeyUsage: vi.fn(async () => undefined),
  recordFailedAuth: recordFailedAuthMock,
}))

const { middlewareKey } = await import('../supabase/functions/_backend/utils/hono_middleware.ts')

function makeContext() {
  return {
    get: (key: string) => (key === 'requestId' ? 'req-auth-db' : undefined),
    header: vi.fn(),
    res: new Response(null),
  } as any
}

describe('auth database unavailable hotfix', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redacts api key parameters in drizzle query logs', () => {
    const logger = new CapgoDrizzleQueryLogger()
    logger.logQuery('SELECT * FROM find_apikey_by_value($1)', ['super-secret-api-key'])
    expect(cloudlogMock).toHaveBeenCalledWith({
      message: 'Query: SELECT * FROM find_apikey_by_value($1) -- params: [redacted]',
    })
    expect(JSON.stringify(cloudlogMock.mock.calls)).not.toContain('super-secret-api-key')
  })

  it('retries once on transient Hyperdrive pool errors', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('Timed out while waiting for an open slot in the pool.'))
      .mockResolvedValueOnce('ok')

    await expect(withAuthPgRetry(operation)).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('getUserIdFromApikey returns db_error instead of null on Postgres failure', async () => {
    const drizzle = { execute: vi.fn().mockRejectedValue(new Error('Connection terminated unexpectedly')) }
    const result = await getUserIdFromApikey(makeContext(), 'capgo_test_key', drizzle as any)
    expect(result).toEqual({ kind: 'db_error', error: expect.any(Error) })
  })

  it('middlewareKey returns 503 database_unavailable on checkKeyPg failure without recording failed auth', async () => {
    executeMock.mockRejectedValue(new Error('Timed out while waiting for an open slot in the pool.'))

    const { Hono } = await import('hono/tiny')
    const app = new Hono()
    app.onError(onError('test-middleware'))
    app.get('/', middlewareKey({ usePostgres: true, readOnly: false }), c => c.json({ status: 'ok' }))

    const response = await app.fetch(new Request('http://localhost/', {
      headers: { capgkey: 'valid-looking-key' },
    }))

    expect(response.status).toBe(503)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('database_unavailable')
    expect(response.headers.get('Retry-After')).toBe('2')
    expect(recordFailedAuthMock).not.toHaveBeenCalled()
  })

  it('middlewareKey still returns 401 invalid_apikey for a missing key', async () => {
    executeMock.mockResolvedValue({ rows: [] })

    const { Hono } = await import('hono/tiny')
    const app = new Hono()
    app.onError(onError('test-middleware'))
    app.get('/', middlewareKey({ usePostgres: true, readOnly: false }), c => c.json({ status: 'ok' }))

    const response = await app.fetch(new Request('http://localhost/', {
      headers: { capgkey: 'missing-key' },
    }))

    expect(response.status).toBe(401)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('invalid_apikey')
    expect(recordFailedAuthMock).toHaveBeenCalled()
  })

  it('middlewareKey retries checkKeyPg once before succeeding', async () => {
    executeMock
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce({
        rows: [{
          id: 1,
          created_at: null,
          user_id: '00000000-0000-0000-0000-000000000001',
          key: 'retry-key',
          key_hash: null,
          rbac_id: 'rbac-1',
          updated_at: null,
          name: 'k',
          expires_at: null,
        }],
      })

    const { Hono } = await import('hono/tiny')
    const app = new Hono()
    app.onError(onError('test-middleware'))
    app.get('/', middlewareKey({ usePostgres: true, readOnly: false }), c => c.json({ status: 'ok' }))

    const response = await app.fetch(new Request('http://localhost/', {
      headers: { capgkey: 'retry-key' },
    }))

    expect(response.status).toBe(200)
    expect(executeMock).toHaveBeenCalledTimes(2)
    expect(recordFailedAuthMock).not.toHaveBeenCalled()
  })

  it('throwDatabaseUnavailable uses database_unavailable without transient cause rewrite', async () => {
    const { throwDatabaseUnavailable } = await import('../supabase/functions/_backend/utils/pg_auth_lookup.ts')
    const ctx = makeContext()
    try {
      throwDatabaseUnavailable(ctx, 'unit-test', new Error('Connection terminated unexpectedly'))
    }
    catch (error) {
      expect(error).toBeInstanceOf(HTTPException)
      const httpError = error as HTTPException
      expect(httpError.status).toBe(503)
      expect((httpError.cause as { error?: string }).error).toBe('database_unavailable')
      expect((httpError.cause as { originalCause?: unknown }).originalCause).toBeUndefined()
    }
  })
})
