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

export function getRequestOrigin(c: Context): string {
  return new URL(c.req.url).origin
}

/**
 * Canonical origin of the OAuth endpoints and the MCP resource. Production sets MCP_OAUTH_API_ORIGIN=https://api.capgo.app
 * so every hostname routed to this worker advertises the same resource; unset, the request origin is used (local workers).
 */

export function getApiOrigin(c: Context): string {
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
  return `${getApiOrigin(c)}${MCP_PATH}`
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

