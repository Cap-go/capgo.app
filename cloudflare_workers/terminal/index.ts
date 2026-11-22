import { getAgentByName } from 'agents'
import { TERMINAL_MAX_CONCURRENCY_PER_ORG, TERMINAL_MAX_SESSION_MINUTES } from './lib/constants.ts'
import { authErrorResponse } from './lib/errors.ts'
import {
  extractApiKey,
  parseSessionRoute,
} from './lib/http.ts'
import {
  buildSessionKey,
} from './lib/security.ts'
import { reserveTerminalSession, validateApiKeyForApp } from './lib/apikey.ts'
import { TerminalSession, type TerminalEnv } from './terminal_session.ts'

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
  return { orgId: orgId.trim(), appId: appId.trim(), sessionId: sessionId.trim() }
}

function reserveStatus(error: string | undefined): number {
  if (error === 'concurrency_limit')
    return 429
  return 403
}

async function ensureReserved(
  hyperdrive: TerminalEnv['HYPERDRIVE_CAPGO_DIRECT_EU'],
  input: Parameters<typeof reserveTerminalSession>[1],
): Promise<Response | null> {
  const reserved = await reserveTerminalSession(hyperdrive, input)
  if (reserved.ok)
    return null
  return Response.json({ error: reserved.error ?? 'reserve_failed' }, { status: reserveStatus(reserved.error) })
}

export default {
  async fetch(request: Request, env: TerminalEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/terminal/sessions' && request.method === 'POST') {
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
        const block = await ensureReserved(env.HYPERDRIVE_CAPGO_DIRECT_EU, {
          sessionKey,
          orgId,
          appId,
          apikeyId: key.apikeyId,
          maxDurationMinutes: TERMINAL_MAX_SESSION_MINUTES,
          maxConcurrency: TERMINAL_MAX_CONCURRENCY_PER_ORG,
        })
        if (block)
          return block

        const mcpQuery = `session_key=${encodeURIComponent(sessionKey)}`
        return Response.json({
          session_key: sessionKey,
          mcp_url: `${url.origin}/terminal/mcp?${mcpQuery}`,
          websocket_url: `${url.origin}/terminal/ws/${encodeURIComponent(sessionKey)}`,
        })
      }
      catch (error) {
        return authErrorResponse(error)
      }
    }

    if (url.pathname.startsWith('/terminal/ws/')) {
      const sessionKey = parseSessionRoute(url.pathname, '/terminal/ws/')
      if (!sessionKey)
        return new Response('not_found', { status: 404 })
      const apiKey = extractApiKey(request)
      if (!apiKey)
        return new Response('unauthorized', { status: 401 })
      const parts = parseSessionKeyParts(sessionKey)
      if (!parts)
        return new Response('not_found', { status: 404 })
      try {
        await validateApiKeyForApp(env.HYPERDRIVE_CAPGO_DIRECT_EU, apiKey, parts.orgId, parts.appId)
      }
      catch {
        return new Response('forbidden', { status: 403 })
      }
      const id = env.TERMINAL_SESSION.idFromName(sessionKey)
      return env.TERMINAL_SESSION.get(id).fetch(request)
    }

    if (url.pathname.startsWith('/terminal/mcp')) {
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
        const block = await ensureReserved(env.HYPERDRIVE_CAPGO_DIRECT_EU, {
          sessionKey,
          orgId: parts.orgId,
          appId: parts.appId,
          apikeyId: key.apikeyId,
          maxDurationMinutes: TERMINAL_MAX_SESSION_MINUTES,
          maxConcurrency: TERMINAL_MAX_CONCURRENCY_PER_ORG,
        })
        if (block)
          return block
      }
      catch (error) {
        return authErrorResponse(error)
      }
      const agent = await getAgentByName(env.TERMINAL_SESSION, sessionKey, {
        props: { sessionKey, orgId: parts.orgId, appId: parts.appId },
      })
      return agent.fetch(request)
    }

    if (url.pathname === '/terminal/health')
      return Response.json({ status: 'ok' })

    return new Response('not_found', { status: 404 })
  },
} satisfies ExportedHandler<TerminalEnv>

export { TerminalSession }