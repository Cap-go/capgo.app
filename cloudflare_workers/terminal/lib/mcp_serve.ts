import type { TerminalEnv } from '../terminal_session.ts'
import { terminalMcpSessionHeaderId } from './security.ts'
import { createTerminalStreamingHttpHandler, type TerminalMcpContext } from './mcp_streamable_http.ts'
import { TERMINAL_CLIENT_MCP_HEADERS } from './ws.ts'
import { mcpRequestIncludesInitialize } from './mcp_rpc.ts'

export { terminalMcpSessionHeaderId } from './security.ts'

type TerminalMcpHttpWorker = {
  fetch: (request: Request, env: TerminalEnv, ctx: TerminalMcpContext) => Promise<Response>
}

let terminalMcpHttp: TerminalMcpHttpWorker | null = null

function terminalMcpHttpHandler(): TerminalMcpHttpWorker {
  terminalMcpHttp ??= createTerminalStreamingHttpHandler('/terminal/mcp', 'TERMINAL_SESSION')
  return terminalMcpHttp
}

export type TerminalMcpSession = {
  sessionKey: string
  orgId: string
  appId: string
}

export { mcpRequestIncludesInitialize } from './mcp_rpc.ts'

export async function handleTerminalMcpRequest(
  request: Request,
  env: TerminalEnv,
  session: TerminalMcpSession,
): Promise<Response> {
  const bodyText = await request.text()
  let rawBody: unknown
  try {
    rawBody = JSON.parse(bodyText)
  }
  catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const pinned = await terminalMcpSessionHeaderId(session.sessionKey)
  const headers = new Headers(request.headers)
  for (const name of TERMINAL_CLIENT_MCP_HEADERS)
    headers.delete(name)
  if (!mcpRequestIncludesInitialize(rawBody))
    headers.set('mcp-session-id', pinned)

  const routed = new Request(request.url, { method: request.method, headers, body: bodyText })
  const ctx: TerminalMcpContext = {
    props: {
      sessionKey: session.sessionKey,
      orgId: session.orgId,
      appId: session.appId,
    },
  }
  return terminalMcpHttpHandler().fetch(routed, env, ctx)
}