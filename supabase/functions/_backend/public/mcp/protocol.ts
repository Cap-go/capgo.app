export const MCP_PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'] as const
export const MCP_PROTOCOL_VERSION = '2025-03-26'
export const MCP_SCOPE = 'capgo'
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const AUTH_CODE_TTL_SECONDS = 10 * 60
export const SERVER_NAME = 'capgo'
export const SERVER_INSTRUCTIONS = [
  'Capgo remote MCP. The caller is signed in with OAuth or a Capgo API key.',
  'Use the capgo_* tools for apps, bundles, channels, organizations, members, devices, statistics, audit logs, webhooks, native builds, and push notifications.',
  'List apps or organizations before guessing ids.',
  'Confirm with the user before delete tools. They remove cloud data.',
  'Uploading a zip from disk, writing encryption keys into a project, doctor, and probe stay on the local CLI: npx @capgo/cli@latest mcp.',
].join(' ')

const FUNCTIONS_MCP = '/functions/v1/mcp'

export function isSupportedProtocolVersion(version: string): boolean {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)
}

export function negotiateProtocolVersion(clientVersion: unknown): string {
  if (typeof clientVersion === 'string' && isSupportedProtocolVersion(clientVersion))
    return clientVersion
  return MCP_PROTOCOL_VERSION
}

export function resolvePublicRequestUrl(requestUrl: string, forwardedUrl?: string | null): string {
  if (!forwardedUrl?.startsWith('http'))
    return requestUrl
  try {
    const request = new URL(requestUrl)
    const forwarded = new URL(forwardedUrl)
    // Same origin only. A different origin would send the org API key to that host.
    if (forwarded.origin !== request.origin)
      return requestUrl
    return forwarded.toString()
  }
  catch {
    return requestUrl
  }
}

export function rewriteSupabaseMcpUrl(requestUrl: string): string {
  const url = new URL(requestUrl)
  const index = url.pathname.indexOf(FUNCTIONS_MCP)
  const rest = index >= 0 ? url.pathname.slice(index + FUNCTIONS_MCP.length) : url.pathname
  if (rest === '' || rest === '/')
    url.pathname = '/mcp'
  else if (rest.startsWith('/.well-known') || rest.startsWith('/mcp'))
    url.pathname = rest
  else
    url.pathname = `/mcp${rest.startsWith('/') ? rest : `/${rest}`}`
  return url.toString()
}

export function mcpResourceUrl(requestUrl: string): string {
  const url = new URL(requestUrl)
  const index = url.pathname.indexOf(FUNCTIONS_MCP)
  if (index >= 0)
    return `${url.origin}${url.pathname.slice(0, index + FUNCTIONS_MCP.length)}`
  return `${url.origin}/mcp`
}

export function issuerUrl(requestUrl: string): string {
  const url = new URL(requestUrl)
  if (url.pathname.includes('/functions/v1/mcp'))
    return mcpResourceUrl(requestUrl)
  return url.origin
}

export function capgoApiRoot(requestUrl: string): string {
  const url = new URL(requestUrl)
  const marker = '/functions/v1/'
  const index = url.pathname.indexOf(marker)
  if (index >= 0)
    return `${url.origin}${url.pathname.slice(0, index + marker.length - 1)}`
  return url.origin
}

export function oauthEndpoints(requestUrl: string) {
  const resource = mcpResourceUrl(requestUrl)
  const issuer = issuerUrl(requestUrl)
  return {
    resource,
    issuer,
    authorizationEndpoint: `${resource}/oauth/authorize`,
    tokenEndpoint: `${resource}/oauth/token`,
    registrationEndpoint: `${resource}/oauth/register`,
    revocationEndpoint: `${resource}/oauth/revoke`,
    protectedResourceMetadata: `${issuer}/.well-known/oauth-protected-resource`,
  }
}

export function protectedResourceMetadata(requestUrl: string) {
  const endpoints = oauthEndpoints(requestUrl)
  return {
    resource: endpoints.resource,
    authorization_servers: [endpoints.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [MCP_SCOPE],
  }
}

export function authorizationServerMetadata(requestUrl: string) {
  const endpoints = oauthEndpoints(requestUrl)
  return {
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorizationEndpoint,
    token_endpoint: endpoints.tokenEndpoint,
    registration_endpoint: endpoints.registrationEndpoint,
    revocation_endpoint: endpoints.revocationEndpoint,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
  }
}

export function wwwAuthenticate(requestUrl: string, error?: string): string {
  const metadata = oauthEndpoints(requestUrl).protectedResourceMetadata
  const parts = ['Bearer realm="capgo"', `resource_metadata="${metadata}"`]
  if (error)
    parts.push(`error="${error}"`)
  return parts.join(', ')
}

export function bearerToken(header: string | undefined): string | null {
  if (!header)
    return null
  const trimmed = header.trim()
  if (!trimmed)
    return null
  if (/^bearer\s+/i.test(trimmed))
    return trimmed.replace(/^bearer\s+/i, '').trim() || null
  return trimmed
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `${prefix}${base64UrlEncode(bytes)}`
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}

export function validateCodeVerifier(verifier: string): string | null {
  if (verifier.length < 43 || verifier.length > 128)
    return 'code_verifier must be 43 to 128 characters'
  if (!/^[\w.~-]+$/.test(verifier))
    return 'code_verifier has invalid characters'
  return null
}

export function validateRedirectUri(uri: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(uri)
  }
  catch {
    return 'redirect_uri must be an absolute URL'
  }
  if (parsed.username || parsed.password)
    return 'redirect_uri must not include credentials'
  if (parsed.hash)
    return 'redirect_uri must not include a fragment'
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
  if (parsed.protocol === 'https:')
    return null
  if (parsed.protocol === 'http:' && loopback)
    return null
  return 'redirect_uri must be https, or http on localhost'
}

export function appendRedirectQuery(uri: string, params: Record<string, string>): string {
  const url = new URL(uri)
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value)
  return url.toString()
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export interface JsonRpcRequest {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

export function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

export function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}
