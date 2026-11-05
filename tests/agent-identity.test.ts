import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { beforeAll, describe, expect, it } from 'vitest'
import { executeSQL, fetchTestRequest, getAuthHeaders, getEndpointUrl, ORG_ID, USER_EMAIL } from './test-utils.ts'

// auth.md agent registration lives next to the hosted MCP OAuth server, on the Cloudflare API worker only.
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'
const CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim'

let jwtHeaders: Record<string, string>

interface Registration {
  registration_id: string
  registration_type: string
  claim_url: string
  claim_token: string
  claim_token_expires: string
  post_claim_scopes: string[]
  claim: { user_code: string, expires_in: number, verification_uri: string, interval: number }
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetchTestRequest(getEndpointUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function register(email = USER_EMAIL): Promise<Registration & { attemptToken: string }> {
  const response = await postJson('/agent/identity', { type: 'service_auth', login_hint: email })
  expect(response.status, await response.clone().text()).toBe(200)
  const body = await response.json() as Registration
  const verification = new URL(body.claim.verification_uri)
  expect(verification.pathname).toBe('/agent/claim')
  return { ...body, attemptToken: verification.searchParams.get('claim_attempt_token')! }
}

function poll(claimToken: string) {
  return fetchTestRequest(getEndpointUrl('/mcp/oauth/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: CLAIM_GRANT, claim_token: claimToken }).toString(),
  })
}

async function createUserKey(): Promise<{ id: number, key: string }> {
  const response = await postJson('/apikey', {
    name: `MCP · auth.md vitest-${randomUUID().slice(0, 8)}`,
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    bindings: [{ role_name: 'org_super_admin', scope_type: 'org', org_id: ORG_ID }],
  }, jwtHeaders)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json() as { id: number, key: string }
}

async function deleteUserKey(id: number) {
  await fetchTestRequest(getEndpointUrl(`/apikey/${id}`), { method: 'DELETE', headers: jwtHeaders })
}

beforeAll(async () => {
  if (USE_CLOUDFLARE)
    jwtHeaders = await getAuthHeaders()
})

describe.skipIf(!USE_CLOUDFLARE)('auth.md service_auth agent registration', () => {
  it('registers, claims on the console and hands the agent a working API key once', async () => {
    const registration = await register(` ${USER_EMAIL.toUpperCase()} `)
    expect(registration).toMatchObject({ registration_type: 'service_auth', post_claim_scopes: ['capgo'] })
    expect(registration.registration_id).toMatch(/^reg_/)
    expect(registration.claim_token).toMatch(/^clm_/)
    expect(registration.claim).toMatchObject({ expires_in: 600, interval: 5 })
    expect(registration.claim.user_code).toMatch(/^\d{6}$/)

    const pending = await poll(registration.claim_token)
    expect(pending.status).toBe(400)
    await expect(pending.json()).resolves.toMatchObject({ error: 'authorization_pending' })
    const tooFast = await poll(registration.claim_token)
    await expect(tooFast.json()).resolves.toMatchObject({ error: 'slow_down' })

    const details = await fetchTestRequest(getEndpointUrl(`/private/agent_identity/?claim_attempt_token=${registration.attemptToken}`), { headers: jwtHeaders })
    expect(details.status, await details.clone().text()).toBe(200)
    await expect(details.json()).resolves.toMatchObject({ registration_id: registration.registration_id, email_matches: true })

    // Approving needs the user_code first.
    const { id: keyId, key: apikey } = await createUserKey()
    try {
      const early = await postJson('/private/agent_identity/approve', { claim_attempt_token: registration.attemptToken, apikey }, jwtHeaders)
      expect(early.status).toBe(410)

      const wrongCode = registration.claim.user_code === '000000' ? '111111' : '000000'
      const wrong = await postJson('/private/agent_identity/verify', { claim_attempt_token: registration.attemptToken, user_code: wrongCode }, jwtHeaders)
      expect(wrong.status).toBe(400)
      await expect(wrong.json()).resolves.toMatchObject({ error: 'invalid_user_code' })

      const verify = await postJson('/private/agent_identity/verify', { claim_attempt_token: registration.attemptToken, user_code: registration.claim.user_code }, jwtHeaders)
      expect(verify.status, await verify.clone().text()).toBe(200)
      const approve = await postJson('/private/agent_identity/approve', { claim_attempt_token: registration.attemptToken, apikey }, jwtHeaders)
      expect(approve.status, await approve.clone().text()).toBe(200)

      await new Promise(resolve => setTimeout(resolve, 4_100))
      const token = await poll(registration.claim_token)
      expect(token.status, await token.clone().text()).toBe(200)
      const tokenJson = await token.json() as { access_token: string, token_type: string, scope: string, expires_in: number }
      expect(tokenJson).toMatchObject({ access_token: apikey, token_type: 'Bearer', scope: 'capgo' })
      expect(tokenJson.expires_in).toBeGreaterThan(29 * 86_400)
      expect(token.headers.get('cache-control')).toBe('no-store')

      const apps = await fetchTestRequest(getEndpointUrl('/app/'), { headers: { authorization: `Bearer ${tokenJson.access_token}` } })
      expect(apps.status).toBe(200)

      // The email is not kept once the key was handed over.
      const [stored] = await executeSQL(`SELECT status, login_hint FROM public.agent_identity_registrations WHERE id = $1`, [registration.registration_id.slice(4)])
      expect(stored).toMatchObject({ status: 'exchanged', login_hint: '' })

      // The claim_token is single use.
      const replay = await poll(registration.claim_token)
      await expect(replay.json()).resolves.toMatchObject({ error: 'invalid_grant' })

      const revoke = await fetchTestRequest(getEndpointUrl('/mcp/oauth/revoke'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokenJson.access_token }).toString(),
      })
      expect(revoke.status).toBe(200)
      const afterRevoke = await fetchTestRequest(getEndpointUrl('/app/'), { headers: { authorization: `Bearer ${tokenJson.access_token}` } })
      expect(afterRevoke.status).toBe(401)
    }
    finally {
      // Revoked above on success; this also removes the org_super_admin key if an assertion failed first.
      await deleteUserKey(keyId)
    }
  }, 30_000)

  it('only lets the named account claim the registration', async () => {
    const registration = await register(`someone-else-${randomUUID().slice(0, 8)}@example.com`)
    const details = await fetchTestRequest(getEndpointUrl(`/private/agent_identity/?claim_attempt_token=${registration.attemptToken}`), { headers: jwtHeaders })
    await expect(details.json()).resolves.toMatchObject({ email_matches: false })
    const verify = await postJson('/private/agent_identity/verify', { claim_attempt_token: registration.attemptToken, user_code: registration.claim.user_code }, jwtHeaders)
    expect(verify.status).toBe(403)
    await expect(verify.json()).resolves.toMatchObject({ error: 'wrong_account' })
  })

  it('mints a fresh user_code at the claim endpoint and reports denial to the agent', async () => {
    const registration = await register()
    const wrongEmail = await postJson('/agent/identity/claim', { claim_token: registration.claim_token, email: 'other@example.com' })
    expect(wrongEmail.status).toBe(400)
    await expect(wrongEmail.json()).resolves.toMatchObject({ error: 'invalid_claim_token' })

    const restart = await postJson('/agent/identity/claim', { claim_token: registration.claim_token, email: USER_EMAIL })
    expect(restart.status, await restart.clone().text()).toBe(200)
    const restarted = await restart.json() as { status: string, claim_attempt: { verification_uri: string, user_code: string } }
    expect(restarted.status).toBe('initiated')
    const newAttempt = new URL(restarted.claim_attempt.verification_uri).searchParams.get('claim_attempt_token')!
    expect(newAttempt).not.toBe(registration.attemptToken)

    // The previous link stops working.
    const old = await fetchTestRequest(getEndpointUrl(`/private/agent_identity/?claim_attempt_token=${registration.attemptToken}`), { headers: jwtHeaders })
    expect(old.status).toBe(410)

    const deny = await postJson('/private/agent_identity/deny', { claim_attempt_token: newAttempt }, jwtHeaders)
    expect(deny.status, await deny.clone().text()).toBe(200)
    const denied = await poll(registration.claim_token)
    await expect(denied.json()).resolves.toMatchObject({ error: 'access_denied' })
  })

  it('revokes the key of an approved registration that expired before the agent collected it', async () => {
    const registration = await register()
    const { id: keyId, key: apikey } = await createUserKey()
    try {
      const verify = await postJson('/private/agent_identity/verify', { claim_attempt_token: registration.attemptToken, user_code: registration.claim.user_code }, jwtHeaders)
      expect(verify.status).toBe(200)
      const approve = await postJson('/private/agent_identity/approve', { claim_attempt_token: registration.attemptToken, apikey }, jwtHeaders)
      expect(approve.status).toBe(200)
      // Simulate an agent that never polled: the registration expired more than a day ago.
      await executeSQL(`UPDATE public.agent_identity_registrations SET expires_at = now() - interval '2 days' WHERE id = $1`, [registration.registration_id.slice(4)])

      await register() // any new registration runs the cleanup
      const keys = await executeSQL(`SELECT id FROM public.apikeys WHERE id = $1`, [keyId])
      expect(keys).toHaveLength(0)
      const rows = await executeSQL(`SELECT id FROM public.agent_identity_registrations WHERE id = $1`, [registration.registration_id.slice(4)])
      expect(rows).toHaveLength(0)
    }
    finally {
      await deleteUserKey(keyId)
    }
  })

  it('accepts the pre-v0.6 verified_email body as the same email flow', async () => {
    const response = await postJson('/agent/identity', { type: 'identity_assertion', assertion_type: 'verified_email', assertion: USER_EMAIL })
    expect(response.status, await response.clone().text()).toBe(200)
    const body = await response.json() as Registration
    expect(body.registration_type).toBe('service_auth')
    expect(body.claim.user_code).toMatch(/^\d{6}$/)
    const details = await fetchTestRequest(getEndpointUrl(`/private/agent_identity/?claim_attempt_token=${new URL(body.claim.verification_uri).searchParams.get('claim_attempt_token')}`), { headers: jwtHeaders })
    expect(details.status, await details.clone().text()).toBe(200)
    await expect(details.json()).resolves.toMatchObject({ email_matches: true })
  })
})
