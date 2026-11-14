import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { closeClient, getPgClient, withPgTransaction } from '../utils/pg.ts'
import { getClientIP } from '../utils/rate_limit.ts'
import { getEnv } from '../utils/utils.ts'
import { sha256Hex } from './oauth_utils.ts'

/** Helpers shared by the MCP OAuth server (oauth.ts) and auth.md agent registration (agent_identity.ts). */
export type McpContext = Context<MiddlewareKeyVariables>

export const MCP_PATH = '/mcp'
export const MCP_OAUTH_PATH = '/mcp/oauth'
export const MCP_ALIAS_HOST = 'mcp.capgo.app'
export const MCP_PUBLIC_PATH_HEADER = 'x-capgo-mcp-public-path'

export function getRequestOrigin(c: Context): string {
  return new URL(c.req.url).origin
}

export function isMcpAliasHost(hostname: string): boolean {
  return hostname.toLowerCase() === MCP_ALIAS_HOST
}

function requestHostname(c: Context): string {
  return new URL(c.req.url).hostname
}

/**
 * On the MCP alias host, the resource URL is the path the client used (`/` or `/mcp`).
 * The API worker sets MCP_PUBLIC_PATH_HEADER when it rewrites `/` to `/mcp`.
 */

export function getMcpPublicPath(c: Context): '/' | '/mcp' | null {
  if (!isMcpAliasHost(requestHostname(c)))
    return null
  const header = c.req.header(MCP_PUBLIC_PATH_HEADER)?.trim()
  if (header === '/' || header === '/mcp')
    return header
  const path = new URL(c.req.url).pathname.replace(/\/+$/, '') || '/'
  if (path === `/.well-known/oauth-protected-resource${MCP_PATH}`)
    return '/mcp'
  if (path === '/.well-known/oauth-protected-resource')
    return '/'
  if (path === '/mcp' || path.startsWith('/mcp/'))
    return '/mcp'
  if (path === '/')
    return '/'
  return '/'
}

/**
 * Canonical origin of the OAuth endpoints and the MCP resource. Production sets MCP_OAUTH_API_ORIGIN=https://api.capgo.app
 * for the API host; the MCP alias host uses the request origin. Unset, the request origin is used (local workers).
 */

export function getApiOrigin(c: Context): string {
  if (isMcpAliasHost(requestHostname(c)))
    return getRequestOrigin(c)
  return getEnv(c, 'MCP_OAUTH_API_ORIGIN').trim().replace(/\/+$/, '') || getRequestOrigin(c)
}

/**
 * OAuth issuer identifier (RFC 8414). Production sets MCP_OAUTH_ISSUER=https://capgo.app, which serves this
 * metadata at its own /.well-known/oauth-authorization-server; the endpoints stay on the API origin.
 */

export function getIssuer(c: Context): string {
  return getEnv(c, 'MCP_OAUTH_ISSUER').trim().replace(/\/+$/, '') || getApiOrigin(c)
}

export function getResourceUrl(c: Context): string {
  const aliasPath = getMcpPublicPath(c)
  if (aliasPath !== null) {
    const origin = getRequestOrigin(c)
    return aliasPath === '/' ? `${origin}/` : `${origin}${MCP_PATH}`
  }
  return `${getApiOrigin(c)}${MCP_PATH}`
}

/** Stable MCP server card URL (never append paths to getResourceUrl, which may end with `/`). */
export function getMcpServerCardUrl(c: Context): string {
  return `${getApiOrigin(c)}${MCP_PATH}/server-card`
}

/** OAuth resource parameter: alias root `/` and `/mcp` refer to the same MCP resource. */
export function canonicalMcpResourceUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed)
    return trimmed
  try {
    const parsed = new URL(trimmed)
    const path = parsed.pathname.replace(/\/+$/, '') || '/'
    if (isMcpAliasHost(parsed.hostname) && (path === '/' || path === MCP_PATH))
      return `${parsed.origin}${MCP_PATH}`
    const suffix = path === '/' ? '' : path
    return `${parsed.origin}${suffix}`.replace(/\/+$/, '') || `${parsed.origin}${MCP_PATH}`
  }
  catch {
    return trimmed.replace(/\/+$/, '')
  }
}

export function mcpResourceUrlsMatch(requested: string, expected: string): boolean {
  return canonicalMcpResourceUrl(requested) === canonicalMcpResourceUrl(expected)
}

/** RFC 6749 §5.2 / RFC 7591 §3.2.2 error body. These shapes are mandated by the OAuth specs. */

export function oauthError(c: McpContext, status: 400 | 401 | 403 | 404 | 429 | 500 | 503, error: string, description: string) {
  c.header('Cache-Control', 'no-store')
  return c.json({ error, error_description: description }, status)
}

export async function readParams(c: McpContext): Promise<Record<string, string>> {
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

export async function withPg<T>(c: McpContext, fn: (pg: Awaited<ReturnType<typeof getPgClient>>) => Promise<T>): Promise<T> {
  const pg = await getPgClient(c)
  try {
    return await fn(pg)
  }
  finally {
    await closeClient(c, pg)
  }
}

type PgTransactionClient = Parameters<Parameters<typeof withPgTransaction>[1]>[0]

/** SHA-256 of the caller IP (never store raw IPs); null when the IP is unknown (fail open like other limiters). */

export async function getClientIpHash(c: McpContext): Promise<string | null> {
  const ip = getClientIP(c)
  return ip === 'unknown' ? null : sha256Hex(`mcp-oauth-ip:${ip}`)
}

/**
 * Atomic per-IP limit for unauthenticated inserts: a transaction-scoped advisory lock on the IP
 * hash serializes concurrent requests from one IP, so the count check and the insert cannot race.
 * Returns null when the IP is over the limit.
 */

export async function insertWithIpLimit<T>(
  c: McpContext,
  table: 'mcp_oauth_clients' | 'mcp_oauth_requests' | 'agent_identity_registrations',
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

