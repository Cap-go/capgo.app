import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
import { randomUUID } from 'node:crypto'
import { base32 } from '@better-auth/utils/base32'
import { createOTP } from '@better-auth/utils/otp'
import { symmetricEncrypt } from 'better-auth/crypto'
import { Hono } from 'hono/tiny'
import { TOTP } from 'otpauth'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { app as authRoutes } from '../supabase/functions/_backend/private/console_auth.ts'
import { app as dataRoutes } from '../supabase/functions/_backend/private/console_data.ts'
import { CONSOLE_SESSION_PREFIX, IMPORTED_TOTP_PREFIX, resolveConsoleSession } from '../supabase/functions/_backend/utils/console_auth.ts'
import { POSTGRES_URL } from './test-utils.ts'

describe('console Better Auth', () => {
  const app = new Hono<MiddlewareKeyVariables>()
  const messages: { to: string, text: string }[] = []
  const ids: string[] = []
  const password = 'Console-test-password1!'
  const base = 'http://localhost:5173'
  app.use('*', async (c, next) => {
    c.set('resolveConsoleSession', authorization => resolveConsoleSession(c, authorization))
    await next()
  })
  app.route('/auth', authRoutes)
  app.route('/private/console', dataRoutes)

  async function request(path: string, body?: unknown, token?: string, cookie?: string, origin = base) {
    return app.request(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`, ...(token ? { authorization: `Bearer ${CONSOLE_SESSION_PREFIX}${token}` } : {}), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { AUTH_EMAIL: { send: async (message: { to: string, text: string }) => { messages.push(message) } } })
  }

  async function signup() {
    const email = `console-auth-${randomUUID()}@example.com`
    const response = await request('/auth/sign-up/email', { email, password, name: 'Console Auth Test', registration_device_type: 'mobile', registration_browser: 'Firefox', registration_os: 'Android', website_design_experiment: 'website-design-test', website_design_visitor_id: 'fake-visitor', website_design_variant: 'test', website_design_anonymous_id: 'a'.repeat(100) }, undefined, undefined, 'https://capgo.app')
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://capgo.app')
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const result = await response.json() as { token: string, user: { id: string } }
    ids.push(result.user.id)
    return { ...result, email, cookie } as { token: string, user: { id: string }, email: string, cookie: string }
  }

  beforeAll(() => {
    vi.stubGlobal('EdgeRuntime', { waitUntil: (task: Promise<unknown>) => {
      void task.catch(() => {})
    } })
    vi.stubEnv('SUPABASE_DB_URL', POSTGRES_URL)
    vi.stubEnv('CONSOLE_AUTH_URL', base)
    vi.stubEnv('WEBAPP_URL', base)
    vi.stubEnv('CONSOLE_TRUSTED_ORIGINS', 'https://capgo.app')
    vi.stubEnv('BETTER_AUTH_SECRET', 'console-auth-test-secret-at-least-32-characters')
    vi.stubEnv('CONSOLE_REQUIRE_EMAIL_VERIFICATION', 'false')
    vi.stubEnv('CONSOLE_SMTP_URL', '')
    vi.stubEnv('CAPTCHA_SECRET_KEY', '')
  })
  afterAll(async () => {
    const database = new Pool({ connectionString: POSTGRES_URL })
    try {
      await database.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [ids])
    }
    finally {
      await database.end()
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  it('owns login, keeps identity IDs, and enforces caller RLS', async () => {
    const first = await signup()
    const second = await signup()
    const cookieSession = await (await request('/auth/console-session', undefined, undefined, first.cookie)).json() as { session: { user: { id: string } } }
    expect(cookieSession.session.user.id).toBe(first.user.id)
    const login = await request('/auth/sign-in/email', { email: first.email, password })
    expect(login.status).toBe(200)
    const session = await login.json() as { token: string, user: { id: string } }
    expect(session.user.id).toBe(first.user.id)
    const query = await request('/private/console/query', {
      kind: 'table',
      name: 'users',
      args: [],
      operations: [{ method: 'select', args: ['id'] }, { method: 'in', args: ['id', [first.user.id, second.user.id]] }],
    }, session.token)
    expect(query.status).toBe(200)
    const rows = await query.json() as { error: unknown, data: { id: string }[] }
    expect(rows.error).toBeNull()
    expect(rows.data).toEqual([{ id: first.user.id }])
    const database = new Pool({ connectionString: POSTGRES_URL })
    try {
      const legacy = await database.query('SELECT encrypted_password FROM auth.users WHERE id = $1', [first.user.id])
      expect(legacy.rows[0].encrypted_password).toMatch(/^\$2/)
      const metadata = await database.query('SELECT raw_user_meta_data FROM auth.users WHERE id = $1', [first.user.id])
      expect(metadata.rows[0].raw_user_meta_data.registration_device_type).toBe('mobile')
      expect(metadata.rows[0].raw_user_meta_data.website_design_anonymous_id).toBe('a'.repeat(100))
      const authSession = await (await request('/auth/console-session', undefined, session.token)).json() as { session: { user: { user_metadata: Record<string, string> } } }
      expect(authSession.session.user.user_metadata.website_design_visitor_id).toBe('fake-visitor')
    }
    finally { await database.end() }
    expect((await request('/auth/sign-in/email', { email: first.email, password: 'incorrect-password' })).status).toBe(401)
    expect((await request('/auth/sign-out', {}, session.token)).status).toBe(200)
    expect(await (await request('/auth/console-session', undefined, session.token)).json()).toEqual({ session: null })
  })

  it('accepts an invitation with its reserved identity and rolls back failed membership', async () => {
    const owner = await signup()
    const database = new Pool({ connectionString: POSTGRES_URL })
    const orgId = randomUUID()
    const invitedId = randomUUID()
    const rejectedId = randomUUID()
    ids.push(invitedId, rejectedId)
    const magic = randomUUID()
    const rejectedMagic = randomUUID()
    try {
      await database.query('INSERT INTO public.orgs (id, name, management_email, created_by) VALUES ($1, $2, $3, $4)', [orgId, 'Console Invitation Test', owner.email, owner.user.id])
      for (const [id, token, role] of [[invitedId, magic, 'org_member'], [rejectedId, rejectedMagic, 'missing_test_role']]) {
        await database.query(`INSERT INTO public.tmp_users (email, org_id, future_uuid, invite_magic_string, first_name, last_name, rbac_role_name)
          VALUES ($1, $2, $3, $4, 'Invited', 'Test', $5)`, [`console-invite-${id}@example.com`, orgId, id, token, role])
      }
      const accepted = await request('/auth/console-accept-invitation', { magic_invite_string: magic, password, opt_for_newsletters: false })
      expect(accepted.status, await accepted.clone().text()).toBe(200)
      const { access_token } = await accepted.json() as { access_token: string }
      const session = await (await request('/auth/console-session', undefined, access_token.replace(CONSOLE_SESSION_PREFIX, ''))).json() as { session: { user: { id: string } } }
      expect(session.session.user.id).toBe(invitedId)
      expect((await database.query('SELECT created_via_invite FROM public.users WHERE id = $1', [invitedId])).rows[0].created_via_invite).toBe(true)
      expect((await database.query('SELECT is_invite FROM public.org_users WHERE user_id = $1 AND org_id = $2', [invitedId, orgId])).rows[0].is_invite).toBe(false)
      expect((await database.query('SELECT id FROM public.tmp_users WHERE invite_magic_string = $1', [magic])).rows).toHaveLength(0)
      const rejected = await request('/auth/console-accept-invitation', { magic_invite_string: rejectedMagic, password, opt_for_newsletters: false })
      expect(rejected.status).toBe(500)
      expect((await database.query('SELECT id FROM public.console_auth_user WHERE id = $1', [rejectedId])).rows).toHaveLength(0)
      expect((await database.query('SELECT id FROM auth.users WHERE id = $1', [rejectedId])).rows).toHaveLength(0)
      expect((await database.query('SELECT id FROM public.tmp_users WHERE invite_magic_string = $1', [rejectedMagic])).rows).toHaveLength(1)
    }
    finally {
      await database.query('DELETE FROM public.tmp_users WHERE org_id = $1', [orgId])
      await database.query('DELETE FROM public.orgs WHERE id = $1', [orgId])
      await database.end()
    }
  })

  it('keeps the existing verified-email and recent-auth account removal contract', async () => {
    const account = await signup()
    const send = await request('/auth/email-otp/send-verification-otp', { email: account.email, type: 'email-verification' }, account.token)
    expect(send.status, await send.clone().text()).toBe(200)
    const otp = messages.findLast(message => message.to === account.email && message.text.startsWith('Your verification'))!.text.match(/\b\d{6}\b/)![0]
    expect((await request('/auth/console-verify-email', { token: otp }, account.token)).status).toBe(200)
    expect((await request('/auth/console-reauthenticate', { password }, account.token)).status).toBe(200)
    const removal = await request('/private/console/query', { kind: 'rpc', name: 'delete_user', args: [], operations: [] }, account.token)
    expect(removal.status).toBe(200)
    expect((await removal.json() as { error: unknown }).error).toBeNull()
  })

  it('reports invalid email OTP as a client error and records valid verification', async () => {
    const account = await signup()
    expect((await request('/auth/email-otp/send-verification-otp', { email: account.email, type: 'email-verification' }, account.token)).status).toBe(200)
    const message = messages.findLast(message => message.to === account.email && message.text.startsWith('Your verification code'))!
    const otp = message.text.match(/code is (\d+)/)![1]
    expect((await request('/auth/console-verify-email', { token: 'invalid' }, account.token)).status).toBe(400)
    const verified = await request('/auth/console-verify-email', { token: otp }, account.token)
    expect(verified.status, await verified.clone().text()).toBe(200)
    expect((await verified.json() as { verified_at: string }).verified_at).toBeTruthy()
  })

  it('requires TOTP after password recovery and revokes old sessions', async () => {
    const account = await signup()
    const enrollment = await request('/auth/two-factor/enable', { password }, account.token)
    expect(enrollment.status).toBe(200)
    const { totpURI, backupCodes } = await enrollment.json() as { totpURI: string, backupCodes: string[] }
    expect(backupCodes.length).toBeGreaterThan(0)
    const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get('secret')!))
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp()
    const enrollmentToken = enrollment.headers.get('set-auth-token') ?? account.token
    const verification = await request('/auth/two-factor/verify-totp', { code }, enrollmentToken)
    expect(verification.status, await verification.clone().text()).toBe(200)
    const verified = await verification.json() as { token: string }
    const session = await (await request('/auth/console-session', undefined, verification.headers.get('set-auth-token') ?? verified.token)).json() as { session: { mfa_verified: boolean, user: { factors: unknown[] } } }
    expect(session.session.mfa_verified).toBe(true)
    expect(session.session.user.factors).toHaveLength(1)
    const verifiedToken = verification.headers.get('set-auth-token') ?? verified.token
    expect((await request('/auth/console-reauthenticate', { password: 'incorrect-password' }, verifiedToken)).status).toBe(401)
    expect((await request('/auth/console-reauthenticate', { password }, verifiedToken)).status).toBe(200)
    expect((await (await request('/auth/console-session', undefined, verifiedToken)).json() as typeof session).session.mfa_verified).toBe(true)

    const reset = await request('/auth/request-password-reset', { email: account.email, redirectTo: `${base}/forgot_password` })
    expect(reset.status).toBe(200)
    const message = messages.findLast(message => message.to === account.email && message.text.startsWith('Reset'))!
    expect(message).toBeDefined()
    const url = new URL(message.text.split('Reset your password: ')[1])
    const resetToken = url.pathname.split('/').at(-1)!
    expect((await request('/auth/reset-password', { token: resetToken, newPassword: `${password}2` })).status).toBe(200)
    expect(await (await request('/auth/console-session', undefined, verified.token)).json()).toEqual({ session: null })
    const login = await request('/auth/sign-in/email', { email: account.email, password: `${password}2` })
    expect(login.status).toBe(200)
    expect((await login.json() as { twoFactorRedirect: boolean }).twoFactorRedirect).toBe(true)
    const cookie = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
    expect((await request('/auth/two-factor/verify-totp', { code: 'invalid' }, undefined, cookie)).status).toBe(401)
    const nextCode = await createOTP(secret, { digits: 6, period: 30 }).totp()
    const challenge = await request('/auth/two-factor/verify-totp', { code: nextCode }, undefined, cookie)
    expect(challenge.status).toBe(200)
    const authenticated = await challenge.json() as { user: { id: string }, token: string }
    expect(authenticated.user.id).toBe(account.user.id)
    const deletionToken = challenge.headers.get('set-auth-token') ?? authenticated.token
    expect((await request('/auth/email-otp/send-verification-otp', { email: account.email, type: 'email-verification' }, deletionToken)).status).toBe(200)
    const emailCode = messages.findLast(message => message.to === account.email && message.text.startsWith('Your verification'))!.text.match(/\b\d{6}\b/)![0]
    expect((await request('/auth/console-verify-email', { token: emailCode }, deletionToken)).status).toBe(200)
    expect((await request('/auth/console-reauthenticate', { password: `${password}2` }, deletionToken)).status).toBe(200)
    const removal = await request('/private/console/query', { kind: 'rpc', name: 'delete_user', args: [], operations: [] }, deletionToken)
    expect(removal.status, await removal.clone().text()).toBe(200)
    expect((await removal.json() as { error: unknown }).error).toBeNull()
  })

  it('rejects banned identities and never falls back from a bad bearer to cookies', async () => {
    const account = await signup()
    const login = await request('/auth/sign-in/email', { email: account.email, password })
    const cookie = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
    expect(await (await request('/auth/console-session', undefined, 'invalid.signed-token', cookie)).json()).toEqual({ session: null })
    const database = new Pool({ connectionString: POSTGRES_URL })
    try {
      await database.query('UPDATE auth.users SET banned_until = now() + interval \'1 hour\' WHERE id = $1', [account.user.id])
    }
    finally { await database.end() }
    expect(await (await request('/auth/console-session', undefined, account.token)).json()).toEqual({ session: null })
    expect((await request('/auth/sign-in/email', { email: account.email, password })).status).toBe(403)
    expect((await request('/auth/change-password', { currentPassword: password, newPassword: `${password}3` }, account.token)).status).toBe(403)
  })

  it('preserves imported binary TOTP secrets and rejects codes for the wrong encoding', async () => {
    const account = await signup()
    const totp = new TOTP({ secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 })
    const storedSecret = `${IMPORTED_TOTP_PREFIX}${totp.secret.base32}`
    const database = new Pool({ connectionString: POSTGRES_URL })
    try {
      await database.query('UPDATE public.console_auth_user SET "twoFactorEnabled" = true WHERE id = $1', [account.user.id])
      await database.query(`INSERT INTO public.console_auth_two_factor (id, "userId", secret, "backupCodes", verified)
        VALUES ($1, $2, $3, $4, true)`, [randomUUID(), account.user.id, await symmetricEncrypt({ key: 'console-auth-test-secret-at-least-32-characters', data: storedSecret }), await symmetricEncrypt({ key: 'console-auth-test-secret-at-least-32-characters', data: '[]' })])
    }
    finally { await database.end() }
    const login = await request('/auth/sign-in/email', { email: account.email, password })
    expect((await login.json() as { twoFactorRedirect: boolean }).twoFactorRedirect).toBe(true)
    const cookie = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
    const wrongEncoding = await createOTP(storedSecret).totp()
    expect((await request('/auth/two-factor/verify-totp', { code: wrongEncoding }, undefined, cookie)).status).toBe(401)
    const verified = await request('/auth/two-factor/verify-totp', { code: totp.generate() }, undefined, cookie)
    expect(verified.status, await verified.clone().text()).toBe(200)
    const result = await verified.json() as { token: string }
    const session = await (await request('/auth/console-session', undefined, result.token)).json() as { session: { mfa_verified: boolean } }
    expect(session.session.mfa_verified).toBe(true)
    expect((await request('/auth/two-factor/verify-totp', { code: totp.generate() }, undefined, cookie)).status).toBe(401)
  })

  it('enforces the signed MFA claim in RLS and denies direct credential reads', async () => {
    const account = await signup()
    const database = new Pool({ connectionString: POSTGRES_URL })
    const connection = await database.connect()
    try {
      await connection.query('BEGIN')
      await connection.query('UPDATE public.console_auth_user SET "twoFactorEnabled" = true WHERE id = $1', [account.user.id])
      await connection.query('SET LOCAL ROLE authenticated')
      for (const [aal, expected] of [['aal1', false], ['aal2', true]] as const) {
        await connection.query('SELECT set_config(\'request.jwt.claims\', $1, true)', [JSON.stringify({ sub: account.user.id, auth_provider: 'better-auth', role: 'authenticated', aal })])
        expect((await connection.query('SELECT public.verify_mfa() AS allowed')).rows[0].allowed).toBe(expected)
      }
      await connection.query('SAVEPOINT credential_read')
      await expect(connection.query('SELECT password FROM public.console_auth_account')).rejects.toMatchObject({ code: '42501' })
      await connection.query('ROLLBACK TO SAVEPOINT credential_read')
      await connection.query('SELECT set_config(\'request.jwt.claims\', $1, true)', [JSON.stringify({ sub: randomUUID(), auth_provider: 'better-auth', role: 'authenticated', aal: 'aal1' })])
      expect((await connection.query('SELECT public.verify_mfa() AS allowed')).rows[0].allowed).toBe(false)
    }
    finally {
      await connection.query('ROLLBACK')
      connection.release()
      await database.end()
    }
  })
})
