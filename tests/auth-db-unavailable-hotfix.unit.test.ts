/** Regression tests for files upload auth mapping transient Postgres errors to 503. */
import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CapgoDrizzleQueryLogger } from '../supabase/functions/_backend/utils/drizzle_query_logger.ts'
import { onError } from '../supabase/functions/_backend/utils/on_error.ts'
import { withAuthPgRetry } from '../supabase/functions/_backend/utils/pg_auth_retry.ts'
import { getUserIdFromApikey } from '../supabase/functions/_backend/utils/pg_files.ts'

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

vi.mock('../supabase/functions/_backend/utils/logging.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/logging.ts')>(),
  cloudlog: cloudlogMock,
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  closeClient: vi.fn(async () => undefined),
  getDrizzleClient: getDrizzleClientMock,
  getPgClient: getPgClientMock,
  logPgError: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  setAPIKeyRateLimitHeaders: vi.fn(),
  setFailedAuthRateLimitPolicyHeader: vi.fn(),
  isAPIKeyRateLimited: vi.fn(async () => ({ limited: false })),
  isIPRateLimited: vi.fn(async () => ({ limited: false })),
  recordAPIKeyUsage: vi.fn(async () => ({ count: 1 })),
  recordFailedAuth: recordFailedAuthMock,
}))

const { middlewareKey } = await import('../supabase/functions/_backend/utils/hono_middleware.ts')

const retryKeyRow = {
  id: 1,
  created_at: null,
  user_id: '00000000-0000-0000-0000-000000000001',
  key: 'retry-key',
  key_hash: null,
  rbac_id: 'rbac-1',
  updated_at: null,
  name: 'k',
  expires_at: null,
}

async function requestWithKey(capgkey: string) {
  const { Hono } = await import('hono/tiny')
  const app = new Hono()
  app.onError(onError('test-middleware'))
  app.get('/', middlewareKey({ usePostgres: true, readOnly: false }), c => c.json({ status: 'ok' }))
  return app.fetch(new Request('http://localhost/', { headers: { capgkey } }))
}

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
    getPgClientMock.mockImplementation(() => ({}))
  })

  it.each([
    ['find_apikey_by_value', 'SELECT * FROM find_apikey_by_value($1)', 'super-secret-api-key'],
    ['rbac_check_permission_direct', 'SELECT public.rbac_check_permission_direct($1, $2::uuid, $3::uuid, $4, $5::bigint, $6) AS allowed', 'capgo_secret_key'],
  ])('redacts %s api key bind parameters in drizzle query logs', (_label, query, secret) => {
    new CapgoDrizzleQueryLogger().logQuery(query, [secret])
    expect(cloudlogMock).toHaveBeenCalledWith({ message: `Query: ${query} -- params: [redacted]` })
    expect(JSON.stringify(cloudlogMock.mock.calls)).not.toContain(secret)
  })

  it('retries once on transient Hyperdrive pool errors', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('Timed out while waiting for an open slot in the pool.'))
      .mockResolvedValueOnce('ok')

    await expect(withAuthPgRetry(operation)).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('getUserIdFromApikey returns db_error instead of null on Postgres failure', async () => {
    const failure = new Error('Connection terminated unexpectedly')
    executeMock.mockRejectedValue(failure)
    const result = await getUserIdFromApikey(makeContext(), 'capgo_test_key', {} as any)
    expect(result).toEqual({ kind: 'db_error', error: failure })
  })

  it('getUserIdFromApikey retries a dropped connection on a fresh primary client', async () => {
    const callerClient = { id: 'caller' }
    const freshClient = { id: 'fresh' }
    getPgClientMock.mockImplementation(() => freshClient as any)
    executeMock
      .mockRejectedValueOnce(new Error('Client has encountered a connection error and is not queryable'))
      .mockResolvedValueOnce({ rows: [{ get_user_id: 'user-1' }] })

    const result = await getUserIdFromApikey(makeContext(), 'capgo_test_key', callerClient as any)

    expect(result).toEqual({ kind: 'ok', value: 'user-1' })
    expect(getDrizzleClientMock.mock.calls.map(call => (call as unknown[])[0])).toEqual([callerClient, freshClient])
    expect(getPgClientMock).toHaveBeenCalledWith(expect.anything(), false)
  })

  it('middlewareKey returns 503 database_unavailable on checkKeyPg failure without recording failed auth', async () => {
    executeMock.mockRejectedValue(new Error('Timed out while waiting for an open slot in the pool.'))

    const response = await requestWithKey('valid-looking-key')

    expect(response.status).toBe(503)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('database_unavailable')
    expect(response.headers.get('Retry-After')).toBe('2')
    expect(recordFailedAuthMock).not.toHaveBeenCalled()
  })

  it('middlewareKey still returns 401 invalid_apikey for a missing key', async () => {
    executeMock.mockResolvedValue({ rows: [] })

    const response = await requestWithKey('missing-key')

    expect(response.status).toBe(401)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('invalid_apikey')
    expect(recordFailedAuthMock).toHaveBeenCalled()
  })

  it('middlewareKey retries when getPgClient throws a transient error', async () => {
    getPgClientMock
      .mockImplementationOnce(() => {
        throw new Error('timeout exceeded when trying to connect')
      })
      .mockImplementation(() => ({}))
    executeMock.mockResolvedValueOnce({ rows: [retryKeyRow] })

    const response = await requestWithKey('retry-key')

    expect(response.status).toBe(200)
    expect(getPgClientMock).toHaveBeenCalledTimes(2)
    expect(recordFailedAuthMock).not.toHaveBeenCalled()
  })

  it('middlewareKey retries checkKeyPg once before succeeding', async () => {
    executeMock
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce({ rows: [retryKeyRow] })

    const response = await requestWithKey('retry-key')

    expect(response.status).toBe(200)
    expect(executeMock).toHaveBeenCalledTimes(2)
    expect(recordFailedAuthMock).not.toHaveBeenCalled()
  })

  it('throwDatabaseUnavailable uses database_unavailable without transient cause rewrite', async () => {
    const { throwDatabaseUnavailable } = await import('../supabase/functions/_backend/utils/pg_auth_lookup.ts')
    const ctx = makeContext()
    expect.assertions(4)
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
