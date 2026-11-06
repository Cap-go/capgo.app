import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getClaimsFromJWT: vi.fn(),
  query: vi.fn(),
  withRlsContext: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/hono_jwt.ts')>()
  return {
    ...actual,
    getClaimsFromJWT: mocks.getClaimsFromJWT,
  }
})

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg_rls.ts')>()
  return {
    ...actual,
    withRlsContext: mocks.withRlsContext,
  }
})

const { verifyEmailOtpAuthSession } = await import('../supabase/functions/_backend/private/verify_email_otp.ts')

const OTP_CLAIMS = { sub: 'user-123', role: 'authenticated', amr: [{ method: 'otp', timestamp: 1 }] }

describe('verifyEmailOtpAuthSession', () => {
  beforeEach(() => {
    mocks.getClaimsFromJWT.mockReset()
    mocks.query.mockReset()
    mocks.withRlsContext.mockReset()
    mocks.getClaimsFromJWT.mockResolvedValue(OTP_CLAIMS)
    mocks.withRlsContext.mockImplementation(async (_c: unknown, _principal: unknown, run: (client: unknown) => unknown) => run({ query: mocks.query }))
  })

  it('checks the OTP access token with verify_email_otp_auth', async () => {
    const context = {} as Parameters<typeof verifyEmailOtpAuthSession>[0]
    mocks.query.mockResolvedValue({ rows: [{ verified: true }] })

    await expect(verifyEmailOtpAuthSession(context, 'otp-access-token')).resolves.toEqual({
      verified: true,
      error: null,
    })

    expect(mocks.getClaimsFromJWT).toHaveBeenCalledWith(context, 'Bearer otp-access-token')
    // Runs as the OTP session itself, so auth.jwt() exposes that token's amr claims.
    expect(mocks.withRlsContext).toHaveBeenCalledWith(context, { kind: 'jwt', userId: 'user-123', claims: OTP_CLAIMS }, expect.any(Function))
    expect(mocks.query).toHaveBeenCalledWith('SELECT public.verify_email_otp_auth() AS verified')
  })

  it('rejects sessions without OTP authentication evidence', async () => {
    const context = {} as Parameters<typeof verifyEmailOtpAuthSession>[0]
    mocks.query.mockResolvedValue({ rows: [{ verified: false }] })

    await expect(verifyEmailOtpAuthSession(context, 'password-access-token')).resolves.toEqual({
      verified: false,
      error: null,
    })
  })

  it('surfaces RPC errors as failed verification', async () => {
    const context = {} as Parameters<typeof verifyEmailOtpAuthSession>[0]
    const error = new Error('rpc failed')
    mocks.query.mockRejectedValue(error)

    await expect(verifyEmailOtpAuthSession(context, 'otp-access-token')).resolves.toEqual({
      verified: false,
      error,
    })
  })

  it('fails verification when the access token cannot be decoded', async () => {
    const context = {} as Parameters<typeof verifyEmailOtpAuthSession>[0]
    mocks.getClaimsFromJWT.mockResolvedValue(null)

    await expect(verifyEmailOtpAuthSession(context, 'bad-token')).resolves.toEqual({
      verified: false,
      error: { message: 'Invalid JWT' },
    })
    expect(mocks.withRlsContext).not.toHaveBeenCalled()
  })
})
