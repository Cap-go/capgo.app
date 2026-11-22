export const TERMINAL_CLIENT_MCP_HEADERS = ['cf-mcp-method', 'cf-mcp-message'] as const

export function requestHasClientMcpHeaders(request: Request): boolean {
  return TERMINAL_CLIENT_MCP_HEADERS.some(name => request.headers.has(name))
}

export function stripClientMcpHeaders(request: Request): Request {
  const headers = new Headers(request.headers)
  for (const name of TERMINAL_CLIENT_MCP_HEADERS)
    headers.delete(name)
  return new Request(request, { headers })
}

export type WsConnectAuth =
  | { kind: 'ok', wsToken: string }
  | { kind: 'reject_apikey' }
  | { kind: 'unauthorized' }

export function wsConnectAuth(request: Request, url: URL): WsConnectAuth {
  if (request.headers.get('authorization')?.trim()
    || request.headers.get('capgkey')?.trim()
    || request.headers.get('x-api-key')?.trim())
    return { kind: 'reject_apikey' }
  const wsToken = url.searchParams.get('ws_token')?.trim()
  if (!wsToken)
    return { kind: 'unauthorized' }
  return { kind: 'ok', wsToken }
}