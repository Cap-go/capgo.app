import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock, queryMock, releaseMock, logMock, runtimeMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async (_message: unknown) => ({ messageId: 'message-id' })),
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  logMock: vi.fn(),
  runtimeMock: vi.fn(() => 'node'),
}))

vi.mock('hono/adapter', async () => ({
  ...await vi.importActual('hono/adapter'),
  getRuntimeKey: runtimeMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async () => ({
  ...await vi.importActual('../supabase/functions/_backend/utils/pg.ts'),
  getPgClient: async () => ({ connect: async () => ({ query: queryMock, release: releaseMock }) }),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', async () => ({
  ...await vi.importActual('../supabase/functions/_backend/utils/logging.ts'),
  cloudlog: logMock,
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

const orgInvitationId = 'bacf009d-fbdc-40a0-9190-ec3e2dcf5e01'
const orgId = '984c9e7d-797a-4c6e-a2ea-b78dbebf1d78'
const recipientUserId = 'c72447f3-0498-4d55-8a95-464e2c4b804f'
const providerAcceptedAt = '2026-10-03 10:00:00.234567+00'
const tokenCreatedAt = '2026-10-01 10:00:00.123456+00'
const invitation = {
  id: orgInvitationId,
  org_id: orgId,
  recipient_user_id: null as string | null,
  token_created_at: tokenCreatedAt as string | null,
  org_user_id: null as number | null,
  tmp_user_id: 42 as number | null,
  sent_at: null as string | null,
  is_pending: true,
  email: 'invitee@example.com',
  first_name: 'Alex',
  last_name: '',
  org_name: 'Example & Team',
  org_admin_name: 'Pat Admin',
  invite_magic_string: 'secret-invite-token',
}

function mockInvitation(overrides: Partial<typeof invitation> = {}) {
  queryMock.mockImplementation(async (query: string) => {
    if (query.includes('FROM public.org_invitation_email_requests'))
      return { rows: [{ ...invitation, ...overrides }] }
    if (query.includes('UPDATE public.org_invitation_email_requests'))
      return { rows: [{ sent_at: providerAcceptedAt }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
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
    sendMock.mockReset().mockResolvedValue({ messageId: 'message-id' })
    runtimeMock.mockReturnValue('node')
    mockInvitation()
  })

  it('sends a new-account organization invite with the existing subject and invitation link', async () => {
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'invitee@example.com',
      from: 'noreply@capgo.app',
      subject: '[Capgo]: Join Example & Team org & create account',
    }))
    const content = sendMock.mock.calls[0]![0] as { html: string, text: string }
    expect(content.html).toContain('Example &amp; Team')
    expect(content.html).toContain('/invitation?invite_magic_string=secret-invite-token')
    expect(content.text).toContain('Pat Admin')
    expect(content.text).toContain('valid for seven days')
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('UPDATE public.org_invitation_email_requests'), [orgInvitationId, 'message-id'])
    const factCall = queryMock.mock.calls.find(([query]) => query.includes('INSERT INTO public.bento_event_dispatches'))!
    expect(factCall[1]).toEqual([
      'org:invitation',
      orgInvitationId,
      'email:invitee@example.com',
      'invitee@example.com',
      'flow:started',
      providerAcceptedAt,
      expect.any(String),
      null,
      expect.any(String),
      expect.any(String),
    ])
    expect(JSON.parse(factCall[1][6])).toEqual({
      kind: 'new',
      orgId,
      invitationId: '42',
      userId: null,
      generation: orgInvitationId,
      tokenCreatedAt,
    })
    const [audit] = JSON.parse(factCall[1][8])
    expect(audit.request_id).toBe(orgInvitationId)
    expect(audit.payload.nonPersonTags).toMatchObject({ dispatch_id: factCall[1][9], context_key: orgInvitationId, reason: 'initial_provider_accepted' })
    expect(JSON.stringify(factCall)).not.toContain('secret-invite-token')
    const sqlCalls = queryMock.mock.calls.map(([query]) => query)
    expect(sqlCalls.findIndex(query => query.includes('UPDATE public.org_invitation_email_requests'))).toBeLessThan(sqlCalls.indexOf(factCall[0]))
    expect(sqlCalls.indexOf(factCall[0])).toBeLessThan(sqlCalls.indexOf('COMMIT'))
    expect(JSON.stringify(logMock.mock.calls)).toContain('message-id')
    expect(JSON.stringify(logMock.mock.calls)).not.toContain('secret-invite-token')
    expect(JSON.stringify(logMock.mock.calls)).not.toContain('invitee@example.com')
    expect(releaseMock).toHaveBeenCalledOnce()
  })

  it('keeps the invitation delivery alive in the Worker when the queue client disconnects', async () => {
    runtimeMock.mockReturnValue('workerd')
    const waitUntil = vi.fn()
    const response = await cloudflareApp.request('http://local/', {
      body: JSON.stringify({ org_invitation_id: orgInvitationId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }, { AUTH_EMAIL: { send: sendMock } } as never, { waitUntil, passThroughOnException: vi.fn(), props: {} })
    expect(response.status).toBe(200)
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
    expect(queryMock).toHaveBeenCalledWith('SET LOCAL idle_in_transaction_session_timeout = 60000')
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('UPDATE public.org_invitation_email_requests'), [orgInvitationId, 'message-id'])
  })

  it('sends an existing-account organization invite with its existing subject and dashboard link', async () => {
    mockInvitation({ org_user_id: 24, tmp_user_id: null, recipient_user_id: recipientUserId, token_created_at: null })
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      subject: '[Capgo]: Join Example & Team with your account',
    }))
    const content = sendMock.mock.calls[0]![0] as { html: string, text: string }
    expect(content.html).toContain(`/dashboard?invite_org=${orgId}`)
    expect(content.text).toContain('with your existing account')
    expect(content.text).not.toContain('secret-invite-token')
    const factCall = queryMock.mock.calls.find(([query]) => query.includes('INSERT INTO public.bento_event_dispatches'))!
    expect(factCall[1][2]).toBe(`user:${recipientUserId}`)
    expect(factCall[1][5]).toBe(providerAcceptedAt)
    expect(JSON.parse(factCall[1][6])).toEqual({
      kind: 'existing',
      orgId,
      invitationId: '24',
      userId: recipientUserId,
      generation: orgInvitationId,
      tokenCreatedAt: null,
    })
  })

  it.each([
    { sent_at: '2026-10-01T10:00:00Z' },
    { is_pending: false },
  ])('acknowledges an already sent or obsolete organization invite without sending it', async (overrides) => {
    mockInvitation(overrides)
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('acknowledges a missing or superseded send generation without sending it', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('rolls back the organization email send marker when the provider fails so the queue can retry', async () => {
    sendMock.mockRejectedValueOnce(new Error('provider unavailable'))
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(500)
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK')
    expect(queryMock.mock.calls.some(([query]) => query.includes('UPDATE public.org_invitation_email_requests'))).toBe(false)
    expect(releaseMock).toHaveBeenCalledOnce()
  })

  it('rejects a malformed organization send generation before using the database or sending', async () => {
    const response = await postSendEmail({ org_invitation_id: 'not-a-uuid' })
    expect(response.status).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
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

  it('sends a code-only account-deletion email when the magiclink redirect carries the deletion purpose', async () => {
    const response = await postSendEmail({
      user: { email: 'user@example.com' },
      email_data: {
        email_action_type: 'magiclink',
        redirect_to: 'https://console.capgo.app/?reason=delete_account',
        token: '847291',
        token_hash: 'magic-hash',
      },
    })

    expect(response.status).toBe(200)
    const { subject, html, text } = sendMock.mock.calls[0]![0] as { subject: string, html: string, text: string }
    expect(subject).toBe('Your code to continue account deletion')
    expect(html).toContain('847291')
    expect(text).toContain('847291')
    expect(html).toContain('please change your Capgo password immediately')
    expect(text).toContain('please change your Capgo password immediately')
    expect(html).toContain('font-size:15px')
    expect(html).toContain('border-top:1px solid #dbe4ef')
    expect(html).not.toContain('<a ')
    expect(text).not.toContain('https://')
  })

  it('sends a code-only 2FA setup email when the magiclink redirect carries the 2FA purpose', async () => {
    const response = await postSendEmail({
      user: { email: 'user@example.com' },
      email_data: {
        email_action_type: 'magiclink',
        redirect_to: 'https://console.capgo.app/?reason=setup_2fa',
        token: '847291',
        token_hash: 'magic-hash',
      },
    })

    expect(response.status).toBe(200)
    const { subject, html, text } = sendMock.mock.calls[0]![0] as { subject: string, html: string, text: string }
    expect(subject).toBe('Your code to continue 2FA setup')
    expect(html).toContain('847291')
    expect(text).toContain('847291')
    expect(html).toContain('Two-factor authentication will not be enabled')
    expect(text).toContain('Two-factor authentication will not be enabled')
    expect(html).toContain('font-size:15px')
    expect(html).toContain('border-top:1px solid #dbe4ef')
    expect(html).not.toContain('<a ')
    expect(text).not.toContain('https://')
  })

  it('keeps the generic sign-in email when the redirect is outside the site', async () => {
    const response = await postSendEmail({
      user: { email: 'user@example.com' },
      email_data: {
        email_action_type: 'magiclink',
        redirect_to: 'https://example.com/?reason=delete_account',
        token: '847291',
        token_hash: 'magic-hash',
      },
    })

    expect(response.status).toBe(200)
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Your Capgo.app sign-in link' }))
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
