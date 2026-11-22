import { TERMINAL_MAX_CONCURRENCY_PER_ORG, TERMINAL_MAX_SESSION_MINUTES } from './lib/constants.ts'
import {
  extractApiKey,
  parseSessionRoute,
} from './lib/http.ts'
import {
  buildSessionKey,
} from './lib/security.ts'
import { reserveTerminalSession, validateApiKeyForApp } from './lib/apikey.ts'
import { TerminalSession, type TerminalEnv } from './terminal_session.ts'

const mcp = TerminalSession.serve('/terminal/mcp', { binding: 'TERMINAL_SESSION' })

export default {
  async fetch(request: Request, env: TerminalEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/terminal/sessions' && request.method === 'POST') {
      const apiKey = extractApiKey(request)
      if (!apiKey)
        return Response.json({ error: 'missing_apikey' }, { status: 401 })

      let body: { org_id?: string, app_id?: string, session_id?: string }
      try {
        body = await request.json() as typeof body
      }
      catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 })
      }
      const { org_id: orgId, app_id: appId, session_id: sessionId } = body
      if (!orgId || !appId || !sessionId)
        return Response.json({ error: 'missing_fields' }, { status: 400 })

      const sessionKey = buildSessionKey(orgId, appId, sessionId)
      try {
        const key = await validateApiKeyForApp(env.HYPERDRIVE_CAPGO_DIRECT_EU, apiKey, orgId, appId)
        const reserved = await reserveTerminalSession(env.HYPERDRIVE_CAPGO_DIRECT_EU, {
          sessionKey,
          orgId,
          appId,
          apikeyId: key.apikeyId,
          maxDurationMinutes: TERMINAL_MAX_SESSION_MINUTES,
          maxConcurrency: TERMINAL_MAX_CONCURRENCY_PER_ORG,
        })
        if (!reserved.ok)
          return Response.json({ error: reserved.error }, { status: reserved.error === 'concurrency_limit' ? 429 : 403 })

        return Response.json({
          session_key: sessionKey,
          mcp_url: `${url.origin}/terminal/mcp`,
          websocket_url: `${url.origin}/terminal/ws/${encodeURIComponent(sessionKey)}`,
        })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'auth_failed'
        return Response.json({ error: message }, { status: 403 })
      }
    }

    if (url.pathname.startsWith('/terminal/ws/')) {
      const sessionKey = parseSessionRoute(url.pathname, '/terminal/ws/')
      if (!sessionKey)
        return new Response('not_found', { status: 404 })
      const apiKey = extractApiKey(request) || url.searchParams.get('capgkey') || ''
      if (!apiKey)
        return new Response('unauthorized', { status: 401 })
      const id = env.TERMINAL_SESSION.idFromName(sessionKey)
      return env.TERMINAL_SESSION.get(id).fetch(request)
    }

    if (url.pathname.startsWith('/terminal/mcp')) {
      const auth = extractApiKey(request)
      if (!auth)
        return Response.json({ error: 'missing_apikey' }, { status: 401 })
      return mcp.fetch(request, env, ctx)
    }

    if (url.pathname === '/terminal/health')
      return Response.json({ status: 'ok' })

    return new Response('not_found', { status: 404 })
  },
} satisfies ExportedHandler<TerminalEnv>

export { TerminalSession }