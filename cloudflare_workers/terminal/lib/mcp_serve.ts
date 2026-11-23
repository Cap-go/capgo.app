import type { ExecutionContext } from '@cloudflare/workers-types'
import { TerminalSession, type TerminalEnv, type TerminalProps } from '../terminal_session.ts'
import { wrapMcpStreamableNamespace } from './agent_routing.ts'
import { terminalMcpSessionHeaderId } from './security.ts'
import { TERMINAL_CLIENT_MCP_HEADERS } from './ws.ts'
import { mcpRequestIncludesInitialize } from './mcp_rpc.ts'

export { terminalMcpSessionHeaderId } from './security.ts'

export type TerminalMcpServeContext = ExecutionContext & {
  props?: TerminalProps
}

export type TerminalMcpSession = {
  sessionKey: string
  orgId: string
  appId: string
}

export { mcpRequestIncludesInitialize } from './mcp_rpc.ts'

const MAXIMUM_MESSAGE_SIZE_BYTES = 4 * 1024 * 1024

let terminalMcpHttp: ReturnType<typeof TerminalSession.serve> | null = null

function terminalMcpHttpHandler() {
  terminalMcpHttp ??= TerminalSession.serve('/terminal/mcp', { binding: 'TERMINAL_SESSION' })
  return terminalMcpHttp
}

function mcpServeContext(session: TerminalMcpSession): TerminalMcpServeContext {
  return {
    props: {
      sessionKey: session.sessionKey,
      orgId: session.orgId,
      appId: session.appId,
    },
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as TerminalMcpServeContext
}

export async function handleTerminalMcpRequest(
  request: Request,
  env: TerminalEnv,
  session: TerminalMcpSession,
): Promise<Response> {
  const terminalEnv: TerminalEnv = {
    ...env,
    TERMINAL_SESSION: await wrapMcpStreamableNamespace(env.TERMINAL_SESSION, session.sessionKey),
  }
  if (request.method !== 'POST')
    return terminalMcpHttpHandler().fetch(request, terminalEnv, mcpServeContext(session))
  const declaredLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (declaredLength > MAXIMUM_MESSAGE_SIZE_BYTES) {
    return Response.json({
      jsonrpc: '2.0',
      error: { code: -32_000, message: `Request body too large. Maximum size is ${MAXIMUM_MESSAGE_SIZE_BYTES} bytes` },
      id: null,
    }, { status: 413 })
  }
  const bodyText = await request.text()
  if (new TextEncoder().encode(bodyText).byteLength > MAXIMUM_MESSAGE_SIZE_BYTES) {
    return Response.json({
      jsonrpc: '2.0',
      error: { code: -32_000, message: `Request body too large. Maximum size is ${MAXIMUM_MESSAGE_SIZE_BYTES} bytes` },
      id: null,
    }, { status: 413 })
  }
  let rawBody: unknown
  try {
    rawBody = JSON.parse(bodyText)
  }
  catch {
    return Response.json({
      jsonrpc: '2.0',
      error: { code: -32_700, message: 'Parse error: Invalid JSON' },
      id: null,
    }, { status: 400 })
  }

  const pinned = await terminalMcpSessionHeaderId(session.sessionKey)
  const headers = new Headers(request.headers)
  for (const name of TERMINAL_CLIENT_MCP_HEADERS)
    headers.delete(name)
  if (!mcpRequestIncludesInitialize(rawBody))
    headers.set('mcp-session-id', pinned)

  const routed = new Request(request.url, { method: request.method, headers, body: bodyText })
  return terminalMcpHttpHandler().fetch(routed, terminalEnv, mcpServeContext(session))
}