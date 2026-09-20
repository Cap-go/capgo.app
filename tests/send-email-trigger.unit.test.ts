import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async (_message: unknown) => ({ messageId: 'message-id' })),
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

const { app: cloudflareApp } = await import('../cloudflare_workers/api/triggers/send_email.ts')
const { app: supabaseApp } = await import('../supabase/functions/_backend/triggers/send_email.ts')
const { renderAuthEmail } = await import('../cloudflare_workers/api/email_templates/index.ts')

const signupEvent = {
  user: { email: 'customer-onboarding@example.com' },
  email_data: {
    email_action_type: 'signup',
    redirect_to: 'https://console.capgo.app',
    site_url: 'https://console.capgo.app',
    token: '305805',
    token_hash: 'token-hash',
  },
}

function postSendEmail(body: unknown, withBinding = true) {
  return cloudflareApp.request('http://local/', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }, (withBinding ? { AUTH_EMAIL: { send: sendMock } } : {}) as never)
}

describe('send_email queue handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendMock.mockResolvedValue({ messageId: 'message-id' })
  })

  it('sends the confirmation email through Cloudflare with a working link', async () => {
    const response = await postSendEmail(signupEvent)

    expect(response.status).toBe(200)
    expect(sendMock).toHaveBeenCalledOnce()
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'customer-onboarding@example.com',
      from: 'noreply@capgo.app',
      subject: 'Confirm your Capgo.app email',
    }))
    const { html, text } = sendMock.mock.calls[0]![0] as { html: string, text: string }
    const confirmationUrl = 'https://xyz.supabase.co/auth/v1/verify?token=token-hash&type=signup&redirect_to=https%3A%2F%2Fconsole.capgo.app'
    const link = `https://console.capgo.app/confirm-signup?confirmation_url=${encodeURIComponent(confirmationUrl)}`
    expect(html).toContain(link)
    expect(text).toContain(link)
  })

  it('includes both the OTP and the magic link in HTML and plain text', async () => {
    const response = await postSendEmail({
      user: { email: 'customer-onboarding@example.com' },
      email_data: {
        email_action_type: 'magiclink',
        token: '847291',
        token_hash: 'magic-hash',
      },
    })

    expect(response.status).toBe(200)
    const { subject, html, text } = sendMock.mock.calls[0]![0] as { subject: string, html: string, text: string }
    expect(subject).toBe('Your Capgo.app sign-in link')
    expect(html).toContain('847291')
    expect(text).toContain('847291')
    expect(text).toContain('https://console.capgo.app/confirm-signup?confirmation_url=')
  })

  it('sends both secure email-change confirmations to their respective addresses', async () => {
    const response = await postSendEmail({
      user: { email: 'old@example.com', new_email: 'new@example.com' },
      email_data: {
        email_action_type: 'email_change',
        old_email: 'old@example.com',
        token: '111111',
        token_hash: 'hash-new',
        token_new: '222222',
        token_hash_new: 'hash-current',
      },
    })

    expect(response.status).toBe(200)
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(sendMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ to: 'old@example.com' }))
    expect(sendMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ to: 'new@example.com' }))
    expect((sendMock.mock.calls[0]![0] as { html: string }).html).toContain('hash-current')
    expect((sendMock.mock.calls[1]![0] as { html: string }).html).toContain('hash-new')
  })

  it('sends the email-changed notice to the old address', async () => {
    const response = await postSendEmail({
      user: { email: 'new@example.com' },
      email_data: { email_action_type: 'email_changed_notification', old_email: 'old@example.com' },
    })

    expect(response.status).toBe(200)
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'old@example.com',
      subject: 'Your Capgo.app email was changed',
    }))
  })

  it('escapes dynamic values in HTML while preserving the plain-text value', async () => {
    const response = await postSendEmail({
      user: { email: 'customer-onboarding@example.com' },
      email_data: { email_action_type: 'mfa_factor_enrolled_notification', factor_type: '<script>alert(1)</script>' },
    })

    expect(response.status).toBe(200)
    const { html, text } = sendMock.mock.calls[0]![0] as { html: string, text: string }
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(text).toContain('<script>alert(1)</script>')
  })

  it.each([
    'email_change',
    'email_changed_notification',
    'invite',
    'magiclink',
    'mfa_factor_enrolled_notification',
    'mfa_factor_unenrolled_notification',
    'password_changed_notification',
    'reauthentication',
    'recovery',
    'signup',
  ] as const)('renders the %s template without unresolved fields', (action) => {
    const content = renderAuthEmail(action, {
      confirmation_link: 'https://example.com/confirm',
      confirmation_url: 'https://example.com/verify',
      email: 'customer-onboarding@example.com',
      factor_type: 'totp',
      new_email: 'new@example.com',
      old_email: 'old@example.com',
      site_url: 'https://example.com',
      token: '123456',
    })
    expect(content.subject).toBeTruthy()
    expect(content.html).toContain('<p')
    expect(content.text).toContain('Hi,')
    expect(content.html).not.toContain('{{')
    expect(content.text).not.toContain('{{')
  })

  it('fails closed without the Cloudflare binding', async () => {
    const response = await postSendEmail(signupEvent, false)
    expect(response.status).toBe(500)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('fails without a required link before sending anything', async () => {
    const response = await postSendEmail({
      user: { email: 'customer-onboarding@example.com' },
      email_data: { email_action_type: 'recovery' },
    })
    expect(response.status).toBe(500)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('fails for queue retry when Cloudflare delivery fails', async () => {
    sendMock.mockRejectedValueOnce(new Error('provider unavailable'))
    const response = await postSendEmail(signupEvent)
    expect(response.status).toBe(500)
  })

  it('rejects unsupported auth email actions', async () => {
    const response = await postSendEmail({
      user: { email: 'customer-onboarding@example.com' },
      email_data: { email_action_type: 'unknown' },
    })
    expect(response.status).toBe(400)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('never sends from the Supabase Edge endpoint', async () => {
    const response = await supabaseApp.request('http://local/', {
      body: JSON.stringify(signupEvent),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(500)
    expect(sendMock).not.toHaveBeenCalled()
  })
})
