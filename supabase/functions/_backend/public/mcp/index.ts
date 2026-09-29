import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { honoFactory } from '../../utils/hono.ts'
import { middlewareAuth } from '../../utils/hono_middleware.ts'
import { checkKey, supabaseAdmin } from '../../utils/supabase.ts'
import { getEnv } from '../../utils/utils.ts'
import { version } from '../../utils/version.ts'
import {
  appendRedirectQuery,
  authorizationServerMetadata,
  bearerToken,
  isSupportedProtocolVersion,
  jsonRpcError,
  jsonRpcResult,
  MCP_SCOPE,
  negotiateProtocolVersion,
  oauthEndpoints,
  protectedResourceMetadata,
  resolvePublicRequestUrl,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  validateCodeVerifier,
  validateRedirectUri,
  wwwAuthenticate,
} from './protocol.ts'
import {
  assertOrgId,
  clientAllowsRedirect,
  consumeAuthCode,
  getOAuthClient,
  issueTokenPair,
  keyExpiresAt,
  mintMcpApiKey,
  registerOAuthClient,
  resolveOAuthAccessToken,
  revokeOAuthToken,
  rotateRefreshToken,
  storeAuthCode,
  validateRegistration,
} from './oauth.ts'
import { callMcpTool, listMcpTools, type McpCaller } from './tools.ts'

const app = honoFactory.createApp()

// Scope CORS to MCP paths. A `*` middleware on an app mounted at `/` answers
// OPTIONS for every API route and strips TUS discovery headers.
const mcpCors = cors({
  origin: '*',
  allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'MCP-Protocol-Version', 'Mcp-Protocol-Version'],
  exposeHeaders: ['WWW-Authenticate'],
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
})
app.use('/mcp', mcpCors)
app.use('/mcp/*', mcpCors)
app.use('/.well-known/oauth-protected-resource', mcpCors)
app.use('/.well-known/oauth-protected-resource/*', mcpCors)
app.use('/.well-known/oauth-authorization-server', mcpCors)

function publicUrl(c: Context): string {
  return resolvePublicRequestUrl(c.req.url, c.req.header('x-capgo-mcp-public-url'))
}

function oauthError(c: Context, status: 400 | 401 | 500, error: string, description: string) {
  return c.json({ error, error_description: description }, status)
}

function unauthorized(c: Context) {
  c.header('WWW-Authenticate', wwwAuthenticate(publicUrl(c), 'invalid_token'))
  return c.json({ error: 'unauthorized', message: 'Sign in to Capgo MCP' }, 401)
}

app.get('/.well-known/oauth-protected-resource', (c) => {
  return c.json(protectedResourceMetadata(publicUrl(c)))
})

app.get('/.well-known/oauth-protected-resource/mcp', (c) => {
  return c.json(protectedResourceMetadata(publicUrl(c)))
})

app.get('/.well-known/oauth-authorization-server', (c) => {
  return c.json(authorizationServerMetadata(publicUrl(c)))
})

app.post('/mcp/oauth/register', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = validateRegistration(body)
  if ('error' in parsed)
    return oauthError(c, 400, 'invalid_client_metadata', parsed.error)
  const client = await registerOAuthClient(c, parsed.name, parsed.redirectUris)
  return c.json({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }, 201)
})

// Client name only. The id is an unguessable DCR id, and the consent page must show who is asking.
app.get('/mcp/oauth/client/:client_id', async (c) => {
  const client = await getOAuthClient(c, c.req.param('client_id'))
  if (!client)
    return oauthError(c, 400, 'invalid_client', 'Unknown client')
  return c.json({ client_id: client.client_id, client_name: client.client_name })
})

app.get('/mcp/oauth/authorize', async (c) => {
  const clientId = c.req.query('client_id') ?? ''
  const redirectUri = c.req.query('redirect_uri') ?? ''
  const state = c.req.query('state') ?? ''
  const challenge = c.req.query('code_challenge') ?? ''
  const method = c.req.query('code_challenge_method') ?? ''
  const responseType = c.req.query('response_type') ?? ''
  if (responseType !== 'code' || !state || method !== 'S256' || !challenge)
    return oauthError(c, 400, 'invalid_request', 'response_type=code, state, and S256 PKCE are required')
  const redirectError = validateRedirectUri(redirectUri)
  if (redirectError)
    return oauthError(c, 400, 'invalid_request', redirectError)
  const client = await getOAuthClient(c, clientId)
  if (!client || !clientAllowsRedirect(client, redirectUri))
    return oauthError(c, 400, 'invalid_request', 'Unknown client or redirect_uri')
  const webapp = getEnv(c, 'WEBAPP_URL').replace(/\/$/, '')
  if (!webapp)
    return oauthError(c, 500, 'server_error', 'WEBAPP_URL is not configured')
  const target = new URL(`${webapp}/mcp/authorize`)
  for (const key of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'resource', 'scope', 'response_type']) {
    const value = c.req.query(key)
    if (value)
      target.searchParams.set(key, value)
  }
  return c.redirect(target.toString(), 302)
})

app.post('/mcp/oauth/approve', middlewareAuth(), async (c) => {
  const auth = c.get('auth')
  if (!auth || auth.authType !== 'jwt' || !auth.userId)
    return oauthError(c, 401, 'invalid_token', 'Sign in to Capgo to approve this connection')

  const body = await c.req.json().catch(() => null) as {
    decision?: string
    client_id?: string
    redirect_uri?: string
    state?: string
    code_challenge?: string
    code_challenge_method?: string
    resource?: string
    org_id?: string
  } | null
  if (!body?.client_id || !body.redirect_uri || !body.state || !body.code_challenge)
    return oauthError(c, 400, 'invalid_request', 'client_id, redirect_uri, state, and code_challenge are required')
  if (body.code_challenge_method && body.code_challenge_method !== 'S256')
    return oauthError(c, 400, 'invalid_request', 'code_challenge_method must be S256')
  const redirectError = validateRedirectUri(body.redirect_uri)
  if (redirectError)
    return oauthError(c, 400, 'invalid_request', redirectError)
  const client = await getOAuthClient(c, body.client_id)
  if (!client || !clientAllowsRedirect(client, body.redirect_uri))
    return oauthError(c, 400, 'invalid_request', 'Unknown client or redirect_uri')

  const resource = oauthEndpoints(publicUrl(c)).resource
  if (body.resource && body.resource !== resource)
    return oauthError(c, 400, 'invalid_target', 'resource does not match this MCP server')

  if (body.decision === 'deny') {
    return c.json({
      redirect_to: appendRedirectQuery(body.redirect_uri, { error: 'access_denied', state: body.state }),
    })
  }

  if (!body.org_id || !assertOrgId(body.org_id))
    return oauthError(c, 400, 'invalid_request', 'org_id must be the organization to grant')

  const userJwt = c.req.header('authorization') ?? ''
  try {
    const expiresAt = await keyExpiresAt(c, body.org_id)
    const minted = await mintMcpApiKey(c, userJwt, body.org_id, client.client_name, expiresAt)
    const code = await storeAuthCode(c, {
      clientId: client.client_id,
      userId: auth.userId,
      apikeyId: minted.id,
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
      resource,
    })
    return c.json({
      redirect_to: appendRedirectQuery(body.redirect_uri, { code, state: body.state }),
    })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Could not approve the connection'
    return oauthError(c, 400, 'access_denied', message)
  }
})

async function readTokenForm(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? ''
  if (type.includes('application/json')) {
    const json = await c.req.json().catch(() => null) as Record<string, unknown> | null
    const out: Record<string, string> = {}
    if (json) {
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === 'string')
          out[key] = value
      }
    }
    return out
  }
  const params = new URLSearchParams(await c.req.text())
  return Object.fromEntries(params.entries())
}

app.post('/mcp/oauth/token', async (c) => {
  const form = await readTokenForm(c)
  const clientId = form.client_id ?? ''
  if (!clientId)
    return oauthError(c, 400, 'invalid_client', 'client_id is required')
  try {
    if (form.grant_type === 'refresh_token') {
      if (!form.refresh_token)
        return oauthError(c, 400, 'invalid_request', 'refresh_token is required')
      const tokens = await rotateRefreshToken(c, form.refresh_token, clientId)
      return c.json({ token_type: 'Bearer', scope: MCP_SCOPE, ...tokens })
    }
    if (form.grant_type !== 'authorization_code')
      return oauthError(c, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
    if (!form.code || !form.redirect_uri || !form.code_verifier)
      return oauthError(c, 400, 'invalid_request', 'code, redirect_uri, and code_verifier are required')
    const verifierError = validateCodeVerifier(form.code_verifier)
    if (verifierError)
      return oauthError(c, 400, 'invalid_grant', verifierError)
    const code = await consumeAuthCode(c, form.code, clientId, form.redirect_uri, form.code_verifier, form.resource ?? null)
    const tokens = await issueTokenPair(c, code.client_id, code.user_id, Number(code.apikey_id))
    return c.json({ token_type: 'Bearer', scope: MCP_SCOPE, ...tokens })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_grant'
    if (message === 'invalid_target')
      return oauthError(c, 400, 'invalid_target', 'resource does not match the authorization request')
    return oauthError(c, 400, 'invalid_grant', 'Authorization code or refresh token was rejected')
  }
})

app.post('/mcp/oauth/revoke', async (c) => {
  const form = await readTokenForm(c)
  if (form.token)
    await revokeOAuthToken(c, form.token)
  return c.json({ revoked: true })
})

async function resolveCaller(c: Context): Promise<McpCaller | Response> {
  const token = bearerToken(c.req.header('authorization'))
  if (!token)
    return unauthorized(c)
  if (token.startsWith('capgo_mcp_at_')) {
    const resolved = await resolveOAuthAccessToken(c, token)
    return resolved ?? unauthorized(c)
  }
  const apikey = await checkKey(c, token, supabaseAdmin(c))
  if (!apikey?.user_id)
    return unauthorized(c)
  return {
    apiKey: token,
    userId: apikey.user_id,
    keyId: Number(apikey.id),
    keyName: apikey.name,
    expiresAt: apikey.expires_at,
  }
}

function methodNotAllowed(c: Context) {
  c.header('Allow', 'POST')
  c.header('WWW-Authenticate', wwwAuthenticate(publicUrl(c)))
  return c.json({ error: 'method_not_allowed', message: 'Capgo MCP accepts POST JSON-RPC' }, 405)
}

app.get('/mcp', methodNotAllowed)
app.delete('/mcp', methodNotAllowed)

app.post('/mcp', async (c) => {
  const caller = await resolveCaller(c)
  if (caller instanceof Response)
    return caller

  const protocolHeader = c.req.header('mcp-protocol-version')
  let message: { id?: unknown, method?: unknown, params?: unknown }
  try {
    message = await c.req.json()
  }
  catch {
    return c.json(jsonRpcError(null, -32700, 'Parse error'), 400)
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string')
    return c.json(jsonRpcError(null, -32600, 'Invalid request'), 400)

  if (message.method !== 'initialize' && protocolHeader && !isSupportedProtocolVersion(protocolHeader))
    return c.json(jsonRpcError(message.id ?? null, -32600, 'Unsupported MCP-Protocol-Version'), 400)

  if (message.method === 'notifications/initialized' || message.id === undefined)
    return c.body(null, 202)

  if (message.method === 'ping')
    return c.json(jsonRpcResult(message.id, {}))

  if (message.method === 'initialize') {
    const params = message.params as { protocolVersion?: unknown } | undefined
    return c.json(jsonRpcResult(message.id, {
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version },
      instructions: SERVER_INSTRUCTIONS,
    }))
  }

  if (message.method === 'tools/list')
    return c.json(jsonRpcResult(message.id, { tools: listMcpTools() }))

  if (message.method === 'tools/call') {
    const params = message.params as { name?: unknown, arguments?: unknown } | undefined
    if (!params || typeof params.name !== 'string')
      return c.json(jsonRpcError(message.id, -32602, 'Tool name is required'))
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {}
    try {
      const result = await callMcpTool(publicUrl(c), caller, params.name, args)
      return c.json(jsonRpcResult(message.id, {
        content: [{ type: 'text', text: result.text }],
        isError: result.isError,
      }))
    }
    catch (error) {
      const text = error instanceof Error ? error.message : 'Tool failed'
      return c.json(jsonRpcResult(message.id, {
        content: [{ type: 'text', text }],
        isError: true,
      }))
    }
  }

  return c.json(jsonRpcError(message.id, -32601, 'Method not found'))
})

export { app }
