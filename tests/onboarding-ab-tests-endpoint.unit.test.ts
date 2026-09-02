import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/onboarding_ab_tests.ts'

const { authState, getOrCreateUserABTestsMock } = vi.hoisted(() => ({
  authState: {
    value: {
      authType: 'jwt',
      userId: '11111111-1111-4111-8111-111111111111',
    } as { authType: string, userId: string } | null,
  },
  getOrCreateUserABTestsMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/ab_tests.ts', () => ({
  getOrCreateUserABTests: getOrCreateUserABTestsMock,
}))

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', authState.value)
    await next()
  },
}))

describe('onboarding A/B test endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.value = {
      authType: 'jwt',
      userId: '11111111-1111-4111-8111-111111111111',
    }
  })

  it('returns backend-assigned flags for the authenticated user without accepting a branch choice', async () => {
    const assignments = {
      webnativeapp_development_environment: { assigned_at: '2026-09-01T00:00:00.000Z', branch: 'C' },
      webnativeapp_publish_intent: { assigned_at: '2026-09-01T00:00:00.000Z', branch: 'A' },
    }
    getOrCreateUserABTestsMock.mockResolvedValueOnce(assignments)

    const response = await app.request('http://local/', { method: 'POST' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ assignments })
    expect(getOrCreateUserABTestsMock).toHaveBeenCalledWith(
      expect.anything(),
      authState.value?.userId,
    )
  })

  it('rejects a request without an authenticated user context', async () => {
    authState.value = null

    const response = await app.request('http://local/', { method: 'POST' })

    expect(response.status).toBe(401)
    expect(getOrCreateUserABTestsMock).not.toHaveBeenCalled()
  })
})
