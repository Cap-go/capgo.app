import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { compare, hash } from 'bcryptjs'
import { verifyCaptchaToken } from '../utils/captcha.ts'
import { CONSOLE_SESSION_PREFIX, consoleAuthHeaders, createConsoleAuth, getConsoleSession } from '../utils/console_auth.ts'
import { getAllowedCorsOrigin, quickError } from '../utils/hono.ts'
import { captureOrganizationInvitationPosthogEvent } from '../utils/organization_invitation_posthog.ts'
import { getPasswordPolicyValidationErrors } from '../utils/password_policy.ts'
import { isAccountRateLimited, isIPRateLimited, recordFailedAccountAuth, recordFailedAuth } from '../utils/rate_limit.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { getEnv } from '../utils/utils.ts'
import { ensureOrgMembership, ensurePublicUserRowExists } from './accept_invitation.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('*', async (c, next) => {
  const origin = c.req.header('origin')
  // IdP form posts are verified by Better Auth's signed SAML callback handler.
  const samlCallback = c.req.method === 'POST' && /\/auth\/sso\/saml2\/sp\/(acs|slo)(\/|$)/.test(c.req.path)
  if (origin && !getAllowedCorsOrigin(origin, c) && !samlCallback)
    return quickError(403, 'invalid_origin', 'Origin is not allowed')
  if (origin && getAllowedCorsOrigin(origin, c)) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Access-Control-Allow-Credentials', 'true')
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-captcha-response')
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    c.header('Access-Control-Expose-Headers', 'set-auth-token')
    c.header('Vary', 'Origin')
  }
  if (c.req.method === 'OPTIONS')
    return c.json({ status: 'ok' })
  await next()
})

app.post('/console-accept-invitation', async (c) => {
  if ((await isIPRateLimited(c)).limited)
    return quickError(429, 'rate_limited', 'Too many attempts')
  const body = z.object({ magic_invite_string: z.string().min(1).max(256), password: z.string().min(6).max(72), opt_for_newsletters: z.boolean(), captchaToken: z.string().optional() }).safeParse(await c.req.json())
  if (!body.success)
    return quickError(400, 'invalid_body', 'Invalid invitation')
  const captchaSecret = getEnv(c, 'CAPTCHA_SECRET_KEY')
  if (captchaSecret)
    await verifyCaptchaToken(c, body.data.captchaToken ?? '', captchaSecret)
  const admin = supabaseAdmin(c)
  const { data: invitation, error } = await admin.from('tmp_users').select('*').eq('invite_magic_string', body.data.magic_invite_string).maybeSingle()
  if (error || !invitation || invitation.cancelled_at) {
    await recordFailedAuth(c)
    return quickError(404, 'invitation_not_found', 'Invitation not found')
  }
  if ((await isAccountRateLimited(c, invitation.email)).limited)
    return quickError(429, 'rate_limited', 'Too many attempts')
  const { data: org } = await admin.from('orgs').select('password_policy_config').eq('id', invitation.org_id).single()
  const policy = org?.password_policy_config as (Parameters<typeof getPasswordPolicyValidationErrors>[1] & { enabled?: boolean }) | null
  if (getPasswordPolicyValidationErrors(body.data.password, policy?.enabled ? policy : { min_length: 6, require_uppercase: true, require_number: true, require_special: true }).length)
    return quickError(400, 'invalid_password', 'Password does not meet organization requirements')
  const instance = createConsoleAuth(c, invitation.future_uuid)
  let createdUserId: string | undefined
  let membershipFinalized = false
  try {
    const ssoRequired = await instance.database.query(`SELECT 1 FROM public.sso_providers
      WHERE domain = $1 AND enforce_sso AND status = 'active' LIMIT 1`, [invitation.email.split('@')[1]?.toLowerCase()])
    if (ssoRequired.rowCount)
      return quickError(403, 'sso_required', 'This organization requires SSO')
    const context = await instance.auth.$context
    let user = await context.internalAdapter.findUserByEmail(invitation.email.toLowerCase())
    if (user) {
      const account = user.accounts.find(account => account.providerId === 'credential')
      if ((user.user as typeof user.user & { twoFactorEnabled?: boolean }).twoFactorEnabled || !account?.password || !await compare(body.data.password, account.password)) {
        await recordFailedAuth(c)
        await recordFailedAccountAuth(c, invitation.email)
        return quickError(409, 'user_already_exists', 'Sign in and accept this invitation from your dashboard')
      }
    }
    else {
      const created = await context.internalAdapter.createUser({ email: invitation.email.toLowerCase(), name: `${invitation.first_name} ${invitation.last_name}`.trim(), emailVerified: true, firstName: invitation.first_name, lastName: invitation.last_name, optForNewsletters: body.data.opt_for_newsletters }, { method: 'email-password' })
      createdUserId = created.id
      await context.internalAdapter.createAccount({ accountId: created.id, userId: created.id, providerId: 'credential', password: await hash(body.data.password, 12) })
      user = await context.internalAdapter.findUserByEmail(created.email)
    }
    if (!user)
      return quickError(500, 'account_creation_failed', 'Unable to create account')
    const profileError = await ensurePublicUserRowExists(c, admin, user.user.id, invitation, body.data.opt_for_newsletters)
    if (profileError)
      return profileError
    if (createdUserId) {
      const profile = await admin.from('users').update({ created_via_invite: true }).eq('id', createdUserId)
      if (profile.error)
        return quickError(500, 'profile_creation_failed', 'Unable to finalize invited profile')
    }
    const membershipError = await ensureOrgMembership(c, admin, user.user.id, invitation)
    if (membershipError)
      return membershipError
    membershipFinalized = true
    await captureOrganizationInvitationPosthogEvent(c, {
      accountState: createdUserId ? 'created' : 'already_existed',
      event: 'organization_membership_invitation_accepted',
      flow: 'new_user_magic_link',
      invitationId: invitation.id,
      pendingInvitationCount: 1,
      userId: user.user.id,
    })
    const session = await context.internalAdapter.createSession(user.user.id)
    if (!session)
      return quickError(500, 'session_creation_failed', 'Unable to create session')
    const deleted = await admin.from('tmp_users').delete().eq('id', invitation.id)
    if (deleted.error)
      return quickError(500, 'invitation_accept_failed', 'Unable to finalize invitation')
    const token = `${CONSOLE_SESSION_PREFIX}${session.token}`
    return c.json({ access_token: token, refresh_token: token })
  }
  finally {
    if (createdUserId && !membershipFinalized) {
      // Deleting the transitional identity also cascades native credentials.
      await instance.database.query('DELETE FROM auth.users WHERE id = $1', [createdUserId])
      await instance.database.query('DELETE FROM public.console_auth_user WHERE id = $1', [createdUserId])
    }
    await instance.close()
  }
})

app.get('/console-session', async (c) => {
  const instance = createConsoleAuth(c)
  try {
    const result = await getConsoleSession(instance, c.req.raw.headers)
    if (!result || result.user.migrationBlocked)
      return c.json({ session: null })
    const { user, session } = result
    const token = `${CONSOLE_SESSION_PREFIX}${session.token}`
    return c.json({ session: {
      mfa_verified: result.mfaVerified,
      access_token: token,
      refresh_token: token,
      expires_at: Math.floor(new Date(session.expiresAt).getTime() / 1000),
      user: {
        id: user.id,
        email: user.email,
        created_at: new Date(user.createdAt).toISOString(),
        updated_at: new Date(user.updatedAt).toISOString(),
        email_confirmed_at: user.emailVerified ? new Date(user.updatedAt).toISOString() : undefined,
        app_metadata: { ...(user.appMetadata ?? {}), provider: session.ssoProviderId ? `sso:${session.ssoProviderId}` : 'email', providers: [session.ssoProviderId ? `sso:${session.ssoProviderId}` : 'email'] },
        user_metadata: user.userMetadata ?? {},
        factors: user.twoFactorEnabled ? [{ id: user.id, factor_type: 'totp', status: 'verified', created_at: new Date(user.createdAt).toISOString() }] : [],
      },
    } })
  }
  finally {
    await instance.close()
  }
})

// A server-validated session is required; browser-provided user ids are never trusted.
app.post('/console-verify-email', async (c) => {
  const instance = createConsoleAuth(c)
  try {
    const headers = consoleAuthHeaders(c.req.raw.headers)
    const session = await getConsoleSession(instance, headers)
    if (!session || session.user.migrationBlocked || (session.user.twoFactorEnabled && !session.mfaVerified))
      return quickError(401, 'not_authenticated', 'Not authenticated')
    const body = await c.req.json<{ token: string }>()
    await instance.auth.api.verifyEmailOTP({ body: { email: session.user.email, otp: body.token }, headers })
    const verifiedAt = new Date().toISOString()
    await instance.database.query('SELECT public.record_email_otp_verified($1::uuid)', [session.user.id])
    return c.json({ verified_at: verifiedAt })
  }
  finally {
    await instance.close()
  }
})

app.on(['GET', 'POST'], '*', async (c) => {
  const instance = createConsoleAuth(c)
  try {
    // Supabase's gateway strips /functions/v1 before invoking the function.
    // Better Auth still needs the externally configured path for routing and links.
    const url = new URL(c.req.url)
    const authPath = c.req.path.slice(c.req.path.indexOf('/auth'))
    url.pathname = `${new URL(getEnv(c, 'CONSOLE_AUTH_URL')).pathname.replace(/\/$/, '')}${authPath}`
    return await instance.auth.handler(new Request(url, new Request(c.req.raw, { headers: consoleAuthHeaders(c.req.raw.headers) })))
  }
  finally {
    await instance.close()
  }
})
