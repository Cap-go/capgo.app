import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  matchJsonMock,
  putJsonMock,
  syncUserPreferenceTagsMock,
  unsubscribeBentoMock,
  usersMaybeSingleMock,
  usersUpdateMaybeSingleMock,
} = vi.hoisted(() => ({
  matchJsonMock: vi.fn(async () => null),
  putJsonMock: vi.fn(async () => undefined),
  syncUserPreferenceTagsMock: vi.fn(async () => undefined),
  unsubscribeBentoMock: vi.fn(async () => true),
  usersMaybeSingleMock: vi.fn(async () => ({ data: null, error: null })),
  usersUpdateMaybeSingleMock: vi.fn(async () => ({ data: null, error: null })),
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
        update: () => ({
          eq: () => ({
            select: () => ({
              maybeSingle: usersUpdateMaybeSingleMock,
            }),
          }),
        }),
      }
    },
  }),
}))

vi.mock('../supabase/functions/_backend/utils/user_preferences.ts', () => ({
  syncUserPreferenceTags: syncUserPreferenceTagsMock,
}))

const { app, PUBLIC_EMAIL_PREFERENCE_KEYS } = await import('../supabase/functions/_backend/private/email_preferences.ts')

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
    matchJsonMock.mockResolvedValue(null)
    usersMaybeSingleMock.mockResolvedValue({ data: null, error: null })
    usersUpdateMaybeSingleMock.mockResolvedValue({ data: null, error: null })
    unsubscribeBentoMock.mockResolvedValue(true)
  })

  it('returns ok for unknown emails without creating a user', async () => {
    const response = await postPreferences({
      email: 'nobody@example.com',
      preferences: { onboarding: false },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(usersUpdateMaybeSingleMock).not.toHaveBeenCalled()
    expect(unsubscribeBentoMock).not.toHaveBeenCalled()
    expect(syncUserPreferenceTagsMock).not.toHaveBeenCalled()
  })

  it('returns ok for unknown emails when unsubscribe_all and still unsubscribes Bento', async () => {
    const response = await postPreferences({
      email: 'nobody@example.com',
      unsubscribe_all: true,
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(unsubscribeBentoMock).toHaveBeenCalledWith(expect.anything(), 'nobody@example.com')
    expect(usersUpdateMaybeSingleMock).not.toHaveBeenCalled()
  })

  it('updates existing user preferences and syncs Bento tags', async () => {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      enable_notifications: true,
      opt_for_newsletters: true,
      email_preferences: { onboarding: true, weekly_stats: true },
    }
    usersMaybeSingleMock.mockResolvedValue({ data: user, error: null })
    usersUpdateMaybeSingleMock.mockResolvedValue({
      data: {
        ...user,
        email_preferences: { onboarding: false, weekly_stats: true },
      },
      error: null,
    })

    const response = await postPreferences({
      email: 'User@Example.com',
      preferences: { onboarding: false },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(syncUserPreferenceTagsMock).toHaveBeenCalledOnce()
    expect(unsubscribeBentoMock).not.toHaveBeenCalled()
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

  it('returns the same ok payload when lookup fails', async () => {
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
})
