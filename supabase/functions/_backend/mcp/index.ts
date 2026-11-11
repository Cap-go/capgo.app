import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { JsonRpcResponse } from './protocol.ts'
import type { McpApiRequest, McpApiResponse, McpCaller, McpToolContext } from './tools.ts'
import { accepts } from 'hono/accepts'
import { cors } from 'hono/cors'
import { Hono } from 'hono/tiny'
import { parseAccept } from 'hono/utils/accept'
import { CLI_CI_HEADER, readCliCiProvider } from '../utils/cicdDetection.ts'
import { setApiKeyAuthContext } from '../utils/hono_middleware.ts'
import { cloudlog } from '../utils/logging.ts'
import { trackPosthogEvent } from '../utils/posthog.ts'
import { isIPRateLimited, recordFailedAuth } from '../utils/rate_limit.ts'
import { checkKey } from '../utils/supabase.ts'
import { backgroundTask } from '../utils/utils.ts'
import { MCP_AI_CATALOG, MCP_SERVER_CARD, MCP_SETUP_HTML } from './discovery.ts'
import { getProtectedResourceMetadataUrl, MCP_PATH, app as oauthApp } from './oauth.ts'
import { withPg } from './oauth_shared.ts'
import { handleJsonRpcMessage, JSON_RPC_ERRORS, jsonRpcError } from './protocol.ts'

/**
 * Hosted Capgo MCP server (Streamable HTTP, stateless, JSON responses).
 *
 *   POST https://api.capgo.app/mcp            JSON-RPC endpoint
 *   GET  /.well-known/oauth-protected-resource  RFC 9728 discovery (→ OAuth 2.1 + PKCE login)
 *
 * Auth: `Authorization: Bearer <token>` where the token is a Capgo API key, either pasted by the
 * user (Lovable "API key" / header auth) or obtained through the OAuth flow in oauth.ts.
 */

export type McpDispatch = (request: Request, c: Context<MiddlewareKeyVariables>) => Response | Promise<Response>

const MAX_BODY_BYTES = 1024 * 1024
// Batching was removed in MCP 2025-06-18; keep legacy batches small so one request cannot fan out.
const MAX_BATCH_MESSAGES = 20
const STREAM_READ_TIMEOUT_MS = 8000
const STREAM_MAX_BYTES = 256 * 1024

const mcpCors = cors({
  origin: '*',
  allowMethods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Accept', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID', 'capgkey', 'x-api-key'],
  exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
  maxAge: 86400,
})

export function extractToken(c: Context): string | null {
  const authorization = c.req.header('authorization')?.trim()
  if (authorization) {
    const match = /^Bearer\s+(\S.*)$/i.exec(authorization)
    return (match ? match[1] : authorization).trim() || null
  }
  return c.req.header('capgkey')?.trim() || c.req.header('x-api-key')?.trim() || null
}

function unauthorized(c: Context<MiddlewareKeyVariables>, description: string, invalidToken: boolean) {
  const params = [`resource_metadata="${getProtectedResourceMetadataUrl(c)}"`, 'scope="capgo"']
  if (invalidToken)
    params.unshift('error="invalid_token"', `error_description="${description}"`)
  c.header('WWW-Authenticate', `Bearer ${params.join(', ')}`)
  return c.json(jsonRpcError(null, -32001, description), 401)
}

async function readSseSnapshot(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader)
    return ''
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + STREAM_READ_TIMEOUT_MS
  try {
    while (text.length < STREAM_MAX_BYTES) {
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        break
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>(resolve => setTimeout(resolve, remaining, null)),
      ])
      if (!chunk || chunk.done)
        break
      text += decoder.decode(chunk.value, { stream: true })
    }
  }
  finally {
    reader.cancel().catch(() => {})
  }
  // Keep only SSE payload lines; plain text bodies pass through unchanged.
  const dataLines = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart())
  return dataLines.length > 0 ? dataLines.join('\n') : text
}

function createCaller(c: Context<MiddlewareKeyVariables>, dispatch: McpDispatch, token: string) {
  const origin = new URL(c.req.url).origin
  const ciProvider = readCliCiProvider(c.req.header(CLI_CI_HEADER))
  return async (request: McpApiRequest): Promise<McpApiResponse> => {
    const url = new URL(request.path, origin)
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null)
        url.searchParams.set(key, String(value))
    }
    const headers = new Headers({
      'capgkey': token,
      'accept': 'application/json',
      'user-agent': 'capgo-mcp',
      'x-cli-command': 'mcp',
    })
    if (ciProvider)
      headers.set(CLI_CI_HEADER, ciProvider)
    // Keep the caller's IP so per-IP rate limits and logs stay meaningful.
    for (const name of ['cf-connecting-ip', 'x-forwarded-for', 'cf-ipcountry', 'cf-ray']) {
      const value = c.req.header(name)
      if (value)
        headers.set(name, value)
    }
    let body: string | undefined
    if (request.body && request.method !== 'GET') {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(request.body)
    }

    const response = await dispatch(new Request(url, { method: request.method, headers, body }), c)
    if (request.stream && response.ok)
      return { ok: true, status: response.status, data: await readSseSnapshot(response) }

    const text = await response.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    }
    catch {}
    return { ok: response.ok, status: response.status, data, requestId: response.headers.get('x-request-id') ?? undefined }
  }
}

/**
 * PostHog event for one hosted MCP tool call, so hosted usage sits next to the CLI's
 * `MCP Tool Invoked`. Returns null when no tool ran: notifications get no response, and
 * requests rejected before dispatch (bad `jsonrpc` or `id`) get an error with `id: null`.
 * The caller adds `client` (see hostedMcpClient).
 */
export function hostedMcpToolEvent(message: unknown, response: JsonRpcResponse | null | undefined, userId: string) {
  const msg = message as { method?: unknown, params?: { name?: unknown } } | null
  if (msg?.method !== 'tools/call' || !response || response.id === null)
    return null
  const toolName = typeof msg.params?.name === 'string' ? msg.params.name.slice(0, 100) : 'unknown'
  const result = response.result as { isError?: unknown } | undefined
  return {
    channel: 'mcp-hosted',
    event: 'Hosted MCP Tool Invoked',
    user_id: userId,
    setPersonProperties: false,
    nonPersonTags: { tool_name: toolName, success: !response.error && !result?.isError },
  }
}

/** Client name from the OAuth request that minted the key; never the user-editable key name. */
async function hostedMcpClient(c: Context<MiddlewareKeyVariables>, apikeyId: number): Promise<string> {
  const { rows } = await withPg(c, pg => pg.query<{ client_name: string }>(
    'SELECT client_name FROM public.mcp_oauth_requests WHERE apikey_id = $1 ORDER BY created_at DESC LIMIT 1',
    [apikeyId],
  ))
  return rows[0]?.client_name ?? 'api_key'
}

/** Sends one PostHog event per tool that ran in this HTTP request, tagged with the OAuth client. */
async function trackHostedMcpToolCalls(c: Context<MiddlewareKeyVariables>, caller: McpCaller, exchanges: [unknown, JsonRpcResponse | null][]) {
  const events = exchanges.map(([message, response]) => hostedMcpToolEvent(message, response, caller.userId)).filter(event => event !== null)
  if (events.length === 0)
    return
  const client = (await hostedMcpClient(c, caller.apikeyId).catch(() => 'unknown')).slice(0, 100)
  await Promise.all(events.map(event => trackPosthogEvent(c, { ...event, nonPersonTags: { ...event.nonPersonTags, client } })))
}

export function createMcpApp(dispatch: McpDispatch) {
  const app = new Hono<MiddlewareKeyVariables>()

  app.use('/.well-known/*', mcpCors)
  app.use(`${MCP_PATH}`, mcpCors)
  app.use(`${MCP_PATH}/*`, mcpCors)
  app.route('/', oauthApp)

  // Serve the current discovery location and the older well-known convention used by crawlers.
  app.get(`${MCP_PATH}/server-card`, (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json(MCP_SERVER_CARD, 200, { 'Content-Type': 'application/mcp-server-card+json' })
  })
  app.get('/.well-known/mcp/server-card.json', (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json(MCP_SERVER_CARD, 200, { 'Content-Type': 'application/mcp-server-card+json' })
  })
  app.get('/.well-known/ai-catalog.json', (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json(MCP_AI_CATALOG, 200, { 'Content-Type': 'application/ai-catalog+json' })
  })

  app.get(MCP_PATH, (c) => {
    c.header('Vary', 'Accept')
    const representation = accepts(c, {
      header: 'Accept',
      supports: ['text/html'],
      default: 'text/html',
      match: (types) => {
        // Hono preserves casing. Normalize names, preserving quoted parameter values,
        // then let its parser apply the same quality rules and ordering to Q as to q.
        const normalizedTypes = parseAccept(types.map(({ type, params }) => [
          type.toLowerCase(),
          ...Object.entries(params).map(([name, value]) => `${name.toLowerCase()}="${value.replace(/["\\]/g, '\\$&')}"`),
        ].join(';')).join(','))
        // Explicit MCP stream requests retain the stateless transport's 405 response.
        if (normalizedTypes.some(type => type.type === 'text/event-stream' && type.q > 0))
          return 'protocol'
        const html = normalizedTypes.find(type => type.type === 'text/html')
          ?? normalizedTypes.find(type => type.type === 'text/*')
          ?? normalizedTypes.find(type => type.type === '*/*')
        return html && html.q > 0 ? 'text/html' : 'protocol'
      },
    })
    if (representation === 'text/html') {
      c.header('Cache-Control', 'no-store')
      return c.html(MCP_SETUP_HTML)
    }
    c.header('Cache-Control', 'no-store')
    c.header('Allow', 'GET, HEAD, POST, OPTIONS')
    return c.json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, 'Use POST for MCP requests (Streamable HTTP, stateless). Configure your MCP client with the URL https://api.capgo.app/mcp and the HTTP transport.'), 405)
  })
  // Stateless server: no sessions to terminate.
  app.delete(MCP_PATH, (c) => {
    c.header('Allow', 'GET, HEAD, POST, OPTIONS')
    return c.json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, 'This server does not use sessions, so there is nothing to close. Keep sending POST requests.'), 405)
  })

  app.post(MCP_PATH, async (c) => {
    const ipLimit = await isIPRateLimited(c)
    if (ipLimit.limited)
      return c.json(jsonRpcError(null, -32002, 'Too many failed authentication attempts from this IP. Wait 15 minutes, then reconnect the Capgo MCP with a valid API key (create one at https://console.capgo.app/apikeys) or sign in again through OAuth.'), 429)

    const token = extractToken(c)
    if (!token)
      return unauthorized(c, 'Authentication required: sign in to the Capgo MCP through OAuth, or send Authorization: Bearer <Capgo API key> (create one at https://console.capgo.app/apikeys)', false)

    const apikey = await checkKey(c, token)
    if (!apikey) {
      await recordFailedAuth(c)
      return unauthorized(c, 'Invalid or expired Capgo API key: sign in to the Capgo MCP again through OAuth, or create a new key at https://console.capgo.app/apikeys and update the connection', true)
    }
    setApiKeyAuthContext(c, apikey, token)

    c.set('auth', {
      userId: apikey.user_id,
      authType: 'apikey',
      apikey,
      jwt: null,
    })
    c.set('apikey', apikey)
    c.set('parentApikey', apikey)
    c.set('capgkey', token)

    const raw = await c.req.text()
    if (raw.length > MAX_BODY_BYTES)
      return c.json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, 'Request body too large (max 1 MB). Send files through the signed upload URL tools (capgo_prepare_bundle_upload, capgo_request_build) instead of inline.'), 413)
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    }
    catch {
      return c.json(jsonRpcError(null, JSON_RPC_ERRORS.parseError, 'Parse error: the body must be one JSON-RPC 2.0 message (or a small batch) in valid JSON.'), 400)
    }

    const caller: McpCaller = {
      userId: apikey.user_id,
      apikeyId: Number(apikey.id),
      apikeyName: apikey.name,
      apikeyExpiresAt: apikey.expires_at,
    }
    const ctx: McpToolContext = {
      call: createCaller(c, dispatch, token),
      caller,
      apikey: token,
      hono: c,
      apikeyRow: apikey,
    }

    if (Array.isArray(payload) && (payload.length === 0 || payload.length > MAX_BATCH_MESSAGES))
      return c.json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, `Batches must contain 1 to ${MAX_BATCH_MESSAGES} messages`), 400)
    const messages = Array.isArray(payload) ? payload : [payload]
    const exchanges = await Promise.all(messages.map(async (message) => {
      const method = (message as { method?: unknown } | null)?.method
      if (method === 'tools/call')
        cloudlog({ requestId: c.get('requestId'), message: 'mcp_tool_call', tool: (message as { params?: { name?: unknown } }).params?.name, apikeyId: caller.apikeyId })
      const response = await handleJsonRpcMessage(message, ctx, c)
      return [message, response] as [unknown, JsonRpcResponse | null]
    }))
    const responses = exchanges.map(([, response]) => response).filter((response): response is JsonRpcResponse => response !== null)
    await backgroundTask(c, trackHostedMcpToolCalls(c, caller, exchanges))

    if (responses.length === 0) {
      // Notifications / responses only: the Streamable HTTP transport mandates 202 with no body.
      return c.body(null, 202)
    }
    return c.json(Array.isArray(payload) ? responses : responses[0])
  })

  return app
}
