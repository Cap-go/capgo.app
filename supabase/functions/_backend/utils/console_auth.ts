import type { Context } from 'hono'
import { sso } from '@better-auth/sso'
import { createOTP } from '@better-auth/utils/otp'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { symmetricDecrypt } from 'better-auth/crypto'
import { bearer, captcha, emailOTP, twoFactor } from 'better-auth/plugins'
import { compare, hash } from 'bcryptjs'
import { SignJWT } from 'jose'
import { TOTP } from 'otpauth'
import type { JWTClaims } from './hono.ts'
import { honoFactory } from './hono.ts'
import { getPasswordUtf8ByteLength } from './password_policy.ts'
import { getPgClient } from './pg.ts'
import { getEnv } from './utils.ts'

export const CONSOLE_SESSION_PREFIX = 'capgo_session_'
export const IMPORTED_TOTP_PREFIX = 'capgo-base32:'

/** Request-scoped pools must not retain another Worker's I/O context. */
export function createConsoleAuth(c: Context, provisionUserId?: string) {
  const database = getPgClient(c)
  const baseURL = getEnv(c, 'CONSOLE_AUTH_URL')
  const secret = getEnv(c, 'BETTER_AUTH_SECRET')
  const webURL = getEnv(c, 'WEBAPP_URL')
  if (!baseURL || secret.length < 32 || !webURL)
    throw new Error('Console auth requires CONSOLE_AUTH_URL, WEBAPP_URL, and BETTER_AUTH_SECRET')

  async function send(email: string, subject: string, text: string) {
    const smtpURL = getEnv(c, 'CONSOLE_SMTP_URL')
    if (smtpURL) {
      const { default: nodemailer } = await import('nodemailer')
      const transport = nodemailer.createTransport(smtpURL, { from: 'noreply@capgo.app' })
      try {
        await transport.sendMail({ to: email, subject, text })
      }
      finally {
        transport.close()
      }
      return
    }
    if (!c.env?.AUTH_EMAIL)
      throw new Error('Auth email delivery is not configured')
    await c.env.AUTH_EMAIL.send({ from: 'noreply@capgo.app', to: email, subject, text })
  }

  const auth = betterAuth({
    appName: 'Capgo',
    baseURL: `${baseURL.replace(/\/$/, '')}/auth`,
    basePath: '/auth',
    secret,
    database,
    trustedOrigins: [webURL, 'capacitor://localhost', 'ionic://localhost',
      ...getEnv(c, 'CONSOLE_TRUSTED_ORIGINS').split(',').map(origin => origin.trim()).filter(Boolean),
      ...(getEnv(c, 'ENV_NAME').endsWith('-local') ? ['http://localhost:*', 'http://127.0.0.1:*'] : [])],
    advanced: { database: { generateId: ({ model }) => model === 'user' && provisionUserId ? provisionUserId : crypto.randomUUID() } },
    user: {
      modelName: 'console_auth_user',
      additionalFields: {
        firstName: { type: 'string', required: false },
        lastName: { type: 'string', required: false },
        optForNewsletters: { type: 'boolean', required: false, defaultValue: false },
        userMetadata: { type: 'json', required: false, input: false },
        appMetadata: { type: 'json', required: false, input: false },
        migrationBlocked: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
      changeEmail: { enabled: true },
    },
    account: { modelName: 'console_auth_account', additionalFields: { providerProfile: { type: 'json', required: false, input: false } }, accountLinking: { enabled: false } },
    session: { modelName: 'console_auth_session', cookieCache: { enabled: false }, additionalFields: { mfaVerified: { type: 'boolean', input: false, required: false, defaultValue: false }, impersonatedBy: { type: 'string', input: false, required: false }, ssoProviderId: { type: 'string', input: false, required: false } } },
    verification: { modelName: 'console_auth_verification' },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: getEnv(c, 'CONSOLE_REQUIRE_EMAIL_VERIFICATION') !== 'false',
      minPasswordLength: 6,
      maxPasswordLength: 72,
      // Preserve bcrypt hashes during import; never store or export plaintext passwords.
      password: { hash: password => hash(password, 12), verify: ({ hash: digest, password }) => compare(password, digest) },
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) => send(user.email, 'Reset your Capgo password', `Reset your password: ${url}`),
    },
    emailVerification: {
      sendOnSignUp: getEnv(c, 'CONSOLE_REQUIRE_EMAIL_VERIFICATION') !== 'false',
      sendVerificationEmail: ({ user, url }) => send(user.email, 'Confirm your Capgo email', `Confirm your email: ${url}`),
    },
    rateLimit: { enabled: !(getEnv(c, 'ENV_NAME').endsWith('-local') && getEnv(c, 'CONSOLE_AUTH_E2E') === 'true'), storage: 'database', modelName: 'console_auth_rate_limit', window: 60, max: 30 },
    plugins: [
      bearer(),
      twoFactor({ issuer: 'Capgo', twoFactorTable: 'console_auth_two_factor', allowPasswordless: true, accountLockout: { maxFailedAttempts: 5 } }),
      emailOTP({
        disableSignUp: true,
        storeOTP: 'hashed',
        allowedAttempts: 5,
        sendVerificationOTP: ({ email, otp }) => send(email, 'Your Capgo verification code', `Your verification code is ${otp}. It expires in 5 minutes.`),
      }),
      sso({
        schema: { ssoProvider: { modelName: 'console_auth_sso_provider' } },
        providersLimit: 0,
        // Provider configuration stays on the existing org-authorized Capgo API.
        organizationProvisioning: { disabled: true },
        trustEmailVerified: false,
        resolveUser: async (input, context) => {
          const email = input.providerUser.email.trim().toLowerCase()
          const provider = await database.query(`SELECT 1 FROM public.sso_providers WHERE provider_id = $1
            AND domain = $2 AND status = 'active' AND dns_verified_at IS NOT NULL`, [input.providerId, email.split('@')[1]])
          if (!provider.rowCount)
            return { action: 'reject', code: 'provider_not_authorized' }
          const user = await context.database.findOne<{ id: string, emailVerified: boolean }>({ model: 'user', where: [{ field: 'email', value: email }] })
          if (user && !user.emailVerified)
            return { action: 'reject', code: 'unverified_existing_identity' }
          return user ? { action: 'link', userId: user.id, profile: 'preserve' } : { action: 'continue' }
        },
        provisionUserOnEveryLogin: true,
        provisionUser: async ({ user, userInfo, provider }) => {
          // Only protocol-verified attributes are saved for org role mapping.
          await database.query(`UPDATE public.console_auth_account SET "providerProfile" = $3::jsonb
            WHERE "userId" = $1 AND "providerId" = $2`, [user.id, provider.providerId, JSON.stringify(userInfo)])
        },
      }),
      ...(getEnv(c, 'CAPTCHA_SECRET_KEY') ? [captcha({ provider: 'cloudflare-turnstile', secretKey: getEnv(c, 'CAPTCHA_SECRET_KEY') })] : []),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const password = ctx.body?.newPassword ?? (ctx.path === '/sign-up/email' ? ctx.body?.password : undefined)
        if (typeof password === 'string' && getPasswordUtf8ByteLength(password) > 72)
          throw new APIError('BAD_REQUEST', { message: 'Password cannot exceed 72 UTF-8 bytes' })
        if (['/sign-in/email-otp', '/email-otp/reset-password', '/email-otp/request-password-reset', '/email-otp/change-email', '/email-otp/request-email-change'].includes(ctx.path))
          throw new APIError('FORBIDDEN', { message: 'Use the console authentication flow' })
        if (['/sso/register', '/sso/update-provider', '/sso/delete-provider', '/sso/request-domain-verification', '/sso/verify-domain'].includes(ctx.path))
          throw new APIError('FORBIDDEN', { message: 'Manage SSO through the organization API' })
        // Resolve through the bearer plugin without caching a null session
        // before that plugin has translated the Authorization header.
        const session = ctx.path === '/get-session' ? null : await auth.api.getSession({ headers: ctx.headers ?? ctx.request?.headers ?? new Headers() })
        if (ctx.path === '/two-factor/verify-totp') {
          const challengeCookie = ctx.context.createAuthCookie('two_factor')
          const challenge = session ? null : await ctx.getSignedCookie(challengeCookie.name, ctx.context.secret)
          const verification = challenge ? await ctx.context.internalAdapter.findVerificationValue(challenge) : null
          const userId = session?.user.id ?? verification?.value
          const factor = userId ? await ctx.context.adapter.findOne<{ secret: string }>({ model: 'console_auth_two_factor', where: [{ field: 'userId', value: userId }] }) : null
          if (factor) {
            const storedSecret = await symmetricDecrypt({ key: ctx.context.secretConfig, data: factor.secret })
            if (storedSecret.startsWith(IMPORTED_TOTP_PREFIX)) {
              // Supabase seeds are binary Base32; Better Auth uses UTF-8 seeds.
              // Translate only a library-validated legacy code, then let the
              // native endpoint enforce challenge consumption and lockouts.
              const valid = new TOTP({ secret: storedSecret.slice(IMPORTED_TOTP_PREFIX.length), digits: 6, period: 30 }).validate({ token: String(ctx.body?.code ?? ''), window: 1 }) !== null
              ctx.body.code = valid ? await createOTP(storedSecret).totp() : 'invalid-imported-code'
            }
          }
        }
        if (session) {
          const identity = await database.query('SELECT banned_until FROM auth.users WHERE id = $1::uuid', [session.user.id])
          if (session.user.migrationBlocked || !identity.rows[0] || (identity.rows[0].banned_until && new Date(identity.rows[0].banned_until) > new Date()))
            throw new APIError('FORBIDDEN', { message: 'Account is unavailable' })
        }
        if (session?.user.twoFactorEnabled && !session.session.mfaVerified
          && !['/get-session', '/sign-out', '/two-factor/verify-totp', '/two-factor/verify-backup-code'].includes(ctx.path))
          throw new APIError('FORBIDDEN', { message: 'Second-factor verification is required' })
        if (ctx.path === '/sign-up/email') {
          const email = String(ctx.body?.email ?? '').trim().toLowerCase()
          if (ctx.path === '/sign-up/email') {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))
            const hashedEmail = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
            const deleted = await database.query('SELECT public.is_not_deleted($1) AS allowed', [hashedEmail])
            if (!deleted.rows[0]?.allowed)
              throw new APIError('FORBIDDEN', { message: 'Account registration is unavailable' })
          }
          const result = await database.query(
            `SELECT 1 FROM public.sso_providers WHERE domain = $1 AND enforce_sso AND status = 'active' LIMIT 1`,
            [email.split('@')[1] ?? ''],
          )
          if (result.rowCount)
            throw new APIError('FORBIDDEN', { message: 'This organization requires SSO' })
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (['/two-factor/verify-totp', '/two-factor/verify-backup-code'].includes(ctx.path) && ctx.context.returned && !(ctx.context.returned instanceof APIError)) {
          const session = ctx.context.newSession ?? ctx.context.session
          if (session)
            await database.query('UPDATE public.console_auth_session SET "mfaVerified" = true WHERE id = $1', [session.session.id])
        }
      }),
    },
    databaseHooks: {
      account: {
        create: { after: async (account) => {
          if (account.providerId === 'credential' && account.password)
            await database.query('UPDATE auth.users SET encrypted_password = $2 WHERE id = $1::uuid', [account.userId, account.password])
        } },
        update: { after: async (account) => {
          if (account.providerId === 'credential' && account.password) {
            await database.query('UPDATE auth.users SET encrypted_password = $2, updated_at = now() WHERE id = $1::uuid', [account.userId, account.password])
            await database.query('DELETE FROM public.user_password_compliance WHERE user_id = $1::uuid', [account.userId])
          }
        } },
      },
      user: {
        update: { after: async (user, ctx) => {
          await database.query('UPDATE auth.users SET email = $2, email_confirmed_at = $3, updated_at = now() WHERE id = $1::uuid', [user.id, user.email, user.emailVerified ? user.updatedAt : null])
          if (ctx?.path === '/two-factor/disable' && !user.twoFactorEnabled)
            await database.query('DELETE FROM auth.mfa_factors WHERE user_id = $1::uuid', [user.id])
        } },
        create: {
          before: async (user, ctx) => {
            if (ctx?.path === '/sign-up/email') {
              const metadata: Record<string, string> = {}
              for (const key of ['registration_device_type', 'registration_os', 'registration_browser']) {
                const value = ctx.body?.[key]
                if (typeof value === 'string' && value.length <= 64)
                  metadata[key] = value
              }
              return { data: { ...user, userMetadata: metadata } }
            }
            if (ctx?.path.startsWith('/sso/') && ctx.params?.providerId) {
              const provider = await database.query(`SELECT 1 FROM public.sso_providers
                WHERE provider_id = $1 AND domain = $2 AND status = 'active' AND dns_verified_at IS NOT NULL`, [ctx.params.providerId, user.email.split('@')[1]])
              if (!provider.rowCount)
                throw new APIError('FORBIDDEN', { message: 'SSO provider is not authorized for this domain' })
              // A signed IdP assertion from the verified domain proves the email.
              return { data: { ...user, emailVerified: true } }
            }
          },
          after: async (user, ctx) => {
            const ssoProviderId = ctx?.params?.providerId
            const isSso = !!ssoProviderId && ctx?.path.startsWith('/sso/')
            // Preserve the current DB foreign keys until the database migration.
            // Better Auth owns credentials and sessions; this row is identity only.
            await database.query(`INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, email_confirmed_at)
              VALUES ($1::uuid, $2, 'authenticated', 'authenticated', $5::jsonb, $3::jsonb, $4, $4, $6, $7)
              ON CONFLICT (id) DO NOTHING`, [user.id, user.email, JSON.stringify({ ...(typeof user.userMetadata === 'object' && user.userMetadata !== null ? user.userMetadata : {}), name: user.name }), user.createdAt, JSON.stringify({ provider: isSso ? `sso:${ssoProviderId}` : 'email', providers: [isSso ? `sso:${ssoProviderId}` : 'email'] }), isSso, user.emailVerified ? user.createdAt : null])
            await database.query(`INSERT INTO public.users (id, email, first_name, last_name, enable_notifications, opt_for_newsletters)
              VALUES ($1::uuid, $2, $3, $4, true, $5) ON CONFLICT (id) DO NOTHING`, [user.id, user.email, user.firstName ?? '', user.lastName ?? '', user.optForNewsletters ?? false])
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            // Use Better Auth's transaction adapter: a newly created user is
            // not visible to a separate pool until the signup commits.
            const adapter = ctx?.context.internalAdapter ?? (await auth.$context).internalAdapter
            const user = await adapter.findUserById(session.userId) as { email: string, migrationBlocked?: boolean } | null
            const result = await database.query('SELECT banned_until FROM auth.users WHERE id = $1::uuid', [session.userId])
            // Existing MFA accounts stay locked until their second factor is migrated.
            if (!user || user.migrationBlocked || (result.rows[0]?.banned_until && new Date(result.rows[0].banned_until) > new Date()))
              throw new APIError('FORBIDDEN', { message: 'Account migration requires second-factor recovery' })
            if (ctx?.path === '/sign-in/email') {
              const provider = await database.query(`SELECT org_id FROM public.sso_providers
                WHERE domain = $1 AND enforce_sso AND status = 'active' LIMIT 1`, [user.email.split('@')[1]])
              if (provider.rowCount) {
                // Preserve the existing authorized break-glass login, only
                // after Better Auth has verified the account's password.
                const permission = await database.query(`SELECT public.rbac_check_permission_direct(
                  'org.update_billing', $1::uuid, $2::uuid, NULL, NULL) AS allowed`, [session.userId, provider.rows[0].org_id])
                if (!permission.rows[0]?.allowed)
                  throw new APIError('FORBIDDEN', { message: 'This organization requires SSO' })
              }
            }
            return { data: { ...session, ssoProviderId: ctx?.path.startsWith('/sso/') ? ctx.params?.providerId : session.ssoProviderId, mfaVerified: ctx?.path === '/two-factor/verify-totp' || ctx?.path === '/two-factor/verify-backup-code' } }
          },
        },
      },
    },
  })
  return { auth, database, close: () => database.end() }
}

export function consoleAuthHeaders(headers: Headers): Headers {
  const result = new Headers(headers)
  const authorization = result.get('authorization')
  if (authorization?.startsWith('Bearer ') && authorization.slice(7).trim())
    result.delete('cookie')
  if (authorization?.startsWith(`Bearer ${CONSOLE_SESSION_PREFIX}`))
    result.set('authorization', `Bearer ${authorization.slice(7 + CONSOLE_SESSION_PREFIX.length)}`)
  return result
}

export async function getConsoleSession(instance: ReturnType<typeof createConsoleAuth>, headers: Headers) {
  const result = await instance.auth.api.getSession({ headers: consoleAuthHeaders(headers) })
  if (!result || result.user.migrationBlocked)
    return null
  const identity = await instance.database.query(`SELECT a.banned_until,
    EXISTS (SELECT 1 FROM public.platform_impersonation_sessions p WHERE p.session_id = $2::uuid
      AND p.target_user_id = a.id AND p.admin_user_id::text = $3 AND p.expires_at > now()) AS impersonating
    FROM auth.users a WHERE a.id = $1::uuid`, [result.user.id, result.session.id, result.session.impersonatedBy ?? null])
  const row = identity.rows[0]
  if (!row || (row.banned_until && new Date(row.banned_until) > new Date()))
    return null
  if (result.session.ssoProviderId) {
    const provider = await instance.database.query(`SELECT 1 FROM public.sso_providers
      WHERE provider_id = $1 AND domain = $2 AND status = 'active' AND dns_verified_at IS NOT NULL`, [result.session.ssoProviderId, result.user.email.split('@')[1]])
    if (!provider.rowCount)
      return null
  }
  return { ...result, mfaVerified: !!result.session.mfaVerified || !!row.impersonating }
}

export async function resolveConsoleSession(c: Context, authorization: string): Promise<JWTClaims | null> {
  const instance = createConsoleAuth(c)
  try {
    const headers = new Headers({ authorization })
    const result = await getConsoleSession(instance, headers)
    if (!result || (result.user.twoFactorEnabled && !result.mfaVerified))
      return null
    const { user, session } = result
    const claims: JWTClaims = {
      sub: user.id,
      email: user.email,
      role: 'authenticated',
      aal: user.twoFactorEnabled ? 'aal2' : 'aal1',
      auth_provider: 'better-auth',
      session_id: session.id,
      app_metadata: { ...(user.appMetadata as JWTClaims['app_metadata']), provider: session.ssoProviderId ? `sso:${session.ssoProviderId}` : 'email', providers: [session.ssoProviderId ? `sso:${session.ssoProviderId}` : 'email'] },
    }
    const secret = getEnv(c, 'JWT_SECRET')
    if (!secret)
      throw new Error('JWT_SECRET is required for the database permission bridge')
    const jwt = await new SignJWT({ ...claims, amr: [{ method: user.twoFactorEnabled ? 'totp' : 'password', timestamp: Math.floor(Date.now() / 1000) }] })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(new TextEncoder().encode(secret))
    c.set('authorization', `Bearer ${jwt}`)
    return claims
  }
  finally {
    await instance.close()
  }
}

export const consoleSessionMiddleware = honoFactory.createMiddleware(async (c, next) => {
  c.set('resolveConsoleSession', authorization => resolveConsoleSession(c, authorization))
  await next()
})
