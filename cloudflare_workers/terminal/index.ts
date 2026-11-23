import { getAgentByName } from './lib/agent_routing.ts'
import { TERMINAL_MAX_CONCURRENCY_PER_ORG, TERMINAL_MAX_SESSION_MINUTES } from './lib/constants.ts'
import { authErrorResponse } from './lib/errors.ts'
import { handleTerminalEgress } from './lib/egress_proxy.ts'
import {
  extractApiKey,
  normalizeTerminalPath,
  parseSessionRoute,
} from './lib/http.ts'
import {
  buildSessionKey,
  terminalDurableObjectName,
} from './lib/security.ts'
import { inactiveTerminalMcpResponse } from './lib/mcp_gate.ts'
import { handleTerminalMcpRequest } from './lib/mcp_serve.ts'
import {
  consumeTerminalWsToken,
  finishTerminalSession,
  isTerminalSessionActive,
  reserveTerminalSession,
  setTerminalWsToken,
  sha256Hex,
  validateApiKeyForApp,
} from './lib/apikey.ts'
import { stripClientMcpHeaders, wsConnectAuth } from './lib/ws.ts'
import { TerminalSession, type TerminalEnv } from './terminal_session.ts'

const WS_TOKEN_TTL_SECONDS = 300

function parseSessionKeyParts(sessionKey: string): { orgId: string, appId: string } | null {
  const parts = sessionKey.split(':')
  if (parts.length < 3)
    return null
  const orgId = parts[0]
  const appId = parts[1]
  if (!orgId || !appId)
    return null
  return { orgId, appId }
}

function parseStartSessionBody(
  raw: unknown,
): { orgId: string, appId: string, sessionId: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null
  const body = raw as Record<string, unknown>
  const orgId = body.org_id
  const appId = body.app_id
  const sessionId = body.session_id
  if (typeof orgId !== 'string' || !orgId.trim())
    return null
  if (typeof appId !== 'string' || !appId.trim())
    return null
  if (typeof sessionId !== 'string' || !sessionId.trim())
    return null
  const trimmedSessionId = sessionId.trim()
  if (trimmedSessionId.length > 128)
    return null
  return { orgId: orgId.trim(), appId: appId.trim(), sessionId: trimmedSessionId }
}

function parseEndSessionBody(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return null
  const sessionKey = (raw as Record<string, unknown>).session_key
  if (typeof sessionKey !== 'string' || !sessionKey.trim())
    return null
  return sessionKey.trim()
}

function reserveStatus(error: string | undefined): number {
  if (error === 'concurrency_limit')
    return 429
  if (error === 'session_ended')
    return 410
  return 403
}

async function ensureReserved(
  hyperdrive: TerminalEnv['HYPERDRIVE_CAPGO_DIRECT_EU'],
  input: Parameters<typeof reserveTerminalSession>[1],
): Promise<Response | { reused: boolean, created: boolean }> {
  const reserved = await reserveTerminalSession(hyperdrive, input)
  if (!reserved.ok)
    return Response.json({ error: reserved.error ?? 'reserve_failed' }, { status: reserveStatus(reserved.error) })
  return { reused: reserved.reused === true, created: reserved.created === true }
}

function mintWsConnectToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function handleTerminalFetch(request: Request, env: TerminalEnv): Promise<Response> {
  const url = new URL(request.url)
  const path = normalizeTerminalPath(url.pathname)

  if (path === '/terminal/sessions' && request.method === 'POST') {
    const apiKey = extractApiKey(request)
    if (!apiKey)
      return Response.json({ error: 'missing_apikey' }, { status: 401 })

    let raw: unknown
    try {
      raw = await request.json()
    }
    catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    const parsed = parseStartSessionBody(raw)
    if (!parsed)
      return Response.json({ error: 'missing_fields' }, { status: 400 })

    const { orgId, appId, sessionId } = parsed
    const sessionKey = buildSessionKey(orgId, appId, sessionId)
    try {
      const key = await validateApiKeyForApp(env.HYPERDRIVE_CAPGO_DIRECT_EU, apiKey, orgId, appId)
      const reserved = await ensureReserved(env.HYPERDRIVE_CAPGO_DIRECT_EU, {
        sessionKey,
        orgId,
        appId,
        apikeyId: key.apikeyId,
        maxDurationMinutes: TERMINAL_MAX_SESSION_MINUTES,
        maxConcurrency: TERMINAL_MAX_CONCURRENCY_PER_ORG,
      })
      if (reserved instanceof Response)
        return reserved
      const sessionOwnedThisRequest = reserved.created

      const wsToken = mintWsConnectToken()
      const wsTokenHash = await sha256Hex(wsToken)
      let tokenStored = false
      try {
        tokenStored = await setTerminalWsToken(
          env.HYPERDRIVE_CAPGO_DIRECT_EU,
          sessionKey,
          wsTokenHash,
          WS_TOKEN_TTL_SECONDS,
        )
      }
      catch (error) {
        console.error(JSON.stringify({
          event: 'terminal_ws_token_set_failed',
          session_key: sessionKey,
          message: error instanceof Error ? error.message : String(error),
        }))
        tokenStored = false
      }
      if (!tokenStored) {
        if (sessionOwnedThisRequest)
          await finishTerminalSession(env.HYPERDRIVE_CAPGO_DIRECT_EU, sessionKey, 'ws_token_failed')
        return Response.json({ error: 'ws_token_failed' }, { status: 500 })
      }

      const mcpQuery = `session_key=${encodeURIComponent(sessionKey)}`
      const wsQuery = `ws_token=${encodeURIComponent(wsToken)}`
      return Response.json({
        session_key: sessionKey,
        mcp_url: `${url.origin}/terminal/mcp?${mcpQuery}`,
        websocket_url: `${url.origin}/terminal/ws/${encodeURIComponent(sessionKey)}?${wsQuery}`,
        ws_connect_token: wsToken,
      })
    }
    catch (error) {
      return authErrorResponse(error)
    }
  }

  if (path === '/terminal/sessions/end' && request.method === 'POST') {
    const apiKey = extractApiKey(request)
    if (!apiKey)
      return Response.json({ error: 'missing_apikey' }, { status: 401 })
    let raw: unknown
    try {
      raw = await request.json()
    }
    catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    const sessionKey = parseEndSessionBody(raw)
    if (!sessionKey)
      return Response.json({ error: 'missing_session_key' }, { status: 400 })
    const parts = parseSessionKeyParts(sessionKey)
    if (!parts)
      return Response.json({ error: 'invalid_session_key' }, { status: 400 })
    try {
      await validateApiKeyForApp(env.HYPERDRIVE_CAPGO_DIRECT_EU, apiKey, parts.orgId, parts.appId)
    }
    catch (error) {
      return authErrorResponse(error)
    }
    const agentName = await terminalDurableObjectName(sessionKey)
    const agent = await getAgentByName(env.TERMINAL_SESSION, agentName, {
      props: { sessionKey, orgId: parts.orgId, appId: parts.appId },
    })
    return agent.fetch(new Request('https://do/terminal/end', { method: 'POST' }))
  }

  if (path.startsWith('/terminal/ws/')) {
    const sessionKey = parseSessionRoute(path, '/terminal/ws/')
    if (!sessionKey)
      return new Response('not_found', { status: 404 })
    const parts = parseSessionKeyParts(sessionKey)
    if (!parts)
      return new Response('not_found', { status: 404 })

    const wsAuth = wsConnectAuth(request, url)
    if (wsAuth.kind === 'reject_apikey')
      return new Response('forbidden', { status: 403 })
    if (wsAuth.kind === 'unauthorized')
      return new Response('unauthorized', { status: 401 })

    const tokenHash = await sha256Hex(wsAuth.wsToken)
    const ok = await consumeTerminalWsToken(env.HYPERDRIVE_CAPGO_DIRECT_EU, sessionKey, tokenHash)
    if (!ok)
      return new Response('unauthorized', { status: 401 })

    if (!await isTerminalSessionActive(env.HYPERDRIVE_CAPGO_DIRECT_EU, sessionKey))
      return new Response('gone', { status: 410 })

    const agent = await getAgentByName(env.TERMINAL_SESSION, await terminalDurableObjectName(sessionKey), {
      props: { sessionKey, orgId: parts.orgId, appId: parts.appId },
    })
    return agent.fetch(stripClientMcpHeaders(request))
  }

  if (path.startsWith('/terminal/mcp')) {
    const apiKey = extractApiKey(request)
    if (!apiKey)
      return Response.json({ error: 'missing_apikey' }, { status: 401 })
    const sessionKey = url.searchParams.get('session_key')
      || request.headers.get('X-Capgo-Terminal-Session')
    if (!sessionKey)
      return Response.json({ error: 'missing_session_key' }, { status: 400 })
    const parts = parseSessionKeyParts(sessionKey)
    if (!parts)
      return Response.json({ error: 'invalid_session_key' }, { status: 400 })
    try {
      const key = await validateApiKeyForApp(env.HYPERDRIVE_CAPGO_DIRECT_EU, apiKey, parts.orgId, parts.appId)
      const reserved = await ensureReserved(env.HYPERDRIVE_CAPGO_DIRECT_EU, {
        sessionKey,
        orgId: parts.orgId,
        appId: parts.appId,
        apikeyId: key.apikeyId,
        maxDurationMinutes: TERMINAL_MAX_SESSION_MINUTES,
        maxConcurrency: TERMINAL_MAX_CONCURRENCY_PER_ORG,
      })
      if (reserved instanceof Response)
        return reserved
      if (!await isTerminalSessionActive(env.HYPERDRIVE_CAPGO_DIRECT_EU, sessionKey))
        return inactiveTerminalMcpResponse()
    }
    catch (error) {
      return authErrorResponse(error)
    }
    return handleTerminalMcpRequest(request, env, {
      sessionKey,
      orgId: parts.orgId,
      appId: parts.appId,
    })
  }

  if (path === '/terminal/health')
    return Response.json({ status: 'ok' })

  return new Response('not_found', { status: 404 })
}

export default {
  async fetch(request: Request, env: TerminalEnv, ctx: ExecutionContext): Promise<Response> {
    return handleTerminalFetch(request, env)
  },
} satisfies ExportedHandler<TerminalEnv>

export { TerminalSession }

export const TerminalEgress = {
  fetch: handleTerminalEgress,
} satisfies ExportedHandler