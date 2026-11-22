import { TerminalSession, type TerminalEnv } from '../terminal_session.ts'
import { terminalMcpSessionHeaderId } from './security.ts'

export { terminalMcpSessionHeaderId } from './security.ts'

let terminalMcpHttp: { fetch: typeof fetch } | null = null

function terminalMcpHttpHandler() {
  if (!terminalMcpHttp) {
    terminalMcpHttp = TerminalSession.serve('/terminal/mcp', {
      binding: 'TERMINAL_SESSION',
      transport: 'streamable-http',
    })
  }
  return terminalMcpHttp
}

export type TerminalMcpSession = {
  sessionKey: string
  orgId: string
  appId: string
}

export async function handleTerminalMcpRequest(
  request: Request,
  env: TerminalEnv,
  session: TerminalMcpSession,
): Promise<Response> {
  const mcpSessionId = await terminalMcpSessionHeaderId(session.sessionKey)
  const headers = new Headers(request.headers)
  headers.set('mcp-session-id', mcpSessionId)
  const routed = new Request(request, { headers })
  const ctx = {
    props: {
      sessionKey: session.sessionKey,
      orgId: session.orgId,
      appId: session.appId,
    },
  } as unknown as ExecutionContext
  return terminalMcpHttpHandler().fetch(routed, env, ctx)
}