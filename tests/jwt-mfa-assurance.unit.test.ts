import type { AuthInfo } from '../supabase/functions/_backend/utils/hono.ts'
import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const USER_ID = '00000000-0000-4000-8000-000000000101'
const SESSION_ID = '11111111-2222-3333-4444-555555555555'

const { closeClientMock, getPgClientMock, queryMock } = vi.hoisted(() => ({
  closeClientMock: vi.fn(),
  getPgClientMock: vi.fn(),
  queryMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

const { assertJwtMfaAssurance, getJwtAal } = await import('../supabase/functions/_backend/utils/jwt_mfa_assurance.ts')

function createContext() {
  return {
    get: vi.fn(),
  }
}

function createJwtAuth(claims: Record<string, unknown> = {}): AuthInfo {
  return {
    userId: USER_ID,
    authType: 'jwt',
    jwt: 'jwt-token',
    apikey: null,
    claims: {
      sub: USER_ID,
      ...claims,
    },
  }
}

function mockPgResponses(hasVerifiedMfa: boolean, isImpersonating?: boolean) {
  queryMock.mockReset()
  queryMock.mockResolvedValueOnce({ rows: [{ has_verified_mfa: hasVerifiedMfa }] })
  if (isImpersonating !== undefined) {
    queryMock.mockResolvedValueOnce({ rows: [{ is_active: isImpersonating }] })
  }
  getPgClientMock.mockReturnValue({ query: queryMock })
}

describe('getJwtAal', () => {
  it('defaults missing claims to aal1', () => {
    expect(getJwtAal(undefined)).toBe('aal1')
    expect(getJwtAal({ sub: USER_ID })).toBe('aal1')
  })

  it('returns explicit aal claims', () => {
    expect(getJwtAal({ sub: USER_ID, aal: 'aal2' })).toBe('aal2')
  })
})

describe('assertJwtMfaAssurance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows API-key auth without checking MFA', async () => {
    await expect(assertJwtMfaAssurance(createContext() as never, {
      userId: USER_ID,
      authType: 'apikey',
      jwt: null,
      apikey: null,
    })).resolves.toBeUndefined()
    expect(getPgClientMock).not.toHaveBeenCalled()
  })

  it('allows JWT users without verified MFA factors at aal1', async () => {
    mockPgResponses(false)
    await expect(assertJwtMfaAssurance(createContext() as never, createJwtAuth({ aal: 'aal1' }))).resolves.toBeUndefined()
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('rejects MFA-enrolled JWT users at aal1', async () => {
    mockPgResponses(true)
    await expect(assertJwtMfaAssurance(createContext() as never, createJwtAuth({ aal: 'aal1' }))).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(HTTPException)
      expect((error as HTTPException).status).toBe(403)
      expect((error as HTTPException).cause).toMatchObject({ error: 'mfa_required' })
      return true
    })
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('allows MFA-enrolled JWT users at aal2', async () => {
    mockPgResponses(true)
    await expect(assertJwtMfaAssurance(createContext() as never, createJwtAuth({ aal: 'aal2' }))).resolves.toBeUndefined()
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('allows active platform-admin impersonation sessions at aal1', async () => {
    mockPgResponses(true, true)
    await expect(assertJwtMfaAssurance(createContext() as never, createJwtAuth({
      aal: 'aal1',
      session_id: SESSION_ID,
    }))).resolves.toBeUndefined()
    expect(queryMock).toHaveBeenCalledTimes(2)
  })
})
