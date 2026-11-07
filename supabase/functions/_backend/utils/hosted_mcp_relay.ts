import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { timingSafeEqual } from 'hono/utils/buffer'
import { getEnv } from './utils.ts'

/** User-Agent set only by the hosted MCP HTTP relay in mcp/index.ts createCaller. */
export const HOSTED_MCP_RELAY_USER_AGENT = 'capgo-mcp'

/** Proof header: SHA-256 of a salted API_SECRET, minted server-side in createCaller only. */
export const HOSTED_MCP_RELAY_HEADER = 'x-capgo-hosted-mcp-relay'

const RELAY_SALT = 'capgo-hosted-mcp-relay-v1'

/** Deterministic relay proof from the platform API_SECRET (not sent raw on the wire). */
export function hostedMcpRelayProof(secret: string): string {
  return createHash('sha256').update(`${RELAY_SALT}:${secret}`).digest('hex')
}

/** Outbound headers for MCP createCaller sub-requests to the public API. */
export function hostedMcpRelayRequestHeaders(c: Context): Record<string, string> {
  const secret = getEnv(c, 'API_SECRET')
  const headers: Record<string, string> = {
    'user-agent': HOSTED_MCP_RELAY_USER_AGENT,
    'x-cli-command': 'mcp',
  }
  if (secret)
    headers[HOSTED_MCP_RELAY_HEADER] = hostedMcpRelayProof(secret)
  return headers
}

/**
 * True when createCaller added a valid relay proof (requires server-side API_SECRET).
 * Direct API and CLI callers cannot forge the proof without knowing API_SECRET.
 */
export async function isHostedMcpBuildStatusRelay(c: Context): Promise<boolean> {
  const secret = getEnv(c, 'API_SECRET')
  if (!secret)
    return false
  const expected = hostedMcpRelayProof(secret)
  const received = c.req.header(HOSTED_MCP_RELAY_HEADER) ?? ''
  if (!received || received.length !== expected.length)
    return false
  return timingSafeEqual(received, expected)
}
