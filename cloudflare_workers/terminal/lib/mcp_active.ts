import type { ExecutionContext } from '@cloudflare/workers-types'
import type { TerminalEnv } from '../terminal_session.ts'
import { isTerminalSessionActive } from './apikey.ts'
import { authErrorResponse } from './errors.ts'
import { inactiveTerminalMcpResponse } from './mcp_gate.ts'
import { handleTerminalMcpRequest, type TerminalMcpSession } from './mcp_serve.ts'

export async function handleTerminalMcpWhenSessionActive(
  request: Request,
  env: TerminalEnv,
  session: TerminalMcpSession,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    if (!await isTerminalSessionActive(env.HYPERDRIVE_CAPGO_DIRECT_EU, session.sessionKey))
      return inactiveTerminalMcpResponse()
  }
  catch (error) {
    return authErrorResponse(error)
  }
  return handleTerminalMcpRequest(request, env, session, ctx)
}