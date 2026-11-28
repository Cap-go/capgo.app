import type { ExecutionContext } from '@cloudflare/workers-types'
import type { TerminalEnv } from '../terminal_session.ts'
import { finishTerminalSession, isTerminalSessionActive } from './apikey.ts'
import { authErrorResponse } from './errors.ts'
import { inactiveTerminalMcpResponse } from './mcp_gate.ts'
import { handleTerminalMcpRequest, type TerminalMcpPrecheckedPost, type TerminalMcpSession } from './mcp_serve.ts'

export type TerminalMcpActiveOptions = {
  sessionOwnedThisRequest?: boolean
  precheckedPost?: TerminalMcpPrecheckedPost
}

export async function handleTerminalMcpWhenSessionActive(
  request: Request,
  env: TerminalEnv,
  session: TerminalMcpSession,
  ctx: ExecutionContext,
  options?: TerminalMcpActiveOptions,
): Promise<Response> {
  try {
    if (!await isTerminalSessionActive(env.HYPERDRIVE_CAPGO_DIRECT_EU, session.sessionKey))
      return inactiveTerminalMcpResponse()
  }
  catch (error) {
    if (options?.sessionOwnedThisRequest) {
      try {
        await finishTerminalSession(env.HYPERDRIVE_CAPGO_DIRECT_EU, session.sessionKey, 'ws_token_failed')
      }
      catch (finishError) {
        console.error(JSON.stringify({
          event: 'terminal_mcp_active_check_finish_failed',
          session_key: session.sessionKey,
          message: finishError instanceof Error ? finishError.message : String(finishError),
        }))
      }
    }
    return authErrorResponse(error)
  }
  return handleTerminalMcpRequest(request, env, session, ctx, options?.precheckedPost)
}