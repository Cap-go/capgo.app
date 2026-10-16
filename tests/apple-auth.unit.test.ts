import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pg: vi.fn(), connect: vi.fn(), close: vi.fn(), rpc: vi.fn(), exchange: vi.fn(), signOut: vi.fn(), updateUser: vi.fn(), getUser: vi.fn(), from: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: mocks.connect, closeClient: mocks.close }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  emptySupabaseWithClientIP: () => ({ auth: { signInWithIdToken: mocks.exchange, signOut: mocks.signOut, updateUser: mocks.updateUser, getUser: mocks.getUser }, rpc: mocks.rpc }),
  supabaseAdmin: () => ({ rpc: mocks.rpc, from: mocks.from }),
}))
const { app } = await import('../supabase/functions/_backend/auth/apple.ts')
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'apple-signin@example.com', identities: [{ provider: 'apple', identity_data: { sub: 'verified-subject' } }], user_metadata: {}, factors: [{ status: 'verified' }] }
let key: CryptoKey
let jwks: unknown
const names = new Map<string, { first_name: string, last_name: string }>()
const uses = new Set<string>()
const attempts = new Map<string, any>()
let profile: any
let profileFailure = false
let newInserts = 0
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true })
  key = keys.privateKey
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256' }] }
})
async function token(nonce = 'n'.repeat(64), audience = 'com.example.native', options: { subject?: string, expired?: boolean, nonce?: string } = {}) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce))
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  const codeHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('apple-authorization')))
  const cHash = btoa(String.fromCharCode(...codeHash.slice(0, 16))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return new SignJWT({ email: user.email, email_verified: 'true', nonce: options.nonce ?? hash, c_hash: cHash })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(options.subject ?? 'verified-subject')
    .setIssuer('https://appleid.apple.com')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(options.expired ? '0s' : '5m')
    .sign(key)
}
function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}
function query(sql: string, p: any[]) {
  if (sql.startsWith('UPDATE public.apple_auth_names') || sql.startsWith('DELETE FROM public.apple_auth_names'))
    return []
  if (sql.includes('INSERT INTO public.apple_auth_names')) {
    const previous = names.get(p[0])
    const value = { first_name: previous?.first_name || p[1], last_name: previous?.last_name || p[2] }
    names.set(p[0], value)
    return [value]
  }
  if (sql.includes('INSERT INTO public.apple_auth_token_uses')) {
    if (uses.has(p[0]))
      return []
    uses.add(p[0])
    return [{ token_hash: p[0] }]
  }
  if (sql.startsWith('DELETE FROM public.apple_auth_token_uses') || sql.startsWith('DELETE FROM public.apple_auth_attempts WHERE state_hash IN'))
    return []
  if (sql.startsWith('INSERT INTO public.apple_auth_attempts')) {
    attempts.set(p[0], { state_hash: p[0], nonce: p[1], redirect_uri: p[2], code_challenge: p[3], client_state: p[4], expected_user_id: p[5], registration_metadata: JSON.parse(p[6]), expected_subject: p[7], callback_claimed: false })
    return []
  }
  if (sql.startsWith('SELECT * FROM public.apple_auth_attempts')) {
    const row = attempts.get(p[0])
    if (!row || row.callback_claimed || row.expired)
      return []
    return [{ ...row }]
  }
  if (sql.startsWith('UPDATE public.apple_auth_attempts SET callback_claimed')) {
    const row = attempts.get(p[0])
    if (!row || row.callback_claimed || row.expired)
      return []
    Object.assign(row, { callback_claimed: true, exchange_hash: p[1], credential: p[2] })
    return [{ state_hash: p[0] }]
  }
  if (sql.startsWith('DELETE FROM public.apple_auth_attempts')) {
    const row = [...attempts.values()].find(row => row.exchange_hash === p[0] && row.code_challenge === p[1] && !row.expired)
    if (!row || (p[2] === false && !row.expected_user_id))
      return []
    attempts.delete(row.state_hash)
    return [{ ...row }]
  }
  throw new Error('Unexpected SQL')
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue({ query: mocks.pg })
  mocks.close.mockResolvedValue(undefined)
  names.clear()
  uses.clear()
  attempts.clear()
  profile = null
  profileFailure = false
  newInserts = 0
  for (const [name, value] of Object.entries({ APPLE_SIGN_IN_CLIENT_ID: 'com.example.native', APPLE_SIGN_IN_WEB_CLIENT_ID: 'com.example.web', APPLE_SIGN_IN_TEAM_ID: 'EXAMPLETEAM', APPLE_SIGN_IN_KEY_ID: 'EXAMPLEKEY', APPLE_SIGN_IN_PRIVATE_KEY: 'server-only-example-key', APPLE_SIGN_IN_OAUTH_CALLBACK_URL: 'https://api.example.com/auth/apple/callback', APPLE_SIGN_IN_REDIRECT_URLS: '["https://console.example.com/login","capgo://apple-callback"]', CAPTCHA_SECRET_KEY: 'secret', SUPABASE_URL: 'https://auth.example.com' }))
    vi.stubEnv(name, value)
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/auth/keys'))
      return Response.json(jwks)
    return Response.json({ external: { apple: true } })
  }))
  mocks.pg.mockImplementation(async (sql, params) => ({ rows: query(sql, params) }))
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'get_sso_enforcement_by_domain' ? [{ enforce_sso: false }] : name === 'is_not_deleted', error: null }))
  mocks.exchange.mockResolvedValue({ data: { user, session: { access_token: 'supabase-access', refresh_token: 'supabase-refresh' } }, error: null })
  mocks.getUser.mockResolvedValue({ data: { user }, error: null })
  mocks.updateUser.mockResolvedValue({ data: { user }, error: null })
  mocks.signOut.mockResolvedValue({ error: null })
  mocks.from.mockImplementation(() => ({
    upsert: (value: any, options: any) => ({ select: async () => {
      expect(options.ignoreDuplicates).toBe(true)
      if (profileFailure)
        return { error: { message: 'Profile unavailable' } }
      const inserted = !profile
      if (inserted) {
        profile = value
        newInserts++
      }
      return { data: inserted ? [{ id: value.id }] : [], error: null }
    } }),
    select: () => ({ eq: () => ({ single: async () => ({ data: profile, error: null }), maybeSingle: async () => ({ data: profile ? { id: user.id } : null, error: null }) }) }),
    update: (value: any) => ({ eq: () => ({ or: async () => {
      for (const [field, name] of Object.entries(value)) {
        if (!profile[field])
          profile[field] = name
      }
      return { error: null }
    } }) }),
  }))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('shared Apple endpoint', () => {
  it('reuses one store client per request and closes it at each request boundary', async () => {
    const start = { redirect_uri: 'https://console.example.com/login', code_challenge: 'c'.repeat(43), client_state: 's'.repeat(43) }
    expect((await request('/start', start)).status).toBe(200)
    expect(mocks.pg).toHaveBeenCalledTimes(3)
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
    expect((await request('/start', start)).status).toBe(200)
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    expect(mocks.close).toHaveBeenCalledTimes(2)
  })

  it('closes the store client when a statement fails', async () => {
    mocks.pg.mockRejectedValueOnce(new Error('Database unavailable'))
    expect((await request('/start', { redirect_uri: 'https://console.example.com/login', code_challenge: 'c'.repeat(43), client_state: 's'.repeat(43) })).status).toBe(500)
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('verifies credentials, provisions the actual profile with opted-out consent and keeps MFA factors', async () => {
    const idToken = await token()
    const response = await request('/', { id_token: idToken, nonce: 'n'.repeat(64), captcha_token: 'captcha', first_name: 'First\u0000', last_name: ' Name ' })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(profile).toMatchObject({ id: user.id, first_name: 'First', last_name: 'Name', enable_notifications: true, opt_for_newsletters: false })
    expect(await response.json()).toMatchObject({ is_new_user: true, name_status: 'saved', user: { factors: [{ status: 'verified' }] } })
    expect(mocks.exchange).toHaveBeenCalledWith({ provider: 'apple', token: idToken, nonce: 'n'.repeat(64), options: { captchaToken: 'captcha' } })
  })
  it('recovers the first name after failed completion and never erases chosen profile names', async () => {
    profileFailure = true
    expect((await request('/', { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha', first_name: 'Initial' })).status).toBe(500)
    expect(names.get('verified-subject')?.first_name).toBe('Initial')
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' })
    profileFailure = false
    const nonce = 'other'.repeat(10)
    const retry = await request('/', { id_token: await token(nonce), nonce, captcha_token: 'captcha' })
    expect(retry.status).toBe(200)
    expect(profile.first_name).toBe('Initial')
    profile.first_name = 'Chosen'
    const next = 'next'.repeat(10)
    const returning = await request('/', { id_token: await token(next), nonce: next, captcha_token: 'captcha', first_name: 'Other' })
    expect(await returning.json()).toMatchObject({ is_new_user: false })
    expect(profile.first_name).toBe('Chosen')
    expect(newInserts).toBe(1)
  })
  it.each(['nonce', 'audience', 'expired'])('rejects %s mismatch before any identity/profile writes', async (mode) => {
    const idToken = await token('n'.repeat(64), mode === 'audience' ? 'foreign-client' : 'com.example.native', { nonce: mode === 'nonce' ? 'wrong' : undefined, expired: mode === 'expired' })
    expect((await request('/', { id_token: idToken, nonce: 'n'.repeat(64), captcha_token: 'captcha' })).status).toBe(400)
    expect(names.size).toBe(0)
    expect(mocks.exchange).not.toHaveBeenCalled()
  })
  it('rejects native credential replay', async () => {
    const body = { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha' }
    expect((await request('/', body)).status).toBe(200)
    expect((await request('/', body)).status).toBe(400)
    expect(mocks.exchange).toHaveBeenCalledTimes(1)
  })
  it('requires CAPTCHA and preserves provider abuse errors', async () => {
    const body = { id_token: await token(), nonce: 'n'.repeat(64) }
    expect((await request('/', body)).status).toBe(422)
    expect(mocks.exchange).not.toHaveBeenCalled()
    mocks.exchange.mockResolvedValue({ error: { code: 'over_request_rate_limit', status: 429 } })
    expect((await request('/', { ...body, captcha_token: 'captcha' })).status).toBe(429)
  })
  it.each(['deleted', 'sso'])('denies %s accounts without returning session credentials', async (mode) => {
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'get_sso_enforcement_by_domain' ? [{ enforce_sso: mode === 'sso' }] : name === 'is_account_disabled' ? mode === 'disabled' : mode !== 'deleted', error: null }))
    const response = await request('/', { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha' })
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('supabase-access')
    expect(newInserts).toBe(0)
  })
  it('preserves restoration access for scheduled deletion without provisioning', async () => {
    mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'get_sso_enforcement_by_domain' ? [] : true, error: null }))
    const response = await request('/', { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ account_status: 'disabled', is_new_user: false })
    expect(newInserts).toBe(0)
  })
  it('requires an authenticated same Apple identity for deletion reauthentication without any rollout setting', async () => {
    const body = { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha', reauthenticate: true }
    expect((await request('/', body)).status).toBe(401)
    const foreign = await token('n'.repeat(64), 'com.example.native', { subject: 'foreign-subject' })
    expect((await request('/', { ...body, id_token: foreign }, { Authorization: 'Bearer current-session' })).status).toBe(403)
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect((await request('/', body, { Authorization: 'Bearer current-session' })).status).toBe(200)
  })
  it('rejects malformed markup in optional names instead of retaining partial tags', async () => {
    const response = await request('/', { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha', first_name: '<<scr<script>ipt>', last_name: '<img src=x>' })
    expect(response.status).toBe(200)
    expect(profile.first_name).toBe('')
    expect(profile.last_name).toBe('')
    expect(await response.json()).toMatchObject({ name_status: 'unavailable' })
  })
  it('reports truly unavailable names without requiring disclosure', async () => {
    const response = await request('/', { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha' })
    expect(await response.json()).toMatchObject({ name_status: 'unavailable' })
  })
})

async function oauth(redirect = 'https://console.example.com/login', reauthenticate = false) {
  const verifier = 'v'.repeat(43)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const challenge = btoa(String.fromCharCode(...hash)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  const response = await request('/start', { redirect_uri: redirect, code_challenge: challenge, client_state: 's'.repeat(43), reauthenticate, registration_metadata: { signup_source: 'website', registration_device_type: 'mobile', role: 'admin' } }, reauthenticate ? { Authorization: 'Bearer current-session' } : {})
  expect(response.status).toBe(200)
  const result = await response.json() as { authorization_url: string }
  const authUrl = new URL(result.authorization_url)
  const attempt = [...attempts.values()][0]
  const idToken = await token(attempt.nonce, 'com.example.web')
  const callback = () => app.request('/callback', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: authUrl.searchParams.get('state')!, id_token: idToken, code: 'apple-authorization', user: JSON.stringify({ name: { firstName: 'Browser', lastName: 'Name' } }) }) })
  return { verifier, authUrl, attempt, callback }
}
describe('android/browser OAuth backend transport', () => {
  it('allows authenticated same-account deletion reauthentication without any rollout setting', async () => {
    const flow = await oauth('capgo://apple-callback', true)
    expect(flow.attempt.expected_user_id).toBe(user.id)
    expect(flow.attempt.expected_subject).toBe('verified-subject')
    const callback = await flow.callback()
    const code = new URLSearchParams(new URL(callback.headers.get('location')!).hash.slice(1)).get('apple_code')
    expect((await request('/exchange', { code, code_verifier: flow.verifier, captcha_token: 'captcha' })).status).toBe(200)
  })
  it.each(['https://console.example.com/login', 'capgo://apple-callback'])('captures the one-time name and completes verifier-bound %s session exchange', async (redirect) => {
    const flow = await oauth(redirect)
    expect(flow.authUrl.searchParams.get('client_id')).toBe('com.example.web')
    expect(flow.authUrl.searchParams.get('response_mode')).toBe('form_post')
    const response = await flow.callback()
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.search).toBe('')
    const fragment = new URLSearchParams(location.hash.slice(1))
    expect(fragment.get('state')).toBe('s'.repeat(43))
    expect(names.get('verified-subject')).toEqual({ first_name: 'Browser', last_name: 'Name' })
    expect(flow.attempt.credential).not.toContain('apple-authorization')
    const code = fragment.get('apple_code')!
    expect((await request('/exchange', { code, code_verifier: 'wrong'.repeat(10), captcha_token: 'captcha' })).status).toBe(400)
    const exchanged = await request('/exchange', { code, code_verifier: flow.verifier, captcha_token: 'captcha' })
    expect(exchanged.status).toBe(200)
    expect(await exchanged.json()).toMatchObject({ is_new_user: true, authorization_code: 'apple-authorization' })
    expect(profile.first_name).toBe('Browser')
    expect(mocks.updateUser).toHaveBeenCalledWith({ data: expect.objectContaining({ signup_source: 'website', registration_device_type: 'mobile' }) })
    expect(mocks.updateUser.mock.calls[0][0].data).not.toHaveProperty('role')
    expect((await request('/exchange', { code, code_verifier: flow.verifier, captcha_token: 'captcha' })).status).toBe(400)
    expect((await flow.callback()).status).toBe(400)
  })
  it('rejects invalid state and unallowlisted redirect before recording callback names', async () => {
    const response = await request('/start', { redirect_uri: 'https://attacker.example/callback', code_challenge: 'x'.repeat(43), client_state: 's'.repeat(43) })
    expect(response.status).toBe(400)
    const callback = await app.request('/callback', { method: 'POST', body: new URLSearchParams({ state: 'x'.repeat(43), user: '{"name":{"firstName":"Injected"}}' }) })
    expect(callback.status).toBe(400)
    expect(names.size).toBe(0)
  })
  it('authenticates valid native credentials with no rollout configuration or Vault lookup', async () => {
    const response = await request('/', { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha' })
    expect(response.status).toBe(200)
    expect(mocks.exchange).toHaveBeenCalledOnce()
    expect(mocks.pg.mock.calls.some(([sql]) => sql.includes('vault.'))).toBe(false)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/auth/v1/settings'))).toBe(false)
  })
  it('completes browser OAuth with no rollout configuration or discovery request', async () => {
    const flow = await oauth()
    const response = await flow.callback()
    const code = new URLSearchParams(new URL(response.headers.get('location')!).hash.slice(1)).get('apple_code')
    expect((await request('/exchange', { code, code_verifier: flow.verifier, captcha_token: 'captcha' })).status).toBe(200)
    expect(profile.first_name).toBe('Browser')
    expect(mocks.pg.mock.calls.some(([sql]) => sql.includes('vault.'))).toBe(false)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/auth/v1/settings'))).toBe(false)
  })
  it('requires normal Apple credentials without substituting an enablement flag', async () => {
    vi.stubEnv('APPLE_SIGN_IN_PRIVATE_KEY', '')
    expect((await request('/', { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha' })).status).toBe(503)
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it('keeps native and browser same-account deletion reauthentication without rollout settings', async () => {
    const body = { id_token: await token(), nonce: 'n'.repeat(64), captcha_token: 'captcha', reauthenticate: true }
    expect((await request('/', body)).status).toBe(401)
    expect((await request('/', body, { Authorization: 'Bearer current-session' })).status).toBe(200)
    const flow = await oauth('capgo://apple-callback', true)
    const response = await flow.callback()
    const code = new URLSearchParams(new URL(response.headers.get('location')!).hash.slice(1)).get('apple_code')
    expect((await request('/exchange', { code, code_verifier: flow.verifier, captcha_token: 'captcha' })).status).toBe(200)
    expect(flow.attempt.expected_user_id).toBe(user.id)
    expect(flow.attempt.expected_subject).toBe('verified-subject')
  })
})
