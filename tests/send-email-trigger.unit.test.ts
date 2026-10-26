import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock, queryMock, releaseMock, logMock, runtimeMock, bentoConfiguredMock, trackBentoEventsMock, updateBentoFieldsMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async (_message: unknown) => ({ messageId: 'message-id' })),
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  logMock: vi.fn(),
  runtimeMock: vi.fn(() => 'node'),
  bentoConfiguredMock: vi.fn(() => true),
  trackBentoEventsMock: vi.fn(async (..._args: unknown[]): Promise<boolean | undefined> => true),
  updateBentoFieldsMock: vi.fn(async (..._args: unknown[]): Promise<boolean | undefined> => true),
}))

vi.mock('../supabase/functions/_backend/utils/bento.ts', async () => ({
  ...await vi.importActual('../supabase/functions/_backend/utils/bento.ts'),
  isBentoConfigured: bentoConfiguredMock,
  trackBentoEvents: trackBentoEventsMock,
  updateBentoFields: updateBentoFieldsMock,
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
const otherInvitationId = '0d6f3a1e-7c2b-4f0a-9a8e-2b5c6d7e8f90'
const orgId = '984c9e7d-797a-4c6e-a2ea-b78dbebf1d78'
const recipientUserId = 'c72447f3-0498-4d55-8a95-464e2c4b804f'
const providerAcceptedAt = '2026-10-03 10:00:00.234567+00'
const invitation = {
  id: orgInvitationId,
  org_id: orgId,
  recipient_user_id: null as string | null,
  org_user_id: null as number | null,
  tmp_user_id: 42 as number | null,
  sent_at: null as string | null,
  bento_synced_at: null as string | null,
  bento_email: null as string | null,
  is_pending: true,
  email: 'invitee@example.com',
  first_name: 'Alex',
  last_name: '',
  org_name: 'Example & Team',
  org_admin_name: 'Pat Admin',
  invite_magic_string: 'secret-invite-token' as string | null,
}

// Stateful stand-in for the request row: the email transaction's sent_at
// update is visible to the Bento transaction that follows it.
function mockInvitation(overrides: Partial<typeof invitation> = {}, openInvites = [orgInvitationId]) {
  let row = { ...invitation, ...overrides }
  queryMock.mockImplementation(async (query: string, params?: unknown[]) => {
    if (query.includes('SET bento_email')) {
      row = { ...row, bento_email: params![1] as string }
      return { rows: [], rowCount: 1 }
    }
    if (query.includes('SET sent_at')) {
      row = { ...row, sent_at: providerAcceptedAt }
      return { rows: [], rowCount: 1 }
    }
    if (query.includes('SET bento_synced_at')) {
      row = { ...row, bento_synced_at: providerAcceptedAt }
      return { rows: [], rowCount: 1 }
    }
    if (query.includes('r.bento_email = $1'))
      return { rows: openInvites.map(id => ({ id })) }
    if (query.includes('SELECT r.id,'))
      return { rows: [row] }
    return { rows: [], rowCount: 1 }
  })
}

function sqlIndex(fragment: string) {
  return queryMock.mock.calls.findIndex(([query]) => String(query).includes(fragment))
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
    trackBentoEventsMock.mockReset().mockResolvedValue(true)
    updateBentoFieldsMock.mockReset().mockResolvedValue(true)
    runtimeMock.mockReturnValue('node')
    bentoConfiguredMock.mockReturnValue(true)
    mockInvitation()
  })

  it('sends a new-account organization invite, then starts its Bento reminder flow', async () => {
    mockInvitation({}, [otherInvitationId, orgInvitationId])
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
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('SET sent_at'), [orgInvitationId, 'message-id'])
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['invitee@example.com'])
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('r.bento_email = $1'), ['invitee@example.com', orgInvitationId])
    expect(trackBentoEventsMock).toHaveBeenCalledOnce()
    expect(trackBentoEventsMock).toHaveBeenCalledWith(expect.anything(), 'invitee@example.com', [{
      event: 'org:invite_sent',
      data: {
        invite_id: orgInvitationId,
        kind: 'new',
        org_id: orgId,
        org_name: 'Example &amp; Team',
        org_name_subject: 'Example & Team',
        org_admin_name: 'Pat Admin',
        invited_first_name: 'Alex',
        invited_last_name: '',
        invite_link: 'https://console.capgo.app/invitation?invite_magic_string=secret-invite-token',
      },
      fields: { capgo_open_invites: `${otherInvitationId} ${orgInvitationId}` },
    }], expect.any(AbortSignal))
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('SET bento_synced_at'), [orgInvitationId, 'invitee@example.com'])
    // The email commits before Bento is contacted, so a Bento failure never resends it.
    const emailCommit = sqlIndex('COMMIT')
    expect(emailCommit).toBeGreaterThan(sqlIndex('SET sent_at'))
    expect(emailCommit).toBeLessThan(sqlIndex('pg_advisory_xact_lock'))
    expect(queryMock.mock.invocationCallOrder[emailCommit]).toBeLessThan(trackBentoEventsMock.mock.invocationCallOrder[0]!)
    expect(JSON.stringify(logMock.mock.calls)).toContain('message-id')
    expect(JSON.stringify(logMock.mock.calls)).not.toContain('secret-invite-token')
    expect(JSON.stringify(logMock.mock.calls)).not.toContain('invitee@example.com')
    const targetCommit = queryMock.mock.calls.findIndex(([query], index) => index > sqlIndex('SET bento_email') && query === 'COMMIT')
    expect(targetCommit).toBeGreaterThan(sqlIndex('SET bento_email'))
    expect(queryMock.mock.invocationCallOrder[targetCommit]).toBeLessThan(trackBentoEventsMock.mock.invocationCallOrder[0]!)
    const subscriberLock = sqlIndex('pg_advisory_xact_lock')
    const enrollmentRead = queryMock.mock.calls.findIndex(([query], index) => index > subscriberLock && query.includes('SELECT r.id,'))
    expect(enrollmentRead).toBeGreaterThan(subscriberLock)
    expect(queryMock.mock.calls[enrollmentRead]![0]).not.toContain('FOR UPDATE')
    expect(queryMock.mock.invocationCallOrder[enrollmentRead]).toBeLessThan(trackBentoEventsMock.mock.invocationCallOrder[0]!)
    expect(queryMock.mock.calls.slice(subscriberLock).some(([query]) => query.includes('FOR UPDATE'))).toBe(false)
    expect(releaseMock).toHaveBeenCalledTimes(3)
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
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('SET sent_at'), [orgInvitationId, 'message-id'])
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('SET bento_synced_at'), [orgInvitationId, 'invitee@example.com'])
  })

  it('sends an existing-account organization invite and starts the existing-user flow', async () => {
    mockInvitation({ org_user_id: 24, tmp_user_id: null, recipient_user_id: recipientUserId, invite_magic_string: null })
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      subject: '[Capgo]: Join Example & Team with your account',
    }))
    const content = sendMock.mock.calls[0]![0] as { html: string, text: string }
    expect(content.html).toContain(`/dashboard?invite_org=${orgId}`)
    expect(content.text).toContain('with your existing account')
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('r.bento_email = $1'), ['invitee@example.com', orgInvitationId])
    const [, email, events] = trackBentoEventsMock.mock.calls[0]!
    expect(email).toBe('invitee@example.com')
    expect(events).toEqual([expect.objectContaining({
      event: 'org:invite_sent',
      data: expect.objectContaining({ kind: 'existing', invite_link: `https://console.capgo.app/dashboard?invite_org=${orgId}` }),
      fields: { capgo_open_invites: orgInvitationId },
    })])
  })

  it('retries only the Bento flow when the email was already sent', async () => {
    mockInvitation({ sent_at: providerAcceptedAt })
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sendMock).not.toHaveBeenCalled()
    expect(trackBentoEventsMock).toHaveBeenCalledOnce()
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('SET bento_synced_at'), [orgInvitationId, 'invitee@example.com'])
  })

  it('uses one normalized Bento subscriber for differently cased invitation addresses', async () => {
    mockInvitation({ email: 'Invitee@Example.COM', sent_at: providerAcceptedAt })
    expect((await postSendEmail({ org_invitation_id: orgInvitationId })).status).toBe(200)
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['invitee@example.com'])
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('r.bento_email = $1'), ['invitee@example.com', orgInvitationId])
    expect(trackBentoEventsMock.mock.calls[0]![1]).toBe('invitee@example.com')
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('SET bento_synced_at'), [orgInvitationId, 'invitee@example.com'])
  })

  it('retries an uncertain enrollment against its original subscriber after an account email change', async () => {
    mockInvitation({ email: 'changed@example.com', bento_email: 'original@example.com', sent_at: providerAcceptedAt })
    expect((await postSendEmail({ org_invitation_id: orgInvitationId })).status).toBe(200)
    expect(trackBentoEventsMock.mock.calls[0]![1]).toBe('original@example.com')
  })

  it.each([
    { sent_at: providerAcceptedAt, bento_synced_at: providerAcceptedAt },
    { is_pending: false },
  ])('acknowledges a finished or obsolete organization invite without email or Bento', async (overrides) => {
    mockInvitation(overrides)
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sendMock).not.toHaveBeenCalled()
    expect(trackBentoEventsMock).not.toHaveBeenCalled()
  })

  it('acknowledges a missing or superseded send generation without sending it', async () => {
    queryMock.mockResolvedValue({ rows: [] })
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sendMock).not.toHaveBeenCalled()
    expect(trackBentoEventsMock).not.toHaveBeenCalled()
  })

  it('rolls back the organization email send marker when the provider fails so the queue can retry', async () => {
    sendMock.mockRejectedValueOnce(new Error('provider unavailable'))
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(500)
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK')
    expect(sqlIndex('SET sent_at')).toBe(-1)
    expect(trackBentoEventsMock).not.toHaveBeenCalled()
    expect(releaseMock).toHaveBeenCalledOnce()
  })

  it('keeps the sent email but fails the delivery when Bento rejects the flow event', async () => {
    trackBentoEventsMock.mockResolvedValueOnce(false)
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(500)
    expect(sendMock).toHaveBeenCalledOnce()
    expect(sqlIndex('SET sent_at')).toBeGreaterThan(-1)
    expect(sqlIndex('SET bento_synced_at')).toBe(-1)
  })

  it('skips the Bento event when the invitation closed before enrollment', async () => {
    mockInvitation({}, [otherInvitationId])
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sendMock).toHaveBeenCalledOnce()
    expect(trackBentoEventsMock).not.toHaveBeenCalled()
    expect(sqlIndex('SET bento_synced_at')).toBe(-1)
  })

  it('does not mark the flow started when Bento is not configured', async () => {
    bentoConfiguredMock.mockReturnValueOnce(false)
    const response = await postSendEmail({ org_invitation_id: orgInvitationId })
    expect(response.status).toBe(200)
    expect(sqlIndex('SET bento_synced_at')).toBe(-1)
    expect(sqlIndex('SET bento_email')).toBe(-1)
    expect(trackBentoEventsMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed organization send generation before using the database or sending', async () => {
    const response = await postSendEmail({ org_invitation_id: 'not-a-uuid' })
    expect(response.status).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('rewrites a subscriber\'s open invites after an invitation closes', async () => {
    mockInvitation({}, [otherInvitationId])
    const response = await postSendEmail({ org_invitation_bento_sync: { email: 'invitee@example.com' } }, false)
    expect(response.status).toBe(200)
    expect(sqlIndex('pg_advisory_xact_lock')).toBeLessThan(sqlIndex('r.bento_email = $1'))
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('r.bento_email = $1'), ['invitee@example.com', null])
    expect(updateBentoFieldsMock).toHaveBeenCalledWith(expect.anything(), 'invitee@example.com', { capgo_open_invites: otherInvitationId }, expect.any(AbortSignal))
    expect(queryMock).toHaveBeenCalledWith('COMMIT')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('clears the field after a subscriber\'s last invitation closes', async () => {
    mockInvitation({}, [])
    const response = await postSendEmail({ org_invitation_bento_sync: { email: 'member@example.com' } }, false)
    expect(response.status).toBe(200)
    expect(updateBentoFieldsMock).toHaveBeenCalledWith(expect.anything(), 'member@example.com', { capgo_open_invites: '' }, expect.any(AbortSignal))
  })

  it.each([false, undefined])('retries a field sync without confirmed Bento acceptance (%s)', async (result) => {
    updateBentoFieldsMock.mockResolvedValueOnce(result)
    const response = await postSendEmail({ org_invitation_bento_sync: { email: 'invitee@example.com' } }, false)
    expect(response.status).toBe(500)
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK')
  })

  it.each([
    { email: '' },
    { email: '   ' },
    { email: 42 },
    {},
  ])('rejects a malformed Bento sync payload before using the database', async (recipient) => {
    const response = await postSendEmail({ org_invitation_bento_sync: recipient }, false)
    expect(response.status).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    expect(updateBentoFieldsMock).not.toHaveBeenCalled()
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
