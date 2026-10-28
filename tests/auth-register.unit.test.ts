import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getEnvMock,
  getClientIPMock,
  rpcMock,
  signUpMock,
  usersUpsertMock,
  deleteUserMock,
  updateUserByIdMock,
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
  updateUserByIdMock: vi.fn<(id: string, attributes: unknown) => Promise<{ error: Error | null }>>(async () => ({ error: null })),
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
        updateUserById: updateUserByIdMock,
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

describe('pOST /auth/register unit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    { label: 'names supplied', names: {} },
    { label: 'both names omitted', names: { first_name: undefined, last_name: undefined } },
  ])('requires captcha when CAPTCHA_SECRET_KEY is configured ($label)', async ({ names }) => {
    const response = await postRegister({
      ...validBody,
      ...names,
      captcha_token: undefined,
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'captcha_failed' })
    expect(rpcMock).not.toHaveBeenCalled()
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

  it('stores offer=direct in server-only app metadata before creating the profile', async () => {
    const response = await postRegister({ ...validBody, offer: 'direct' })
    expect(response.status).toBe(200)
    expect(updateUserByIdMock).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', { app_metadata: { offer: 'direct' } })
    expect(updateUserByIdMock.mock.invocationCallOrder[0]).toBeLessThan(usersUpsertMock.mock.invocationCallOrder[0])
    const signUpOptions = (signUpMock.mock.calls[0] as unknown as [{ options: { data: Record<string, unknown> } }])[0].options
    expect(signUpOptions.data).not.toHaveProperty('offer')
  })

  it('ignores any other offer value', async () => {
    const response = await postRegister({ ...validBody, offer: 'Direct' })
    expect(response.status).toBe(200)
    expect(updateUserByIdMock).not.toHaveBeenCalled()
  })

  it('rolls back the signup when the direct offer cannot be stored', async () => {
    updateUserByIdMock.mockResolvedValueOnce({ error: new Error('auth unavailable') })
    const response = await postRegister({ ...validBody, offer: 'direct' })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: 'registration_failed' })
    expect(usersUpsertMock).not.toHaveBeenCalled()
    expect(deleteUserMock).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111')
  })

  it.each([
    { label: 'both names omitted', firstName: undefined, lastName: undefined },
    { label: 'first name omitted', firstName: undefined, lastName: 'Doe' },
    { label: 'last name omitted', firstName: 'Jane', lastName: undefined },
  ])('creates a profile with $label', async ({ firstName, lastName }) => {
    const response = await postRegister({
      ...validBody,
      first_name: firstName,
      last_name: lastName,
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: { id: '11111111-1111-1111-1111-111111111111' },
      session: { access_token: 'access-token', refresh_token: 'refresh-token' },
    })
    expect(signUpMock).toHaveBeenCalledWith({
      email: validBody.email,
      password: validBody.password,
      options: {
        captchaToken: validBody.captcha_token,
        data: {
          ...(firstName ? { first_name: firstName } : {}),
          ...(lastName ? { last_name: lastName } : {}),
        },
      },
    })
    expect(usersUpsertMock).toHaveBeenCalledWith({
      id: '11111111-1111-1111-1111-111111111111',
      email: validBody.email,
      first_name: firstName ?? '',
      last_name: lastName ?? '',
      enable_notifications: true,
      opt_for_newsletters: false,
    }, { onConflict: 'id' })
  })

  it.each([
    { first_name: '' },
    { first_name: '   ' },
    { first_name: null },
    { first_name: 123 },
    { last_name: '' },
    { last_name: '   ' },
    { last_name: null },
    { last_name: false },
  ])('rejects invalid supplied names: %j', async (names) => {
    const response = await postRegister({ ...validBody, ...names })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
    expect(rpcMock).not.toHaveBeenCalled()
    expect(signUpMock).not.toHaveBeenCalled()
    expect(usersUpsertMock).not.toHaveBeenCalled()
  })

  it.each(['password', 'Password!', 'Password123', 'PASSWORD123!', ''])('still rejects weak passwords without names: %j', async (password) => {
    const response = await postRegister({
      ...validBody,
      first_name: undefined,
      last_name: undefined,
      password,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
    expect(rpcMock).not.toHaveBeenCalled()
    expect(signUpMock).not.toHaveBeenCalled()
  })

  it.each([true, false])('preserves signup attribution and explicit newsletter preference %s without forcing an onboarding version', async (newsletter) => {
    const attribution = {
      ref: 'readme-example',
      signup_source: 'plugin_example',
      signup_plugin: 'example',
      first_touch_type: 'plugin',
      first_touch_path: '/plugins/example/',
      utm_source: 'example-source',
      utm_medium: 'readme',
      utm_campaign: 'example-campaign',
    }
    const response = await postRegister({
      ...validBody,
      ...attribution,
      first_name: undefined,
      last_name: undefined,
      opt_for_newsletters: newsletter,
    })
    expect(response.status).toBe(200)
    expect(signUpMock).toHaveBeenCalledWith({
      email: validBody.email,
      password: validBody.password,
      options: { captchaToken: validBody.captcha_token, data: attribution },
    })
    expect(usersUpsertMock).toHaveBeenCalledWith({
      id: '11111111-1111-1111-1111-111111111111',
      email: validBody.email,
      first_name: '',
      last_name: '',
      enable_notifications: true,
      opt_for_newsletters: newsletter,
    }, { onConflict: 'id' })
  })

  it('rejects non-boolean newsletter preferences before signup', async () => {
    const response = await postRegister({ ...validBody, opt_for_newsletters: 'true' })
    expect(response.status).toBe(400)
    expect(signUpMock).not.toHaveBeenCalled()
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

  it('returns weak_password with the GoTrue reason instead of a generic 500', async () => {
    signUpMock.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: 'weak_password', message: 'Password is too weak', status: 422 },
    } as unknown as Awaited<ReturnType<typeof signUpMock>>)
    const response = await postRegister(validBody)
    expect(response.status).toBe(422)
    const body = await response.json() as { error: string, message: string }
    expect(body.error).toBe('weak_password')
    expect(body.message).toBe('Password is too weak')
  })

  it('tells the user to pick another password when GoTrue finds it in a breach list', async () => {
    signUpMock.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { code: 'weak_password', message: 'Password is known to be weak and easy to guess, please choose a different one.', status: 422, reasons: ['pwned'] },
    } as unknown as Awaited<ReturnType<typeof signUpMock>>)
    const response = await postRegister(validBody)
    expect(response.status).toBe(422)
    const body = await response.json() as { error: string, message: string }
    expect(body.error).toBe('weak_password')
    expect(body.message).toBe('This password appeared in a data breach. Choose a different one.')
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
