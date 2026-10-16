import type { User } from '@supabase/supabase-js'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppleAttempt } from '../utils/appleAuthStore.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { parseSignupAttributionRecord } from '../../shared/signup-attribution.ts'
import { checkRegistrationEmail, getCaptchaSecret, isAuthRateLimitError, isCaptchaFailedError, provisionUserProfile } from '../utils/accountProvisioning.ts'
import { appleHash, appleQuery, appleRandom, closeAppleQueryClient, openAppleCredential, rememberAppleName, sealAppleCredential } from '../utils/appleAuthStore.ts'
import { isAppleSignInConfigured, verifyAppleIdentity } from '../utils/appleSignIn.ts'
import { CacheHelper } from '../utils/cache.ts'
import { simpleErrorWithStatus, useCors } from '../utils/hono.ts'
import { getClientIP } from '../utils/rate_limit.ts'
import { emptySupabaseWithClientIP, supabaseAdmin } from '../utils/supabase.ts'
import { getEnv } from '../utils/utils.ts'

class AppleAuthError extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly code: string) {
    super(code)
  }
}

const registrationMetadataSchema = z.object({
  registration_device_type: z.string().trim().max(100).optional(),
  registration_os: z.string().trim().max(100).optional(),
  registration_browser: z.string().trim().max(100).optional(),
  registration_variant: z.string().trim().max(100).optional(),
  registration_experiment: z.string().trim().max(100).optional(),
  registration_experiment_variant: z.string().trim().max(100).optional(),
  signup_ref: z.string().max(512).optional(),
  signup_plugin: z.string().max(512).optional(),
  signup_source: z.string().max(512).optional(),
  first_touch_type: z.string().max(100).optional(),
  first_touch_path: z.string().max(1024).optional(),
  first_utm_source: z.string().max(512).optional(),
  first_utm_medium: z.string().max(512).optional(),
  first_utm_campaign: z.string().max(512).optional(),
  first_utm_content: z.string().max(512).optional(),
  first_utm_term: z.string().max(512).optional(),
})
const credentialSchema = z.object({
  id_token: z.string().min(1).max(16384),
  nonce: z.string().min(32).max(128),
  first_name: z.string().max(1024).optional(),
  last_name: z.string().max(1024).optional(),
  captcha_token: z.string().min(1).max(4096).optional(),
  reauthenticate: z.boolean().optional(),
  registration_metadata: registrationMetadataSchema.optional(),
})
const startSchema = z.object({
  redirect_uri: z.string().max(2048),
  code_challenge: z.string().regex(/^[\w-]{43}$/),
  client_state: z.string().regex(/^[\w-]{32,128}$/),
  reauthenticate: z.boolean().optional(),
  registration_metadata: registrationMetadataSchema.optional(),
})
const exchangeSchema = z.object({
  code: z.string().regex(/^[\w-]{43}$/),
  code_verifier: z.string().regex(/^[\w-]{43,128}$/),
  captcha_token: z.string().min(1).max(4096).optional(),
})

export const app = new Hono<MiddlewareKeyVariables>()
app.onError((error, c) => {
  const failure = error instanceof AppleAuthError ? error : new AppleAuthError(500, 'apple_login_failed')
  return simpleErrorWithStatus(c, failure.status, failure.code, 'Apple authentication could not complete')
})
app.use('*', useCors)
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  try {
    if (!isAppleSignInConfigured(c))
      throw new AppleAuthError(503, 'apple_login_unavailable')
    // Bound database writes and Apple verification before GoTrue's own IP/CAPTCHA gates.
    const cache = new CacheHelper(c)
    const key = cache.buildRequest('/.apple-auth-rate', { ip: getClientIP(c) })
    const counter = await cache.matchJson<{ count: number }>(key)
    if ((counter?.count ?? 0) >= 30)
      throw new AppleAuthError(429, 'too_many_requests')
    await cache.putJson(key, { count: (counter?.count ?? 0) + 1 }, 60)
    await next()
  }
  catch (error) {
    // Never forward credentials, provider errors or request bodies to error reporters.
    const failure = error instanceof AppleAuthError ? error : new AppleAuthError(500, 'apple_login_failed')
    return simpleErrorWithStatus(c, failure.status, failure.code, 'Apple authentication could not complete')
  }
  finally {
    await closeAppleQueryClient(c)
  }
})

async function jsonBody(c: Context) {
  if (Number(c.req.header('content-length')) > 24000)
    throw new AppleAuthError(400, 'invalid_request')
  // Consume the original body so global error reporting cannot log credentials.
  try {
    const text = await c.req.text()
    if (text.length > 24000)
      throw new Error('Too large')
    return JSON.parse(text)
  }
  catch {
    throw new AppleAuthError(400, 'invalid_request')
  }
}

async function expectedUser(c: Context, reauthenticate?: boolean) {
  if (!reauthenticate)
    return null
  const token = c.req.header('Authorization')?.match(/^Bearer (.+)$/i)?.[1]
  if (!token)
    throw new AppleAuthError(401, 'not_authenticated')
  const { data, error } = await emptySupabaseWithClientIP(c).auth.getUser(token)
  if (error || !data.user)
    throw new AppleAuthError(401, 'not_authenticated')
  return data.user
}

async function checkEmail(c: Context, email: string) {
  const admin = supabaseAdmin(c)
  const [deleted, sso] = await Promise.all([
    checkRegistrationEmail(c, email),
    admin.rpc('get_sso_enforcement_by_domain', { p_domain: email.split('@')[1] }),
  ])
  if (deleted.error || sso.error)
    throw new AppleAuthError(500, 'apple_login_failed')
  if (!deleted.data)
    throw new AppleAuthError(403, 'account_deleted')
  const enforcement = Array.isArray(sso.data) ? sso.data[0] : sso.data
  if (enforcement?.enforce_sso)
    throw new AppleAuthError(403, 'sso_required')
}

type AppleCredential = z.infer<typeof credentialSchema>
type AppleName = Awaited<ReturnType<typeof rememberAppleName>>
type AuthClient = ReturnType<typeof emptySupabaseWithClientIP>

async function verifyCredential(c: Context, body: AppleCredential, web: boolean, expectedSubject: string | null) {
  if (getCaptchaSecret(c) && !body.captcha_token)
    throw new AppleAuthError(422, 'captcha_failed')
  let identity
  try {
    identity = await verifyAppleIdentity(c, body.id_token, body.nonce, web)
  }
  catch {
    throw new AppleAuthError(400, 'invalid_apple_credential')
  }
  if (expectedSubject && identity.subject !== expectedSubject)
    throw new AppleAuthError(403, 'reauth_user_mismatch')
  const caller = await expectedUser(c, body.reauthenticate)
  if (caller) {
    if (!caller.identities?.some(item => item.provider === 'apple' && item.identity_data?.sub === identity.subject))
      throw new AppleAuthError(403, 'reauth_user_mismatch')
  }
  return { identity, caller }
}

async function updateRegistrationMetadata(c: Context, client: AuthClient, user: User, rawMetadata: AppleCredential['registration_metadata'] = {}) {
  const existing = await supabaseAdmin(c).from('users').select('id').eq('id', user.id).maybeSingle()
  if (existing.error)
    throw new AppleAuthError(500, 'apple_login_failed')
  if (existing.data)
    return
  const metadata: Record<string, string> = { ...parseSignupAttributionRecord(rawMetadata) }
  for (const [key, value] of Object.entries(rawMetadata)) {
    if (key.startsWith('registration_') && value)
      metadata[key] = value
  }
  // Hooks read auth metadata when the public profile insert queues on_user_create.
  const updated = await client.auth.updateUser({ data: Object.fromEntries(Object.entries(metadata).filter(([key]) => !user.user_metadata[key])) })
  if (updated.error)
    throw new AppleAuthError(500, 'apple_login_failed')
}

async function saveProfile(c: Context, client: AuthClient, user: User & { email: string }, name: AppleName, metadata: AppleCredential['registration_metadata']) {
  await updateRegistrationMetadata(c, client, user, metadata)
  const profile = await provisionUserProfile(c, {
    id: user.id,
    email: user.email,
    first_name: name.first_name || '',
    last_name: name.last_name || '',
  }, true).select('id')
  if (profile.error)
    throw new AppleAuthError(500, 'apple_login_failed')
  const admin = supabaseAdmin(c)
  // Conditional updates are atomic: parallel sign-ins cannot erase a chosen name.
  await Promise.all((['first_name', 'last_name'] as const).map(async (field) => {
    if (!name[field])
      return
    const patch = field === 'first_name' ? { first_name: name.first_name } : { last_name: name.last_name }
    const update = await admin.from('users').update(patch).eq('id', user.id).or(`${field}.is.null,${field}.eq.`)
    if (update.error)
      throw new AppleAuthError(500, 'apple_login_failed')
  }))
  const saved = await admin.from('users').select('first_name,last_name').eq('id', user.id).single()
  if (saved.error)
    throw new AppleAuthError(500, 'apple_login_failed')
  return {
    is_new_user: (profile.data?.length ?? 0) > 0,
    name_status: saved.data.first_name || saved.data.last_name ? 'saved' : 'unavailable',
  }
}

async function complete(c: Context, body: AppleCredential, web = false, expectedId: string | null = null, expectedSubject: string | null = null) {
  const { identity, caller } = await verifyCredential(c, body, web, expectedSubject)
  expectedId = caller?.id ?? expectedId
  await checkEmail(c, identity.email)
  // Save before any network exchange/profile write that could fail or be interrupted.
  const name = await rememberAppleName(c, identity.subject, body.first_name, body.last_name)
  await appleQuery(c, `DELETE FROM public.apple_auth_token_uses WHERE token_hash IN
    (SELECT token_hash FROM public.apple_auth_token_uses WHERE expires_at < now() ORDER BY expires_at LIMIT 100)`, [])
  const used = await appleQuery(c, `INSERT INTO public.apple_auth_token_uses (token_hash)
    VALUES ($1) ON CONFLICT DO NOTHING RETURNING token_hash`, [await appleHash(body.id_token)])
  if (!used.length)
    throw new AppleAuthError(400, 'invalid_apple_credential')
  const client = emptySupabaseWithClientIP(c)
  const { data, error } = await client.auth.signInWithIdToken({
    provider: 'apple',
    token: body.id_token,
    nonce: body.nonce,
    options: { captchaToken: body.captcha_token },
  })
  if (error) {
    if (isCaptchaFailedError(error))
      throw new AppleAuthError(422, 'captcha_failed')
    if (isAuthRateLimitError(error))
      throw new AppleAuthError(429, 'too_many_requests')
    throw new AppleAuthError(400, 'invalid_apple_credential')
  }
  const user = data.user
  if (!data.session || !user?.email)
    throw new AppleAuthError(500, 'apple_login_failed')
  try {
    if (expectedId && user.id !== expectedId)
      throw new AppleAuthError(403, 'reauth_user_mismatch')
    if (!user.identities?.some(item => item.provider === 'apple' && item.identity_data?.sub === identity.subject))
      throw new AppleAuthError(400, 'invalid_apple_credential')
    await appleQuery(c, 'UPDATE public.apple_auth_names SET user_id = $2 WHERE subject = $1 AND (user_id IS NULL OR user_id = $2)', [identity.subject, user.id])
    // Linked accounts can have a different primary email; enforce both identities.
    await checkEmail(c, user.email)
    const disabled = await client.rpc('is_account_disabled', { user_id: user.id })
    if (disabled.error)
      throw new AppleAuthError(500, 'apple_login_failed')
    if (disabled.data) {
      // Scheduled deletion remains restorable: issue the normal session but skip
      // provisioning and let the existing auth guard send it to accountDisabled.
      return {
        user,
        is_new_user: false,
        name_status: 'unavailable',
        account_status: 'disabled',
        session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
      }
    }
    const profile = await saveProfile(c, client, { ...user, email: user.email }, name, body.registration_metadata)
    return {
      user,
      account_status: 'active',
      ...profile,
      session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
    }
  }
  catch (error_) {
    // Only revoke the just-created session. Never delete existing/linked auth users.
    await client.auth.signOut({ scope: 'local' }).catch(() => {})
    throw error_
  }
}

app.post('/', async (c) => {
  const parsed = credentialSchema.safeParse(await jsonBody(c))
  if (!parsed.success)
    throw new AppleAuthError(400, 'invalid_request')
  return c.json(await complete(c, parsed.data))
})

function oauthConfig(c: Context) {
  const clientId = getEnv(c, 'APPLE_SIGN_IN_WEB_CLIENT_ID').trim()
  const callback = getEnv(c, 'APPLE_SIGN_IN_OAUTH_CALLBACK_URL').trim()
  let redirects: string[] = []
  try {
    const values = JSON.parse(getEnv(c, 'APPLE_SIGN_IN_REDIRECT_URLS'))
    if (Array.isArray(values) && values.every(value => typeof value === 'string'))
      redirects = values
  }
  catch {}
  if (!clientId || !callback.startsWith('https://') || !redirects.length)
    throw new AppleAuthError(503, 'apple_login_unavailable')
  return { clientId, callback, redirects }
}

app.post('/start', async (c) => {
  const config = oauthConfig(c)
  const parsed = startSchema.safeParse(await jsonBody(c))
  if (!parsed.success || !config.redirects.includes(parsed.data.redirect_uri))
    throw new AppleAuthError(400, 'invalid_request')
  const body = parsed.data
  const redirect = new URL(body.redirect_uri)
  if (redirect.hash || redirect.username || redirect.password || !['https:', 'capgo:'].includes(redirect.protocol))
    throw new AppleAuthError(400, 'invalid_request')
  const caller = await expectedUser(c, body.reauthenticate)
  const subject = caller?.identities?.find(identity => identity.provider === 'apple')?.identity_data?.sub
  if (caller && (typeof subject !== 'string' || !subject))
    throw new AppleAuthError(403, 'reauth_user_mismatch')
  const state = appleRandom()
  const nonce = appleRandom()
  // Bounded indexed expiry cleanup; no additional cron or full-table sweep.
  await appleQuery(c, `DELETE FROM public.apple_auth_attempts WHERE state_hash IN
    (SELECT state_hash FROM public.apple_auth_attempts WHERE expires_at < now() ORDER BY expires_at LIMIT 100)`, [])
  await appleQuery(c, `DELETE FROM public.apple_auth_names WHERE subject IN
    (SELECT subject FROM public.apple_auth_names WHERE user_id IS NULL AND created_at < now() - interval '30 days' ORDER BY created_at LIMIT 100)`, [])
  await appleQuery(c, `INSERT INTO public.apple_auth_attempts
    (state_hash, nonce, redirect_uri, code_challenge, client_state, expected_user_id, registration_metadata, expected_subject)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [await appleHash(state), nonce, body.redirect_uri, body.code_challenge, body.client_state, caller?.id ?? null, JSON.stringify(body.registration_metadata ?? {}), subject ?? null])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce))
  const url = new URL('https://appleid.apple.com/auth/authorize')
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callback,
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
  }).toString()
  return c.json({ authorization_url: url.toString(), expires_in: 600 })
})

function finishRedirect(c: Context, attempt: AppleAttempt, fields: Record<string, string>) {
  const url = new URL(attempt.redirect_uri)
  url.hash = new URLSearchParams({ ...fields, state: attempt.client_state }).toString()
  return c.redirect(url.toString(), 303)
}

app.post('/callback', async (c) => {
  oauthConfig(c)
  const text = await c.req.text()
  if (text.length > 24000)
    throw new AppleAuthError(400, 'invalid_request')
  const form = new URLSearchParams(text)
  const state = form.get('state') ?? ''
  if (!/^[\w-]{43}$/.test(state))
    throw new AppleAuthError(400, 'invalid_request')
  const [attempt] = await appleQuery<AppleAttempt>(c, `SELECT * FROM public.apple_auth_attempts
    WHERE state_hash = $1 AND expires_at > now() AND callback_claimed = false`, [await appleHash(state)])
  if (!attempt)
    throw new AppleAuthError(400, 'invalid_exchange')
  try {
    const token = form.get('id_token') ?? ''
    const code = form.get('code') ?? ''
    if (form.has('error') || !token || !code || code.length > 4096)
      throw new Error('Authorization failed')
    const identity = await verifyAppleIdentity(c, token, attempt.nonce, true, code)
    let profile: { name?: { firstName?: unknown, lastName?: unknown } } = {}
    try {
      profile = JSON.parse(form.get('user') ?? '{}') ?? {}
    }
    catch {}
    // The user object is optional display data, bound to this verified identity.
    await rememberAppleName(c, identity.subject, profile.name?.firstName, profile.name?.lastName)
    const exchange = appleRandom()
    const committed = await appleQuery(c, `UPDATE public.apple_auth_attempts SET callback_claimed = true, exchange_hash = $2, credential = $3
      WHERE state_hash = $1 AND callback_claimed = false AND expires_at > now() RETURNING state_hash`, [attempt.state_hash, await appleHash(exchange), await sealAppleCredential(c, { id_token: token, authorization_code: code })])
    if (!committed.length)
      throw new Error('Authorization already completed')
    return finishRedirect(c, attempt, { apple_code: exchange })
  }
  catch {
    return finishRedirect(c, attempt, { apple_error: 'apple_authorization_failed' })
  }
})

app.post('/exchange', async (c) => {
  oauthConfig(c)
  const parsed = exchangeSchema.safeParse(await jsonBody(c))
  if (!parsed.success)
    throw new AppleAuthError(400, 'invalid_request')
  const body = parsed.data
  if (getCaptchaSecret(c) && !body.captcha_token)
    throw new AppleAuthError(422, 'captcha_failed')
  // Atomic consumption checks the verifier: a wrong verifier cannot burn a code.
  const [attempt] = await appleQuery<AppleAttempt>(c, `DELETE FROM public.apple_auth_attempts
    WHERE exchange_hash = $1 AND code_challenge = $2 AND expires_at > now() RETURNING *`, [await appleHash(body.code), await appleHash(body.code_verifier)])
  if (!attempt?.credential)
    throw new AppleAuthError(400, 'invalid_exchange')
  const credential = await openAppleCredential<{ id_token: string, authorization_code: string }>(c, attempt.credential)
  const response = await complete(c, { id_token: credential.id_token, nonce: attempt.nonce, captcha_token: body.captcha_token, registration_metadata: attempt.registration_metadata as z.infer<typeof registrationMetadataSchema> }, true, attempt.expected_user_id, attempt.expected_subject)
  return c.json({ ...response, authorization_code: credential.authorization_code })
})
