import type { Context } from 'hono'

/** User-Agent set only by the hosted MCP HTTP relay in mcp/index.ts createCaller. */
export const HOSTED_MCP_RELAY_USER_AGENT = 'capgo-mcp'

/**
 * True when this request was issued by the hosted MCP server-side relay, not a direct API or CLI client.
 * CLI traffic always carries x-cli-version; external callers cannot mimic the relay without forging User-Agent.
 */
export function isHostedMcpBuildStatusRelay(c: Context): boolean {
  if (c.req.header('user-agent') !== HOSTED_MCP_RELAY_USER_AGENT)
    return false
  if (c.req.header('x-cli-version'))
    return false
  return true
}
