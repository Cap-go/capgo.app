import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getEnvMock,
  getClientIPMock,
  rpcMock,
  signUpMock,
  usersUpsertMock,
  deleteUserMock,
  usersDeleteMock,
} = vi.hoisted(() => ({
  getEnvMock: vi.fn((_c: unknown, key: string) => {
    if (key === 'CAPTCHA_SECRET_KEY')
      return 'turnstile-secret'
    if (key === 'SUPABASE_URL')
      return 'https://example.supabase.co'
    if (key === 'SUPABASE_ANON_KEY')
      return 'anon-key'
    return ''
  }),
  getClientIPMock: vi.fn(() => '203.0.113.10'),
  rpcMock: vi.fn(async () => ({ data: true, error: null })),
  signUpMock: vi.fn(async () => ({
    data: {
      user: { id: '11111111-1111-1111-1111-111111111111', email_confirmed_at: '2026-01-01T00:00:00.000Z' },
      session: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
    },
    error: null,
  })),
  usersUpsertMock: vi.fn(async () => ({ error: null })),
  deleteUserMock: vi.fn(async () => ({ error: null })),
  usersDeleteMock: vi.fn(async () => ({ error: null })),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: getEnvMock,
}))

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  getClientIP: getClientIPMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  emptySupabaseWithClientIP: () => ({
    auth: {
      signUp: signUpMock,
    },
  }),
  supabaseAdmin: () => ({
    rpc: rpcMock,
    from(table: string) {
      if (table === 'users') {
        return {
          upsert: usersUpsertMock,
          delete: () => ({
            eq: usersDeleteMock,
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    auth: {
      admin: {
        deleteUser: deleteUserMock,
      },
    },
  }),
}))

const { app } = await import('../supabase/functions/_backend/auth/register.ts')

function postRegister(body: Record<string, unknown>) {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const validBody = {
  email: 'new-user@example.com',
  password: 'Password123!',
  first_name: 'Jane',
  last_name: 'Doe',
  captcha_token: 'captcha-token',
}

describe('POST /auth/register unit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires captcha when CAPTCHA_SECRET_KEY is configured', async () => {
    const response = await postRegister({
      ...validBody,
      captcha_token: undefined,
    })
    expect(response.status).toBe(422)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('captcha_failed')
    expect(signUpMock).not.toHaveBeenCalled()
  })

  it('forwards captcha_token to GoTrue signUp without local siteverify', async () => {
    const response = await postRegister(validBody)
    expect(response.status).toBe(200)
    expect(signUpMock).toHaveBeenCalledWith({
      email: validBody.email,
      password: validBody.password,
      options: {
        captchaToken: validBody.captcha_token,
        data: {
          first_name: validBody.first_name,
          last_name: validBody.last_name,
        },
      },
    })
  })

  it('returns captcha_failed when GoTrue rejects the captcha token', async () => {
    signUpMock.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: 'captcha_failed', message: 'Captcha verification failed' },
    } as unknown as Awaited<ReturnType<typeof signUpMock>>)
    const response = await postRegister(validBody)
    expect(response.status).toBe(422)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('captcha_failed')
  })

  it('does not map weak_password 422 to email_exists', async () => {
    signUpMock.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: 'weak_password', message: 'Password is too weak', status: 422 },
    } as unknown as Awaited<ReturnType<typeof signUpMock>>)
    const response = await postRegister(validBody)
    expect(response.status).toBe(500)
    const body = await response.json() as { error: string }
    expect(body.error).not.toBe('email_exists')
    expect(body.error).toBe('registration_failed')
  })

  it('returns 429 when GoTrue reports a rate limit', async () => {
    signUpMock.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: 'over_request_rate_limit', message: 'Request rate limit reached', status: 429 },
    } as unknown as Awaited<ReturnType<typeof signUpMock>>)
    const response = await postRegister(validBody)
    expect(response.status).toBe(429)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('too_many_requests')
  })

  it('does not rollback when signup succeeded but email confirmation is pending', async () => {
    signUpMock.mockResolvedValueOnce({
      data: {
        user: { id: '22222222-2222-2222-2222-222222222222', email_confirmed_at: undefined },
        session: null,
      },
      error: null,
    } as unknown as Awaited<ReturnType<typeof signUpMock>>)
    const response = await postRegister(validBody)
    expect(response.status).toBe(500)
    expect(usersDeleteMock).not.toHaveBeenCalled()
    expect(deleteUserMock).not.toHaveBeenCalled()
  })

  it('returns account_deleted when is_not_deleted is false', async () => {
    rpcMock.mockResolvedValueOnce({ data: false, error: null })
    const response = await postRegister(validBody)
    expect(response.status).toBe(403)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('account_deleted')
    expect(signUpMock).not.toHaveBeenCalled()
  })
})
