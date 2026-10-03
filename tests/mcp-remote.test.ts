import { createHash, randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { beforeAll, describe, expect, it } from 'vitest'
import { fetchTestRequest, getAuthHeaders, getEndpointUrl, ORG_ID, USER_ID } from './test-utils.ts'

// The hosted MCP server and its OAuth endpoints live on the Cloudflare API worker only.
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'
const REDIRECT_URI = 'http://127.0.0.1:33418/callback'

let jwtHeaders: Record<string, string>

function pkcePair() {
  const verifier = `${randomUUID()}${randomUUID()}`
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function registerClient(): Promise<string> {
  const response = await fetchTestRequest(getEndpointUrl('/mcp/oauth/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Vitest MCP', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
  })
  expect(response.status).toBe(201)
  const body = await response.json() as { client_id: string }
  return body.client_id
}

async function startAuthorization(clientId: string, challenge: string, state: string): Promise<string> {
  const url = new URL(getEndpointUrl('/mcp/oauth/authorize'))
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'capgo',
  }).toString()
  const response = await fetchTestRequest(url.toString(), { redirect: 'manual' })
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location') ?? '')
  expect(location.pathname, location.toString()).toBe('/oauth/authorize')
  const requestId = location.searchParams.get('request')
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
  return requestId!
}

async function createUserKey(): Promise<string> {
  const response = await fetchTestRequest(getEndpointUrl('/apikey'), {
    method: 'POST',
    headers: jwtHeaders,
    body: JSON.stringify({
      name: `MCP · vitest-${randomUUID().slice(0, 8)}`,
      // Keys handed to MCP OAuth clients must expire within 90 days, like the consent page sets.
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      bindings: [{ role_name: 'org_super_admin', scope_type: 'org', org_id: ORG_ID }],
    }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const body = await response.json() as { key: string }
  return body.key
}

async function mcp(token: string, body: unknown): Promise<Response> {
  return fetchTestRequest(getEndpointUrl('/mcp'), {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  if (USE_CLOUDFLARE)
    jwtHeaders = await getAuthHeaders()
})

describe.skipIf(!USE_CLOUDFLARE)('hosted MCP OAuth flow', () => {
  it('logs a client in with OAuth 2.1 + PKCE and serves tools with the minted key', async () => {
    const clientId = await registerClient()
    const { verifier, challenge } = pkcePair()
    const state = randomUUID()
    const requestId = await startAuthorization(clientId, challenge, state)

    const details = await fetchTestRequest(getEndpointUrl(`/private/mcp_oauth?request=${requestId}`), { headers: jwtHeaders })
    expect(details.status).toBe(200)
    await expect(details.json()).resolves.toMatchObject({ client_name: 'Vitest MCP', redirect_host: '127.0.0.1:33418' })

    const apikey = await createUserKey()
    const approve = await fetchTestRequest(getEndpointUrl('/private/mcp_oauth/approve'), {
      method: 'POST',
      headers: jwtHeaders,
      body: JSON.stringify({ request: requestId, apikey }),
    })
    expect(approve.status, await approve.clone().text()).toBe(200)
    const redirect = new URL((await approve.json() as { redirect_to: string }).redirect_to)
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI)
    expect(redirect.searchParams.get('state')).toBe(state)
    const code = redirect.searchParams.get('code')!
    expect(code).toBeTruthy()

    const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT_URI })
    const token = await fetchTestRequest(getEndpointUrl('/mcp/oauth/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    })
    expect(token.status, await token.clone().text()).toBe(200)
    const tokenJson = await token.json() as { access_token: string, token_type: string }
    expect(tokenJson).toMatchObject({ access_token: apikey, token_type: 'Bearer' })

    // Codes are single use.
    const replay = await fetchTestRequest(getEndpointUrl('/mcp/oauth/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    })
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ error: 'invalid_grant' })

    const init = await mcp(tokenJson.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } } })
    expect(init.status).toBe(200)
    await expect(init.json()).resolves.toMatchObject({ result: { serverInfo: { name: 'capgo' } } })

    const whoami = await mcp(tokenJson.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capgo_whoami', arguments: {} } })
    expect(JSON.stringify(await whoami.json())).toContain(USER_ID)

    const orgs = await mcp(tokenJson.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'capgo_list_organizations', arguments: {} } })
    const orgsJson = await orgs.json() as { result: { isError?: boolean, content: Array<{ text: string }> } }
    expect(orgsJson.result.isError).toBeUndefined()
    expect(orgsJson.result.content[0].text).toContain(ORG_ID)

    const revoke = await fetchTestRequest(getEndpointUrl('/mcp/oauth/revoke'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokenJson.access_token }).toString(),
    })
    expect(revoke.status).toBe(200)
    const afterRevoke = await mcp(tokenJson.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/list' })
    expect(afterRevoke.status).toBe(401)
    expect(afterRevoke.headers.get('www-authenticate')).toContain('invalid_token')
  })

  it('returns access_denied to the client when the user denies', async () => {
    const clientId = await registerClient()
    const { challenge } = pkcePair()
    const state = randomUUID()
    const requestId = await startAuthorization(clientId, challenge, state)

    const deny = await fetchTestRequest(getEndpointUrl('/private/mcp_oauth/deny'), {
      method: 'POST',
      headers: jwtHeaders,
      body: JSON.stringify({ request: requestId }),
    })
    expect(deny.status).toBe(200)
    const redirect = new URL((await deny.json() as { redirect_to: string }).redirect_to)
    expect(redirect.searchParams.get('error')).toBe('access_denied')
    expect(redirect.searchParams.get('state')).toBe(state)

    const again = await fetchTestRequest(getEndpointUrl(`/private/mcp_oauth?request=${requestId}`), { headers: jwtHeaders })
    expect(again.status).toBe(410)
  })

  it('refuses to hand a non-expiring API key to an OAuth client', async () => {
    const clientId = await registerClient()
    const requestId = await startAuthorization(clientId, pkcePair().challenge, randomUUID())
    const created = await fetchTestRequest(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: jwtHeaders,
      body: JSON.stringify({
        name: `MCP · vitest-noexp-${randomUUID().slice(0, 8)}`,
        bindings: [{ role_name: 'org_super_admin', scope_type: 'org', org_id: ORG_ID }],
      }),
    })
    expect(created.status).toBe(200)
    const { key } = await created.json() as { key: string }

    const approve = await fetchTestRequest(getEndpointUrl('/private/mcp_oauth/approve'), {
      method: 'POST',
      headers: jwtHeaders,
      body: JSON.stringify({ request: requestId, apikey: key }),
    })
    expect(approve.status).toBe(400)
    await expect(approve.json()).resolves.toMatchObject({ error: 'apikey_expiration_required' })
  })

  it('rejects unregistered redirect URIs without redirecting', async () => {
    const clientId = await registerClient()
    const url = new URL(getEndpointUrl('/mcp/oauth/authorize'))
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://attacker.example/callback',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
    }).toString()
    const response = await fetchTestRequest(url.toString(), { redirect: 'manual' })
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })

  it('accepts a pasted API key as bearer token', async () => {
    const apikey = await createUserKey()
    const response = await mcp(apikey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { tools: Array<{ name: string }> } }
    expect(body.result.tools.map(tool => tool.name)).toContain('capgo_list_apps')
  })
})
