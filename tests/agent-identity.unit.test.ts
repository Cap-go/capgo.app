import { afterEach, describe, expect, it, vi } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'
import {
  AGENT_AUTH_CLAIM_GRANT,
  createClaimKeyPair,
  generateUserCode,
  maskEmail,
  newClaimToken,
  normalizeLoginHint,
  openWithClaimToken,
  sealToClaimKey,
} from '../supabase/functions/_backend/mcp/agent_identity_utils.ts'
import { decryptWithCode } from '../supabase/functions/_backend/mcp/oauth_utils.ts'

const API = 'https://api.capgo.app'

function postJson(path: string, body: unknown) {
  return apiWorker.fetch(new Request(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('auth.md agent identity helpers', () => {
  it('seals the API key so only the claim_token holder can open it', async () => {
    const claimToken = newClaimToken()
    const { publicKey, encryptedPrivateKey } = await createClaimKeyPair(claimToken)
    const sealed = await sealToClaimKey(publicKey, 'ae6e7458-c46d-4c00-aa3b-153b0b8520ea')

    expect(sealed).not.toContain('ae6e7458')
    // The stored private key only opens with the claim_token: another token cannot recover the JWK.
    const privateJwk = JSON.parse(await decryptWithCode(encryptedPrivateKey, claimToken) ?? '{}') as JsonWebKey
    expect(privateJwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(privateJwk.d).toBeTruthy()
    await expect(decryptWithCode(encryptedPrivateKey, newClaimToken())).resolves.toBeNull()
    await expect(openWithClaimToken(sealed, encryptedPrivateKey, claimToken)).resolves.toBe('ae6e7458-c46d-4c00-aa3b-153b0b8520ea')
    await expect(openWithClaimToken(sealed, encryptedPrivateKey, newClaimToken())).resolves.toBeNull()
    await expect(openWithClaimToken('broken', encryptedPrivateKey, claimToken)).resolves.toBeNull()
  })

  it('uses a fresh ephemeral key for every seal', async () => {
    const { publicKey } = await createClaimKeyPair(newClaimToken())
    expect(await sealToClaimKey(publicKey, 'same')).not.toBe(await sealToClaimKey(publicKey, 'same'))
  })

  it('generates six-digit user codes', () => {
    const codes = new Set(Array.from({ length: 200 }, generateUserCode))
    for (const code of codes)
      expect(code).toMatch(/^\d{6}$/)
    expect(codes.size).toBeGreaterThan(190)
  })

  it('accepts only email login hints and normalises them', () => {
    expect(normalizeLoginHint('  Dev@Example.COM ')).toBe('dev@example.com')
    expect(normalizeLoginHint('not-an-email')).toBeNull()
    expect(normalizeLoginHint(42)).toBeNull()
    expect(normalizeLoginHint(`${'a'.repeat(250)}@example.com`)).toBeNull()
    expect(maskEmail('dev@example.com')).toBe('d***@example.com')
    expect(newClaimToken()).toMatch(/^clm_[\w-]{43}$/)
  })
})

describe('auth.md agent identity endpoints', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('advertises agent_auth and the claim grant in the authorization server metadata', async () => {
    vi.stubEnv('MCP_OAUTH_ISSUER', 'https://capgo.app')
    vi.stubEnv('MCP_OAUTH_API_ORIGIN', 'https://api.capgo.app')
    const response = await apiWorker.fetch(new Request(`${API}/mcp/oauth/metadata`))
    const metadata = await response.json() as Record<string, any>
    expect(metadata.grant_types_supported).toEqual(['authorization_code', AGENT_AUTH_CLAIM_GRANT])
    // Endpoints sit on the issuer origin (capgo.app forwards them to the API worker), with the v0.1 aliases.
    expect(metadata.agent_auth).toEqual({
      skill: 'https://capgo.app/auth.md',
      identity_endpoint: 'https://capgo.app/agent/identity',
      claim_endpoint: 'https://capgo.app/agent/identity/claim',
      register_uri: 'https://capgo.app/agent/identity',
      claim_uri: 'https://capgo.app/agent/identity/claim',
      identity_types_supported: ['service_auth', 'identity_assertion'],
      identity_assertion: {
        assertion_types_supported: ['verified_email'],
        credential_types_supported: ['urn:ietf:params:oauth:token-type:access_token'],
      },
    })
  })

  it.each([
    [{ type: 'anonymous' }, 'anonymous_not_enabled'],
    [{ type: 'identity_assertion', assertion_type: 'urn:ietf:params:oauth:token-type:id-jag', assertion: 'x.y.z' }, 'issuer_not_enabled'],
    [{ type: 'magic' }, 'invalid_request'],
    [{ type: 'service_auth', login_hint: 'nope' }, 'invalid_login_hint'],
    [{ type: 'service_auth' }, 'invalid_login_hint'],
    [{ type: 'identity_assertion', assertion_type: 'verified_email', assertion: 'nope' }, 'invalid_login_hint'],
  ])('rejects %j with %s before touching the database', async (body, error) => {
    const response = await postJson('/agent/identity', body)
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({ error })
  })

  it.each([
    [{ type: 'service_auth', login_hint: 'nope' }, 'login_hint'],
    [{ type: 'identity_assertion', assertion_type: 'verified_email', assertion: 'nope' }, 'assertion'],
  ])('names the invalid email field for %j', async (body, field) => {
    const response = await postJson('/agent/identity', body)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_login_hint',
      error_description: `${field} must be the user's email address`,
    })
  })

  it('requires claim_token and email at the claim endpoint', async () => {
    const response = await postJson('/agent/identity/claim', { claim_token: 'clm_x' })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' })
  })

  it('routes the claim grant at the token endpoint and requires a claim_token', async () => {
    const response = await apiWorker.fetch(new Request(`${API}/mcp/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: AGENT_AUTH_CLAIM_GRANT }),
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request', error_description: 'claim_token is required' })
  })

  it('still rejects unknown grant types', async () => {
    const response = await apiWorker.fetch(new Request(`${API}/mcp/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password' }),
    }))
    await expect(response.json()).resolves.toMatchObject({ error: 'unsupported_grant_type' })
  })

  it('requires a console session on the private claim endpoints', async () => {
    const response = await apiWorker.fetch(new Request(`${API}/private/agent_identity/?claim_attempt_token=${'a'.repeat(43)}`))
    expect(response.status).toBe(401)
  })
})
