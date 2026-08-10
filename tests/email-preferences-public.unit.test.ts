import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getEnvMock,
  matchJsonMock,
  putJsonMock,
  syncUserPreferenceTagsMock,
  unsubscribeBentoMock,
  usersMaybeSingleMock,
  usersUpdateEqMock,
  usersUpdateMaybeSingleMock,
  verifyCaptchaTokenMock,
} = vi.hoisted(() => ({
  getEnvMock: vi.fn((_c: unknown, key: string) => {
    if (key === 'CAPTCHA_SECRET_KEY')
      return ''
    return ''
  }),
  matchJsonMock: vi.fn(async () => null),
  putJsonMock: vi.fn(async () => undefined),
  syncUserPreferenceTagsMock: vi.fn(async () => undefined),
  unsubscribeBentoMock: vi.fn(async () => true),
  usersMaybeSingleMock: vi.fn(async (): Promise<{ data: unknown, error: unknown }> => ({ data: null, error: null })),
  usersUpdateEqMock: vi.fn(),
  usersUpdateMaybeSingleMock: vi.fn(async (): Promise<{ data: unknown, error: unknown }> => ({ data: null, error: null })),
  verifyCaptchaTokenMock: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  unsubscribeBento: unsubscribeBentoMock,
}))

vi.mock('../supabase/functions/_backend/utils/cache.ts', () => ({
  CacheHelper: class {
    buildRequest() {
      return new Request('https://cache.local/email-preferences')
    }

    matchJson = matchJsonMock
    putJson = putJsonMock
  },
}))

vi.mock('../supabase/functions/_backend/utils/captcha.ts', () => ({
  verifyCaptchaToken: verifyCaptchaTokenMock,
}))

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  getClientIP: () => '203.0.113.10',
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table !== 'users')
        throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          ilike: () => ({
            maybeSingle: usersMaybeSingleMock,
          }),
        }),
        update: (payload: unknown) => {
          usersUpdateEqMock(payload)
          return {
            eq: () => ({
              select: () => ({
                maybeSingle: usersUpdateMaybeSingleMock,
              }),
            }),
          }
        },
      }
    },
  }),
}))

vi.mock('../supabase/functions/_backend/utils/user_preferences.ts', () => ({
  syncUserPreferenceTags: syncUserPreferenceTagsMock,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>()
  return {
    ...actual,
    getEnv: getEnvMock,
  }
})

const {
  app,
  PUBLIC_EMAIL_PREFERENCE_KEYS,
  escapeIlikeExact,
  sanitizeOptOutPreferences,
} = await import('../supabase/functions/_backend/private/email_preferences.ts')

async function postPreferences(body: unknown) {
  return await app.request('http://local/', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

describe('public email preferences endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getEnvMock.mockImplementation((_c: unknown, key: string) => {
      if (key === 'CAPTCHA_SECRET_KEY')
        return ''
      return ''
    })
    matchJsonMock.mockResolvedValue(null)
    usersMaybeSingleMock.mockResolvedValue({ data: null, error: null })
    usersUpdateMaybeSingleMock.mockResolvedValue({ data: null, error: null })
    unsubscribeBentoMock.mockResolvedValue(true)
    verifyCaptchaTokenMock.mockResolvedValue(undefined)
  })

  it('escapes ilike wildcards in emails', () => {
    expect(escapeIlikeExact('a%b_c\\d@example.com')).toBe('a\\%b\\_c\\\\d@example.com')
  })

  it('strips unknown keys and ignores re-enable attempts', () => {
    expect(sanitizeOptOutPreferences({
      onboarding: false,
      weekly_stats: true,
      admin: false,
    })).toEqual({ onboarding: false })
  })

  it('returns ok for unknown emails without creating a user', async () => {
    const response = await postPreferences({
      email: 'nobody@example.com',
      preferences: { onboarding: false },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(usersUpdateEqMock).not.toHaveBeenCalled()
    expect(unsubscribeBentoMock).not.toHaveBeenCalled()
    expect(syncUserPreferenceTagsMock).not.toHaveBeenCalled()
    expect(verifyCaptchaTokenMock).not.toHaveBeenCalled()
  })

  it('returns ok for unknown emails when unsubscribe_all and still unsubscribes Bento', async () => {
    const response = await postPreferences({
      email: 'nobody@example.com',
      unsubscribe_all: true,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'nobody@example.com')
    expect(usersUpdateEqMock).not.toHaveBeenCalled()
  })

  it('applies opt-outs without re-enabling existing prefs', async () => {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      enable_notifications: true,
      opt_for_newsletters: true,
      email_preferences: { onboarding: false, weekly_stats: true },
    }
    usersMaybeSingleMock.mockResolvedValue({ data: user, error: null })
    usersUpdateMaybeSingleMock.mockResolvedValue({
      data: {
        ...user,
        email_preferences: { onboarding: false, weekly_stats: false },
      },
      error: null,
    })

    const response = await postPreferences({
      email: 'User@Example.com',
      preferences: {
        onboarding: true,
        weekly_stats: false,
        admin: true,
      },
      enable_notifications: true,
      opt_for_newsletters: true,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(usersUpdateEqMock).toHaveBeenCalledWith({
      email_preferences: { onboarding: false, weekly_stats: false },
      enable_notifications: true,
      opt_for_newsletters: true,
    })
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledOnce()
    expect(unsubscribeBentoMock).not.toHaveBeenCalled()
  })

  it('disables general flags only when explicitly opted out', async () => {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      enable_notifications: true,
      opt_for_newsletters: true,
      email_preferences: {},
    }
    usersMaybeSingleMock.mockResolvedValue({ data: user, error: null })
    usersUpdateMaybeSingleMock.mockResolvedValue({
      data: { ...user, enable_notifications: false, opt_for_newsletters: true },
      error: null,
    })

    const response = await postPreferences({
      email: 'user@example.com',
      enable_notifications: false,
    })

    expect(response.status).toBe(200)
    expect(usersUpdateEqMock).toHaveBeenCalledWith(expect.objectContaining({
      enable_notifications: false,
      opt_for_newsletters: true,
    }))
  })

  it('disables all prefs and unsubscribes Bento when unsubscribe_all is set', async () => {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      enable_notifications: true,
      opt_for_newsletters: true,
      email_preferences: { onboarding: true },
    }
    usersMaybeSingleMock.mockResolvedValue({ data: user, error: null })
    usersUpdateMaybeSingleMock.mockResolvedValue({
      data: {
        ...user,
        enable_notifications: false,
        opt_for_newsletters: false,
        email_preferences: Object.fromEntries(PUBLIC_EMAIL_PREFERENCE_KEYS.map(key => [key, false])),
      },
      error: null,
    })

    const response = await postPreferences({
      email: 'user@example.com',
      unsubscribe_all: true,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'user@example.com')
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledOnce()
  })

  it('still unsubscribes Bento when lookup fails and unsubscribe_all is set', async () => {
    usersMaybeSingleMock.mockResolvedValue({ data: null, error: { message: 'db down' } })

    const response = await postPreferences({
      email: 'user@example.com',
      unsubscribe_all: true,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'user@example.com')
  })

  it('returns the same ok payload when lookup fails without unsubscribe', async () => {
    usersMaybeSingleMock.mockResolvedValue({ data: null, error: { message: 'db down' } })

    const response = await postPreferences({
      email: 'user@example.com',
      preferences: { onboarding: false },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('rejects invalid payloads without revealing account state', async () => {
    const response = await postPreferences({ email: 'not-an-email' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_payload' })
    expect(usersMaybeSingleMock).not.toHaveBeenCalled()
  })

  it('requires captcha when CAPTCHA_SECRET_KEY is set', async () => {
    getEnvMock.mockImplementation((_c: unknown, key: string) => {
      if (key === 'CAPTCHA_SECRET_KEY')
        return 'test-secret'
      return ''
    })

    const response = await postPreferences({
      email: 'nobody@example.com',
      preferences: { onboarding: false },
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_captcha' })
    expect(verifyCaptchaTokenMock).not.toHaveBeenCalled()
    expect(usersMaybeSingleMock).not.toHaveBeenCalled()
  })

  it('verifies captcha token when CAPTCHA_SECRET_KEY is set', async () => {
    getEnvMock.mockImplementation((_c: unknown, key: string) => {
      if (key === 'CAPTCHA_SECRET_KEY')
        return 'test-secret'
      return ''
    })

    const response = await postPreferences({
      email: 'nobody@example.com',
      preferences: { onboarding: false },
      captcha_token: 'turnstile-token',
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(verifyCaptchaTokenMock).toHaveBeenCalledWith(expect.anything(), 'turnstile-token', 'test-secret')
  })
})
