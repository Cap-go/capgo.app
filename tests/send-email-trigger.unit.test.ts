import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  isBentoConfiguredMock,
  trackBentoEventMock,
} = vi.hoisted(() => ({
  isBentoConfiguredMock: vi.fn(() => true),
  trackBentoEventMock: vi.fn(async () => true as boolean | undefined),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', () => ({
  isBentoConfigured: isBentoConfiguredMock,
  trackBentoEvent: trackBentoEventMock,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

vi.mock('../supabase/functions/_backend/utils/utils.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/utils.ts')
  return {
    ...actual,
    getEnv: (_c: unknown, key: string) => {
      if (key === 'SUPABASE_URL')
        return 'https://xyz.supabase.co'
      if (key === 'WEBAPP_URL')
        return 'https://console.capgo.app'
      return ''
    },
  }
})

const { app } = await import('../supabase/functions/_backend/triggers/send_email.ts')

const signupEvent = {
  user: {
    email: 'user@capgo.app',
  },
  email_data: {
    email_action_type: 'signup',
    factor_type: '',
    redirect_to: 'https://console.capgo.app',
    site_url: 'https://console.capgo.app',
    token: '305805',
    token_hash: 'token-hash',
  },
}

function postSendEmail(body: unknown) {
  return app.request('http://local/', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

describe('send_email queue handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isBentoConfiguredMock.mockReturnValue(true)
    trackBentoEventMock.mockResolvedValue(true)
  })

  it('tracks a Bento transactional event with GoTrue template fields', async () => {
    const response = await postSendEmail(signupEvent)

    expect(response.status).toBe(200)
    expect(trackBentoEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'user@capgo.app',
      {
        confirmation_url: 'https://xyz.supabase.co/auth/v1/verify?token=token-hash&type=signup&redirect_to=https%3A%2F%2Fconsole.capgo.app',
        email: 'user@capgo.app',
        factor_type: '',
        new_email: '',
        old_email: '',
        site_url: 'https://console.capgo.app',
        token: '305805',
      },
      'auth_confirmation',
    )
  })

  it('acks when Bento is not configured so local/CI does not poison the queue', async () => {
    isBentoConfiguredMock.mockReturnValue(false)

    const response = await postSendEmail(signupEvent)

    expect(response.status).toBe(200)
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })

  it('fails for queue retry when configured Bento delivery fails', async () => {
    trackBentoEventMock.mockResolvedValue(false)

    const response = await postSendEmail(signupEvent)

    expect(response.status).toBe(500)
  })
})
