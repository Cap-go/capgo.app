import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient, withPgTransaction } from '../utils/pg.ts'
import { getClientIP, isIPRateLimited, recordFailedAuth } from '../utils/rate_limit.ts'
import { getEnv } from '../utils/utils.ts'
import {
  buildRedirectUrl,
  decryptWithCode,
  isAllowedRedirectUri,
  isClientIdMetadataUrl,
  isValidCodeChallenge,
  MCP_OAUTH_REQUEST_TTL_SECONDS,
  MCP_OAUTH_SCOPE,
  randomToken,
  redirectUriMatches,
  sanitizeClientName,
  sha256Hex,
  verifyPkceS256,
} from './oauth_utils.ts'

type McpContext = Context<MiddlewareKeyVariables>

export interface McpOAuthClient {
  client_id: string
  client_name: string
  client_uri: string | null
  logo_uri: string | null
  redirect_uris: string[]
}

export const MCP_PATH = '/mcp'
export const MCP_OAUTH_PATH = '/mcp/oauth'
export const CONSENT_PAGE_PATH = '/oauth/authorize'

/** Public origin of this API (issuer + resource). Uses the request origin so local workers work too. */
export function getIssuer(c: Context): string {
  return new URL(c.req.url).origin
}

export function getResourceUrl(c: Context): string {
  return `${getIssuer(c)}${MCP_PATH}`
}

export function getProtectedResourceMetadataUrl(c: Context): string {
  return `${getIssuer(c)}/.well-known/oauth-protected-resource${MCP_PATH}`
}

/** RFC 6749 §5.2 / RFC 7591 §3.2.2 error body. These shapes are mandated by the OAuth specs. */
function oauthError(c: McpContext, status: 400 | 401 | 403 | 404 | 429 | 500 | 503, error: string, description: string) {
  c.header('Cache-Control', 'no-store')
  return c.json({ error, error_description: description }, status)
}

function authorizationServerMetadata(c: Context) {
  const issuer = getIssuer(c)
  return {
    issuer,
    authorization_endpoint: `${issuer}${MCP_OAUTH_PATH}/authorize`,
    token_endpoint: `${issuer}${MCP_OAUTH_PATH}/token`,
    registration_endpoint: `${issuer}${MCP_OAUTH_PATH}/register`,
    revocation_endpoint: `${issuer}${MCP_OAUTH_PATH}/revoke`,
    scopes_supported: [MCP_OAUTH_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://capgo.app/docs/ai/mcp/',
  }
}

function protectedResourceMetadata(c: Context) {
  return {
    resource: getResourceUrl(c),
    resource_name: 'Capgo',
    authorization_servers: [getIssuer(c)],
    bearer_methods_supported: ['header'],
    scopes_supported: [MCP_OAUTH_SCOPE],
    resource_documentation: 'https://capgo.app/docs/ai/mcp/',
  }
}

async function readParams(c: McpContext): Promise<Record<string, string>> {
  const contentType = c.req.header('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return {}
    return Object.fromEntries(Object.entries(body).filter(([, value]) => typeof value === 'string')) as Record<string, string>
  }
  const form = await c.req.parseBody().catch(() => ({}))
  return Object.fromEntries(Object.entries(form).filter(([, value]) => typeof value === 'string')) as Record<string, string>
}

async function withPg<T>(c: McpContext, fn: (pg: ReturnType<typeof getPgClient>) => Promise<T>): Promise<T> {
  const pg = getPgClient(c)
  try {
    return await fn(pg)
  }
  finally {
    await closeClient(c, pg)
  }
}

const METADATA_DOCUMENT_MAX_BYTES = 64 * 1024
// Unauthenticated endpoints that insert rows: generous for real clients, tight enough to stop floods.
const REGISTER_RATE_LIMIT = { limit: 20, windowSeconds: 60 * 60 }
const AUTHORIZE_RATE_LIMIT = { limit: 60, windowSeconds: 60 * 10 }

type PgTransactionClient = Parameters<Parameters<typeof withPgTransaction>[1]>[0]

/** SHA-256 of the caller IP (never store raw IPs); null when the IP is unknown (fail open like other limiters). */
async function getClientIpHash(c: McpContext): Promise<string | null> {
  const ip = getClientIP(c)
  return ip === 'unknown' ? null : sha256Hex(`mcp-oauth-ip:${ip}`)
}

/**
 * Atomic per-IP limit for unauthenticated inserts: a transaction-scoped advisory lock on the IP
 * hash serializes concurrent requests from one IP, so the count check and the insert cannot race.
 * Returns null when the IP is over the limit.
 */
async function insertWithIpLimit<T>(
  c: McpContext,
  table: 'mcp_oauth_clients' | 'mcp_oauth_requests',
  ipHash: string | null,
  limit: { limit: number, windowSeconds: number },
  insert: (client: PgTransactionClient) => Promise<T>,
): Promise<T | null> {
  return withPg(c, pg => withPgTransaction(pg, async (client) => {
    if (ipHash) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${table}:${ipHash}`])
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) FROM public.${table} WHERE ip_hash = $1 AND created_at > now() - make_interval(secs => $2)`,
        [ipHash, limit.windowSeconds],
      )
      if (Number(rows[0]?.count ?? 0) >= limit.limit)
        return null
    }
    return insert(client)
  }))
}

/** Read a response body but stop (and fail) as soon as it exceeds maxBytes. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes)
    return null
  const reader = response.body?.getReader()
  if (!reader)
    return ''
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/** Resolve a Client ID Metadata Document (the MCP 2025-11-25 preferred client identification). */
async function fetchClientMetadataDocument(c: McpContext, clientId: string): Promise<McpOAuthClient | null> {
  try {
    const response = await fetch(clientId, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok)
      return null
    const text = await readBoundedText(response, METADATA_DOCUMENT_MAX_BYTES)
    if (text === null)
      return null
    const doc = JSON.parse(text) as Record<string, unknown>
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris))
      return null
    const redirectUris = doc.redirect_uris.filter(isAllowedRedirectUri)
    if (redirectUris.length === 0)
      return null
    return {
      client_id: clientId,
      client_name: sanitizeClientName(doc.client_name, new URL(clientId).hostname),
      client_uri: typeof doc.client_uri === 'string' ? doc.client_uri : null,
      logo_uri: typeof doc.logo_uri === 'string' ? doc.logo_uri : null,
      redirect_uris: redirectUris,
    }
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'mcp_oauth_client_metadata_fetch_failed', clientId, error })
    return null
  }
}

async function resolveClient(c: McpContext, clientId: string): Promise<McpOAuthClient | null> {
  if (!clientId || clientId.length > 2000)
    return null
  if (isClientIdMetadataUrl(clientId))
    return fetchClientMetadataDocument(c, clientId)
  return withPg(c, async (pg) => {
    const { rows } = await pg.query<McpOAuthClient>(
      `SELECT client_id, client_name, client_uri, logo_uri, redirect_uris
       FROM public.mcp_oauth_clients WHERE client_id = $1`,
      [clientId],
    )
    return rows[0] ?? null
  })
}

export const app = new Hono<MiddlewareKeyVariables>()

// ---------------------------------------------------------------------------
// Discovery (RFC 9728 protected resource metadata + RFC 8414 authorization server metadata).
// Clients probe both the path-suffixed and root variants, so serve all of them.
// ---------------------------------------------------------------------------
app.get('/.well-known/oauth-protected-resource', c => c.json(protectedResourceMetadata(c)))
app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, c => c.json(protectedResourceMetadata(c)))
app.get('/.well-known/oauth-authorization-server', c => c.json(authorizationServerMetadata(c)))
app.get(`/.well-known/oauth-authorization-server${MCP_PATH}`, c => c.json(authorizationServerMetadata(c)))

// OpenAI plugin domain verification: the dashboard issues a token that must be served verbatim
// (plain text, no JSON) from the MCP hostname before the server can be connected.
app.get('/.well-known/openai-apps-challenge', (c) => {
  const token = getEnv(c, 'OPENAI_APPS_CHALLENGE_TOKEN').trim()
  c.header('Cache-Control', 'no-store')
  if (!token)
    return c.text('Not found', 404)
  return c.text(token)
})

// ---------------------------------------------------------------------------
// RFC 7591 Dynamic Client Registration (public clients only, PKCE required).
// ---------------------------------------------------------------------------
app.post(`${MCP_OAUTH_PATH}/register`, async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object')
    return oauthError(c, 400, 'invalid_client_metadata', 'Expected a JSON body')

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
  if (redirectUris.length === 0 || redirectUris.length > 20)
    return oauthError(c, 400, 'invalid_redirect_uri', 'redirect_uris must contain between 1 and 20 URIs')
  if (!redirectUris.every(isAllowedRedirectUri))
    return oauthError(c, 400, 'invalid_redirect_uri', 'redirect_uris must be https, http on localhost, or a private-use scheme, without fragment')

  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code']
  if (!grantTypes.includes('authorization_code'))
    return oauthError(c, 400, 'invalid_client_metadata', 'Only the authorization_code grant is supported')

  const clientName = sanitizeClientName(body.client_name, 'MCP client')
  const clientUri = typeof body.client_uri === 'string' && body.client_uri.startsWith('https://') ? body.client_uri.slice(0, 2000) : null
  const logoUri = typeof body.logo_uri === 'string' && body.logo_uri.startsWith('https://') ? body.logo_uri.slice(0, 2000) : null
  const clientId = `mcp_${randomToken(24)}`

  const ipHash = await getClientIpHash(c)
  const createdAt = await insertWithIpLimit(c, 'mcp_oauth_clients', ipHash, REGISTER_RATE_LIMIT, async (client) => {
    // Abandoned registrations are never used for a token; keep the table small.
    await client.query(`DELETE FROM public.mcp_oauth_clients WHERE last_used_at IS NULL AND created_at < now() - interval '7 days'`)
    const { rows } = await client.query<{ created_at: string }>(
      `INSERT INTO public.mcp_oauth_clients (client_id, client_name, client_uri, logo_uri, redirect_uris, ip_hash)
       VALUES ($1, $2, $3, $4, $5::text[], $6) RETURNING created_at`,
      [clientId, clientName, clientUri, logoUri, redirectUris, ipHash],
    )
    return rows[0]?.created_at ?? new Date().toISOString()
  })
  if (createdAt === null)
    return oauthError(c, 429, 'slow_down', 'Too many client registrations, try again later')

  cloudlog({ requestId: c.get('requestId'), message: 'mcp_oauth_client_registered', clientId, clientName })
  c.header('Cache-Control', 'no-store')
  return c.json({
    client_id: clientId,
    client_id_issued_at: Math.floor(new Date(createdAt ?? Date.now()).getTime() / 1000),
    client_name: clientName,
    client_uri: clientUri ?? undefined,
    logo_uri: logoUri ?? undefined,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: MCP_OAUTH_SCOPE,
  }, 201)
})

// ---------------------------------------------------------------------------
// Authorization endpoint: validate the client, persist the request, then hand the user to the
// Capgo console consent page (which handles login, SSO, 2FA and org policies).
// ---------------------------------------------------------------------------
app.get(`${MCP_OAUTH_PATH}/authorize`, async (c) => {
  const query = c.req.query()
  const clientId = query.client_id ?? ''
  const redirectUri = query.redirect_uri ?? ''

  const client = await resolveClient(c, clientId)
  if (!client)
    return oauthError(c, 400, 'invalid_client', 'Unknown client_id. Register the client first.')
  // Never redirect to an unvalidated URI: errors before this point are shown to the user directly.
  const resolvedRedirectUri = redirectUri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '')
  if (!resolvedRedirectUri || !redirectUriMatches(client.redirect_uris, resolvedRedirectUri))
    return oauthError(c, 400, 'invalid_request', 'redirect_uri does not match a registered redirect URI')

  const redirectError = (error: string, description: string) => c.redirect(buildRedirectUrl(resolvedRedirectUri, {
    error,
    error_description: description,
    state: query.state,
    iss: getIssuer(c),
  }), 302)

  if (query.response_type !== 'code')
    return redirectError('unsupported_response_type', 'Only response_type=code is supported')
  if (query.code_challenge_method !== 'S256' || !isValidCodeChallenge(query.code_challenge ?? ''))
    return redirectError('invalid_request', 'PKCE with code_challenge_method=S256 is required')
  const requestedScopes = (query.scope ?? MCP_OAUTH_SCOPE).split(' ').filter(Boolean)
  if (requestedScopes.some(scope => scope !== MCP_OAUTH_SCOPE))
    return redirectError('invalid_scope', `Supported scope: ${MCP_OAUTH_SCOPE}`)
  if (query.resource && query.resource.replace(/\/+$/, '') !== getResourceUrl(c))
    return redirectError('invalid_target', `resource must be ${getResourceUrl(c)}`)

  const webAppUrl = getEnv(c, 'WEBAPP_URL').replace(/\/+$/, '')
  if (!webAppUrl) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'mcp_oauth_missing_webapp_url' })
    return redirectError('server_error', 'Consent page is not configured')
  }

  const ipHash = await getClientIpHash(c)
  const requestId = await insertWithIpLimit(c, 'mcp_oauth_requests', ipHash, AUTHORIZE_RATE_LIMIT, async (tx) => {
    await tx.query(`DELETE FROM public.mcp_oauth_requests WHERE status <> 'exchanged' AND expires_at < now() - interval '1 day'`)
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO public.mcp_oauth_requests (client_id, client_name, redirect_uri, state, scope, resource, code_challenge, issuer, ip_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))
       RETURNING id`,
      [client.client_id, client.client_name, resolvedRedirectUri, query.state ?? null, MCP_OAUTH_SCOPE, query.resource ?? null, query.code_challenge, getIssuer(c), ipHash, MCP_OAUTH_REQUEST_TTL_SECONDS],
    )
    return rows[0]?.id ?? ''
  })
  if (requestId === null)
    return oauthError(c, 429, 'slow_down', 'Too many authorization requests, try again later')
  if (!requestId)
    return redirectError('server_error', 'Cannot create authorization request')

  return c.redirect(`${webAppUrl}${CONSENT_PAGE_PATH}?request=${encodeURIComponent(requestId)}`, 302)
})

// ---------------------------------------------------------------------------
// Token endpoint: exchange a single-use code (PKCE S256) for the API key minted at consent.
// ---------------------------------------------------------------------------
app.post(`${MCP_OAUTH_PATH}/token`, async (c) => {
  const rateLimit = await isIPRateLimited(c)
  if (rateLimit.limited)
    return oauthError(c, 429, 'slow_down', 'Too many failed attempts')

  const params = await readParams(c)
  if (params.grant_type !== 'authorization_code')
    return oauthError(c, 400, 'unsupported_grant_type', 'Only authorization_code is supported')
  const code = params.code ?? ''
  const verifier = params.code_verifier ?? ''
  if (!code || !verifier)
    return oauthError(c, 400, 'invalid_request', 'code and code_verifier are required')

  const codeHash = await sha256Hex(code)
  const row = await withPg(c, async (pg) => {
    // Atomically consume the code: a replayed code finds no approved row.
    const { rows } = await pg.query<{
      client_id: string
      redirect_uri: string
      code_challenge: string
      encrypted_token: string | null
      scope: string | null
      apikey_expires_at: string | null
    }>(
      `UPDATE public.mcp_oauth_requests r
       SET status = 'exchanged', exchanged_at = now()
       WHERE r.code_hash = $1 AND r.status = 'approved' AND r.code_expires_at > now()
       RETURNING r.client_id, r.redirect_uri, r.code_challenge, r.encrypted_token, r.scope,
         (SELECT a.expires_at FROM public.apikeys a WHERE a.id = r.apikey_id) AS apikey_expires_at`,
      [codeHash],
    )
    const consumed = rows[0]
    if (consumed && !isClientIdMetadataUrl(consumed.client_id))
      await pg.query(`UPDATE public.mcp_oauth_clients SET last_used_at = now() WHERE client_id = $1`, [consumed.client_id])
    return consumed ?? null
  })

  if (!row?.encrypted_token) {
    await recordFailedAuth(c)
    return oauthError(c, 400, 'invalid_grant', 'Authorization code is invalid, expired or already used')
  }
  if (params.client_id && params.client_id !== row.client_id)
    return oauthError(c, 400, 'invalid_grant', 'client_id does not match the authorization request')
  if (params.redirect_uri && params.redirect_uri !== row.redirect_uri)
    return oauthError(c, 400, 'invalid_grant', 'redirect_uri does not match the authorization request')
  if (!await verifyPkceS256(verifier, row.code_challenge)) {
    await recordFailedAuth(c)
    return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed')
  }

  const accessToken = await decryptWithCode(row.encrypted_token, code)
  if (!accessToken) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'mcp_oauth_token_decrypt_failed', clientId: row.client_id })
    return oauthError(c, 400, 'invalid_grant', 'Authorization code is invalid')
  }

  const expiresIn = row.apikey_expires_at
    ? Math.max(0, Math.floor((new Date(row.apikey_expires_at).getTime() - Date.now()) / 1000))
    : undefined
  cloudlog({ requestId: c.get('requestId'), message: 'mcp_oauth_token_issued', clientId: row.client_id })
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  return c.json({
    access_token: accessToken,
    token_type: 'Bearer',
    scope: row.scope ?? MCP_OAUTH_SCOPE,
    ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
  })
})

// ---------------------------------------------------------------------------
// RFC 7009 revocation: deletes the API key, but only keys that were minted through MCP OAuth.
// Per the RFC, unknown tokens still get a 200.
// ---------------------------------------------------------------------------
app.post(`${MCP_OAUTH_PATH}/revoke`, async (c) => {
  const params = await readParams(c)
  const token = params.token ?? ''
  if (!token)
    return oauthError(c, 400, 'invalid_request', 'token is required')

  await withPg(c, async (pg) => {
    const tokenHash = await sha256Hex(token)
    await pg.query(
      `DELETE FROM public.apikeys a
       WHERE (a.key = $1 OR a.key_hash = $2)
         AND EXISTS (SELECT 1 FROM public.mcp_oauth_requests r WHERE r.apikey_id = a.id)`,
      [token, tokenHash],
    )
  }).catch((error) => {
    cloudlogErr({ requestId: c.get('requestId'), message: 'mcp_oauth_revoke_failed', error })
  })
  c.header('Cache-Control', 'no-store')
  return c.json({})
})
