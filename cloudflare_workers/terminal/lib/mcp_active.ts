import type { TerminalEnv } from '../terminal_session.ts'
import { isTerminalSessionActive } from './apikey.ts'
import { inactiveTerminalMcpResponse } from './mcp_gate.ts'
import { handleTerminalMcpRequest, type TerminalMcpSession } from './mcp_serve.ts'

export async function handleTerminalMcpWhenSessionActive(
  request: Request,
  env: TerminalEnv,
  session: TerminalMcpSession,
): Promise<Response> {
  if (!await isTerminalSessionActive(env.HYPERDRIVE_CAPGO_DIRECT_EU, session.sessionKey))
    return inactiveTerminalMcpResponse()
  return handleTerminalMcpRequest(request, env, session)
}