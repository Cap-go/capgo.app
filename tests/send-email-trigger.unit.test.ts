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

const signupConfirmationUrl = 'https://xyz.supabase.co/auth/v1/verify?token=token-hash&type=signup&redirect_to=https%3A%2F%2Fconsole.capgo.app'

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
        confirmation_link: `https://console.capgo.app/confirm-signup?confirmation_url=${encodeURIComponent(signupConfirmationUrl)}`,
        confirmation_url: signupConfirmationUrl,
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

  it('tracks magic link with OTP token and auth_magic_link', async () => {
    const response = await postSendEmail({
      user: { email: 'user@capgo.app' },
      email_data: {
        email_action_type: 'magiclink',
        token: '847291',
        token_hash: 'magic-hash',
        redirect_to: 'https://console.capgo.app',
      },
    })

    expect(response.status).toBe(200)
    expect(trackBentoEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'user@capgo.app',
      expect.objectContaining({
        token: '847291',
      }),
      'auth_magic_link',
    )
  })

  it('sends two Bento events for secure email change', async () => {
    const response = await postSendEmail({
      user: {
        email: 'old@capgo.app',
        new_email: 'new@capgo.app',
      },
      email_data: {
        email_action_type: 'email_change',
        old_email: 'old@capgo.app',
        token: '111111',
        token_hash: 'hash-new',
        token_new: '222222',
        token_hash_new: 'hash-current',
        redirect_to: 'https://console.capgo.app',
      },
    })

    expect(response.status).toBe(200)
    expect(trackBentoEventMock).toHaveBeenCalledTimes(2)
    expect(trackBentoEventMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'old@capgo.app',
      expect.objectContaining({ token: '111111' }),
      'auth_email_change',
    )
    expect(trackBentoEventMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'new@capgo.app',
      expect.objectContaining({ token: '222222' }),
      'auth_email_change',
    )
  })

  it('sends insecure email change to the new address', async () => {
    const response = await postSendEmail({
      user: {
        email: 'old@capgo.app',
        new_email: 'new@capgo.app',
      },
      email_data: {
        email_action_type: 'email_change',
        old_email: 'old@capgo.app',
        token: '305805',
        token_hash: 'hash-new',
        redirect_to: 'https://console.capgo.app',
      },
    })

    expect(response.status).toBe(200)
    expect(trackBentoEventMock).toHaveBeenCalledOnce()
    expect(trackBentoEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'new@capgo.app',
      expect.objectContaining({
        email: 'new@capgo.app',
        new_email: 'new@capgo.app',
        old_email: 'old@capgo.app',
      }),
      'auth_email_change',
    )
  })

  it('sends email_changed_notification to the old address', async () => {
    const response = await postSendEmail({
      user: { email: 'new@capgo.app' },
      email_data: {
        email_action_type: 'email_changed_notification',
        old_email: 'old@capgo.app',
      },
    })

    expect(response.status).toBe(200)
    expect(trackBentoEventMock).toHaveBeenCalledWith(
      expect.anything(),
      'old@capgo.app',
      expect.objectContaining({
        old_email: 'old@capgo.app',
      }),
      'auth_email_changed_notification',
    )
  })

  it('fails so the queue retries when Bento is not configured', async () => {
    isBentoConfiguredMock.mockReturnValue(false)

    const response = await postSendEmail(signupEvent)

    expect(response.status).toBe(500)
    expect(trackBentoEventMock).not.toHaveBeenCalled()
  })

  it('fails for queue retry when configured Bento delivery fails', async () => {
    trackBentoEventMock.mockResolvedValue(false)

    const response = await postSendEmail(signupEvent)

    expect(response.status).toBe(500)
  })
})
