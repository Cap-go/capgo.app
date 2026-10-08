import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono/tiny'
import { Pool } from 'pg'
import { IdentityProvider, ServiceProvider } from 'samlify'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { app as authRoutes } from '../supabase/functions/_backend/private/console_auth.ts'
import { consoleSamlConfig } from '../supabase/functions/_backend/utils/console_sso.ts'
import { POSTGRES_URL } from './test-utils.ts'

const base = 'http://localhost:5173'
const app = new Hono().route('/auth', authRoutes)
const database = new Pool({ connectionString: POSTGRES_URL })
const providerId = randomUUID()
const orgId = randomUUID()
const domain = `${randomUUID()}.example.com`
const directory = mkdtempSync(join(tmpdir(), 'console-sso-test-'))
let ownerId: string
const users: string[] = []
let idp: ReturnType<typeof IdentityProvider>

async function request(path: string, body?: unknown) {
  return app.request(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 250) + 1}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, {})
}

beforeAll(async () => {
  vi.stubEnv('SUPABASE_DB_URL', POSTGRES_URL)
  vi.stubEnv('CONSOLE_AUTH_URL', base)
  vi.stubEnv('WEBAPP_URL', base)
  vi.stubEnv('BETTER_AUTH_SECRET', 'console-sso-test-secret-at-least-32-characters')
  vi.stubEnv('CONSOLE_REQUIRE_EMAIL_VERIFICATION', 'false')
  vi.stubEnv('CAPTCHA_SECRET_KEY', '')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=idp.example.com'], { stdio: 'ignore' })
  idp = IdentityProvider({
    entityID: 'https://idp.example.com/metadata',
    privateKey: readFileSync(join(directory, 'key.pem')),
    signingCert: readFileSync(join(directory, 'cert.pem')),
    singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: 'https://idp.example.com/login' }],
    wantAuthnRequestsSigned: false,
  })
  const signup = await request('/auth/sign-up/email', { email: `owner@${domain}`, password: 'Sso-test-password1!', name: 'SSO Test Owner' })
  expect(signup.status, await signup.clone().text()).toBe(200)
  ownerId = (await signup.json() as { user: { id: string } }).user.id
  users.push(ownerId)
  const passwordMember = await request('/auth/sign-up/email', { email: `password-member@${domain}`, password: 'Sso-test-password1!', name: 'SSO Password Test' })
  expect(passwordMember.status).toBe(200)
  users.push((await passwordMember.json() as { user: { id: string } }).user.id)
  await database.query('UPDATE public.console_auth_user SET "emailVerified" = true WHERE id = $1', [ownerId])
  await database.query('INSERT INTO public.orgs (id, name, management_email, created_by) VALUES ($1, $2, $3, $4)', [orgId, 'Console SSO Test', `owner@${domain}`, ownerId])
  await database.query("INSERT INTO public.org_users (org_id, user_id, rbac_role_name) VALUES ($1, $2, 'org_super_admin') ON CONFLICT DO NOTHING", [orgId, ownerId])
  await database.query(`INSERT INTO public.sso_providers (id, org_id, domain, provider_id, status, dns_verification_token, dns_verified_at)
    VALUES ($1::text::uuid, $2, $3, $1::text, 'active', 'console-sso-test', now())`, [providerId, orgId, domain])
  const config = consoleSamlConfig(base, providerId, idp.getMetadata())
  await database.query(`INSERT INTO public.console_auth_sso_provider (id, "providerId", "userId", "organizationId", domain, issuer, "samlConfig")
    VALUES ($1, $1, $2, $3, $4, $5, $6)`, [providerId, ownerId, orgId, domain, config.issuer, JSON.stringify(config)])
})

afterAll(async () => {
  try {
    await database.query('DELETE FROM public.orgs WHERE id = $1', [orgId])
    await database.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [users])
  }
  finally {
    await database.end()
    rmSync(directory, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
})

async function ssoLogin(email: string, expectSuccess = true) {
  const metadata = await request(`/auth/sso/saml2/sp/metadata?providerId=${providerId}`)
  expect(metadata.status).toBe(200)
  const sp = ServiceProvider({ metadata: await metadata.text() })
  const login = await request('/auth/sign-in/sso', { providerId, callbackURL: `${base}/sso-callback` })
  expect(login.status, await login.clone().text()).toBe(200)
  const redirect = new URL((await login.json() as { url: string }).url)
  const parsed = await idp.parseLoginRequest(sp, 'redirect', { query: Object.fromEntries(redirect.searchParams) })
  const response = await idp.createLoginResponse(sp, { ...parsed }, 'post', { email }, { relayState: redirect.searchParams.get('RelayState') ?? undefined })
  const body = new URLSearchParams({ SAMLResponse: response.context, RelayState: redirect.searchParams.get('RelayState') ?? '' })
  const callback = await app.request(`${base}/auth/sso/saml2/sp/acs/${providerId}`, { method: 'POST', headers: { origin: 'https://idp.example.com', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }, {})
  expect(callback.status, await callback.clone().text()).toBe(302)
  if (expectSuccess)
    expect(callback.headers.get('location')).not.toContain('error=')
  else
    expect(callback.headers.get('location')).toContain('error=provider_not_authorized')
  const cookie = callback.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
  const session = await app.request(`${base}/auth/console-session`, { headers: { cookie } }, {})
  return await session.json() as { session: { access_token: string, user: { id: string, email_confirmed_at: string, app_metadata: { provider: string } } } }
}

it('validates a signed SAML callback and keeps the same identity on repeated sign-in', async () => {
  const first = await ssoLogin(`member@${domain}`)
  expect(first.session).toBeTruthy()
  users.push(first.session.user.id)
  expect(first.session.user.email_confirmed_at).toBeTruthy()
  expect(first.session.user.app_metadata.provider).toBe(`sso:${providerId}`)
  const second = await ssoLogin(`member@${domain}`)
  expect(second.session.user.id).toBe(first.session.user.id)
  const linkedOwner = await ssoLogin(`owner@${domain}`)
  expect(linkedOwner.session.user.id).toBe(ownerId)
  expect((await ssoLogin('unrelated-domain@example.net', false)).session).toBeNull()
  await database.query('UPDATE public.sso_providers SET enforce_sso = true WHERE id = $1', [providerId])
  expect((await request('/auth/sign-in/email', { email: `password-member@${domain}`, password: 'Sso-test-password1!' })).status).toBe(403)
  expect((await request('/auth/sign-in/email', { email: `owner@${domain}`, password: 'Sso-test-password1!' })).status).toBe(200)
  expect((await request('/auth/sign-in/email', { email: `owner@${domain}`, password: 'incorrect-password' })).status).toBe(401)
  await database.query("UPDATE public.sso_providers SET status = 'disabled' WHERE id = $1", [providerId])
  const revoked = await app.request(`${base}/auth/console-session`, { headers: { authorization: `Bearer ${first.session.access_token}` } }, {})
  expect(await revoked.json()).toEqual({ session: null })
})
