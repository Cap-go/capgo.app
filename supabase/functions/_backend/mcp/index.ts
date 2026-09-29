import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { JsonRpcResponse } from './protocol.ts'
import type { McpApiRequest, McpApiResponse, McpCaller, McpToolContext } from './tools.ts'
import { cors } from 'hono/cors'
import { Hono } from 'hono/tiny'
import { cloudlog } from '../utils/logging.ts'
import { isIPRateLimited, recordFailedAuth } from '../utils/rate_limit.ts'
import { checkKey, supabaseAdmin } from '../utils/supabase.ts'
import { getProtectedResourceMetadataUrl, MCP_PATH, app as oauthApp } from './oauth.ts'
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
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
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
    return { ok: response.ok, status: response.status, data }
  }
}

export function createMcpApp(dispatch: McpDispatch) {
  const app = new Hono<MiddlewareKeyVariables>()

  app.use('/.well-known/*', mcpCors)
  app.use(`${MCP_PATH}`, mcpCors)
  app.use(`${MCP_PATH}/*`, mcpCors)
  app.route('/', oauthApp)

  // Stateless server: no server-initiated SSE stream and no sessions to terminate.
  app.get(MCP_PATH, (c) => {
    c.header('Allow', 'POST, OPTIONS')
    return c.json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, 'Use POST for MCP requests (Streamable HTTP, stateless)'), 405)
  })
  app.delete(MCP_PATH, (c) => {
    c.header('Allow', 'POST, OPTIONS')
    return c.json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, 'This server does not use sessions'), 405)
  })

  app.post(MCP_PATH, async (c) => {
    const ipLimit = await isIPRateLimited(c)
    if (ipLimit.limited)
      return c.json(jsonRpcError(null, -32002, 'Too many failed authentication attempts'), 429)

    const token = extractToken(c)
    if (!token)
      return unauthorized(c, 'Authentication required', false)

    const apikey = await checkKey(c, token, supabaseAdmin(c))
    if (!apikey) {
      await recordFailedAuth(c)
      return unauthorized(c, 'Invalid or expired Capgo API key', true)
    }

    const raw = await c.req.text()
    if (raw.length > MAX_BODY_BYTES)
      return c.json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, 'Request body too large'), 413)
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    }
    catch {
      return c.json(jsonRpcError(null, JSON_RPC_ERRORS.parseError, 'Parse error'), 400)
    }

    const caller: McpCaller = {
      userId: apikey.user_id,
      apikeyId: Number(apikey.id),
      apikeyName: apikey.name,
      apikeyExpiresAt: apikey.expires_at,
    }
    const ctx: McpToolContext = { call: createCaller(c, dispatch, token), caller }

    if (Array.isArray(payload) && (payload.length === 0 || payload.length > MAX_BATCH_MESSAGES))
      return c.json(jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, `Batches must contain 1 to ${MAX_BATCH_MESSAGES} messages`), 400)
    const messages = Array.isArray(payload) ? payload : [payload]
    const responses: JsonRpcResponse[] = []
    for (const message of messages) {
      const method = (message as { method?: unknown } | null)?.method
      if (method === 'tools/call')
        cloudlog({ requestId: c.get('requestId'), message: 'mcp_tool_call', tool: (message as { params?: { name?: unknown } }).params?.name, apikeyId: caller.apikeyId })
      const response = await handleJsonRpcMessage(message, ctx)
      if (response)
        responses.push(response)
    }

    if (responses.length === 0) {
      // Notifications / responses only: the Streamable HTTP transport mandates 202 with no body.
      return c.body(null, 202)
    }
    return c.json(Array.isArray(payload) ? responses : responses[0])
  })

  return app
}
