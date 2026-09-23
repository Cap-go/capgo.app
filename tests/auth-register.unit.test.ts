import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getEnvMock,
  rpcMock,
  signUpMock,
  usersUpsertMock,
  deleteUserMock,
  usersDeleteMock,
} = vi.hoisted(() => ({
  getEnvMock: vi.fn((_c: unknown, key: string) => {
    if (key === 'CAPTCHA_SECRET_KEY')
      return 'turnstile-secret'
    return ''
  }),
  rpcMock: vi.fn(async () => ({ data: true, error: null })),
  signUpMock: vi.fn(async () => ({
    data: {
      user: { id: '11111111-1111-1111-1111-111111111111' },
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

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  emptySupabase: () => ({
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
    })
    const response = await postRegister(validBody)
    expect(response.status).toBe(422)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('captcha_failed')
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
