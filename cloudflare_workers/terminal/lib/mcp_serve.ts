import { TerminalSession, type TerminalEnv } from '../terminal_session.ts'
import { terminalMcpSessionHeaderId } from './security.ts'
import { stripClientMcpHeaders } from './ws.ts'

export { terminalMcpSessionHeaderId } from './security.ts'

type TerminalMcpHttpWorker = {
  fetch: (request: Request, env: TerminalEnv, ctx: ExecutionContext) => Promise<Response>
}

let terminalMcpHttp: TerminalMcpHttpWorker | null = null

function terminalMcpHttpHandler(): TerminalMcpHttpWorker {
  terminalMcpHttp ??= TerminalSession.serve('/terminal/mcp', {
    binding: 'TERMINAL_SESSION',
    transport: 'streamable-http',
  }) as TerminalMcpHttpWorker
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
  const headers = new Headers(stripClientMcpHeaders(request).headers)
  headers.set('mcp-session-id', mcpSessionId)
  const routed = new Request(stripClientMcpHeaders(request), { headers })
  const ctx = {
    props: {
      sessionKey: session.sessionKey,
      orgId: session.orgId,
      appId: session.appId,
    },
  } as unknown as ExecutionContext
  return terminalMcpHttpHandler().fetch(routed, env, ctx)
}