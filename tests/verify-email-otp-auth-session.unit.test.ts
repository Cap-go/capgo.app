import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  supabaseClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/supabase.ts')>()
  return {
    ...actual,
    supabaseClient: mocks.supabaseClient,
  }
})

const { verifyEmailOtpAuthSession } = await import('../supabase/functions/_backend/private/verify_email_otp.ts')

describe('verifyEmailOtpAuthSession', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    mocks.supabaseClient.mockReset()
    mocks.supabaseClient.mockReturnValue({ rpc: mocks.rpc })
  })

  it('checks the OTP access token with verify_email_otp_auth', async () => {
    const context = {} as Parameters<typeof verifyEmailOtpAuthSession>[0]
    mocks.rpc.mockResolvedValue({ data: true, error: null })

    await expect(verifyEmailOtpAuthSession(context, 'otp-access-token')).resolves.toEqual({
      verified: true,
      error: null,
    })

    expect(mocks.supabaseClient).toHaveBeenCalledWith(context, 'Bearer otp-access-token')
    expect(mocks.rpc).toHaveBeenCalledWith('verify_email_otp_auth')
  })

  it('rejects sessions without OTP authentication evidence', async () => {
    const context = {} as Parameters<typeof verifyEmailOtpAuthSession>[0]
    mocks.rpc.mockResolvedValue({ data: false, error: null })

    await expect(verifyEmailOtpAuthSession(context, 'password-access-token')).resolves.toEqual({
      verified: false,
      error: null,
    })
  })

  it('surfaces RPC errors as failed verification', async () => {
    const context = {} as Parameters<typeof verifyEmailOtpAuthSession>[0]
    const error = { message: 'rpc failed' }
    mocks.rpc.mockResolvedValue({ data: null, error })

    await expect(verifyEmailOtpAuthSession(context, 'otp-access-token')).resolves.toEqual({
      verified: false,
      error,
    })
  })
})
