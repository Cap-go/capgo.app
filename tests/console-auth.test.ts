import { randomUUID } from 'node:crypto'
import { base32 } from '@better-auth/utils/base32'
import { createOTP } from '@better-auth/utils/otp'
import { Hono } from 'hono/tiny'
import { symmetricEncrypt } from 'better-auth/crypto'
import { TOTP } from 'otpauth'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { app as authRoutes } from '../supabase/functions/_backend/private/console_auth.ts'
import { app as dataRoutes } from '../supabase/functions/_backend/private/console_data.ts'
import { CONSOLE_SESSION_PREFIX, IMPORTED_TOTP_PREFIX, resolveConsoleSession } from '../supabase/functions/_backend/utils/console_auth.ts'
import type { MiddlewareKeyVariables } from '../supabase/functions/_backend/utils/hono.ts'
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

  async function request(path: string, body?: unknown, token?: string, cookie?: string) {
    return app.request(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`, ...(token ? { authorization: `Bearer ${CONSOLE_SESSION_PREFIX}${token}` } : {}), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { AUTH_EMAIL: { send: async (message: { to: string, text: string }) => { messages.push(message) } } })
  }

  async function signup() {
    const email = `console-auth-${randomUUID()}@example.com`
    const response = await request('/auth/sign-up/email', { email, password, name: 'Console Auth Test' })
    expect(response.status, await response.clone().text()).toBe(200)
    const result = await response.json() as { token: string, user: { id: string } }
    ids.push(result.user.id)
    return { ...result, email } as { token: string, user: { id: string }, email: string }
  }

  beforeAll(() => {
    vi.stubEnv('SUPABASE_DB_URL', POSTGRES_URL)
    vi.stubEnv('CONSOLE_AUTH_URL', base)
    vi.stubEnv('WEBAPP_URL', base)
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
    }
  })

  it('owns login, keeps identity IDs, and enforces caller RLS', async () => {
    const first = await signup()
    const second = await signup()
    const login = await request('/auth/sign-in/email', { email: first.email, password })
    expect(login.status).toBe(200)
    const session = await login.json() as { token: string, user: { id: string } }
    expect(session.user.id).toBe(first.user.id)
    const query = await request('/private/console/query', {
      kind: 'table', name: 'users', args: [], operations: [{ method: 'select', args: ['id'] }, { method: 'in', args: ['id', [first.user.id, second.user.id]] }],
    }, session.token)
    expect(query.status).toBe(200)
    const rows = await query.json() as { error: unknown, data: { id: string }[] }
    expect(rows.error).toBeNull()
    expect(rows.data).toEqual([{ id: first.user.id }])
    const database = new Pool({ connectionString: POSTGRES_URL })
    try {
      const legacy = await database.query('SELECT encrypted_password FROM auth.users WHERE id = $1', [first.user.id])
      expect(legacy.rows[0].encrypted_password).toMatch(/^\$2/)
    }
    finally { await database.end() }
    expect((await request('/auth/sign-in/email', { email: first.email, password: 'incorrect-password' })).status).toBe(401)
    expect((await request('/auth/sign-out', {}, session.token)).status).toBe(200)
    expect(await (await request('/auth/console-session', undefined, session.token)).json()).toEqual({ session: null })
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
    expect((await challenge.json() as { user: { id: string } }).user.id).toBe(account.user.id)
  })

  it('rejects banned identities and never falls back from a bad bearer to cookies', async () => {
    const account = await signup()
    const login = await request('/auth/sign-in/email', { email: account.email, password })
    const cookie = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
    expect(await (await request('/auth/console-session', undefined, 'invalid.signed-token', cookie)).json()).toEqual({ session: null })
    const database = new Pool({ connectionString: POSTGRES_URL })
    try {
      await database.query("UPDATE auth.users SET banned_until = now() + interval '1 hour' WHERE id = $1", [account.user.id])
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
        await connection.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: account.user.id, auth_provider: 'better-auth', role: 'authenticated', aal })])
        expect((await connection.query('SELECT public.verify_mfa() AS allowed')).rows[0].allowed).toBe(expected)
      }
      await connection.query('SAVEPOINT credential_read')
      await expect(connection.query('SELECT password FROM public.console_auth_account')).rejects.toMatchObject({ code: '42501' })
      await connection.query('ROLLBACK TO SAVEPOINT credential_read')
      await connection.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: randomUUID(), auth_provider: 'better-auth', role: 'authenticated', aal: 'aal1' })])
      expect((await connection.query('SELECT public.verify_mfa() AS allowed')).rows[0].allowed).toBe(false)
    }
    finally {
      await connection.query('ROLLBACK')
      connection.release()
      await database.end()
    }
  })
})
