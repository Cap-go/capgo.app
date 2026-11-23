import { getAgentByName } from './agent_routing.ts'
import {
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js'
import type { TerminalEnv, TerminalProps } from '../terminal_session.ts'
import { terminalMcpSessionHeaderId } from './security.ts'
import { mcpRequestIncludesInitialize } from './mcp_rpc.ts'
import { TERMINAL_CLIENT_MCP_HEADERS } from './ws.ts'

export const TERMINAL_INTERNAL_MCP_BRIDGE = 'x-capgo-terminal-mcp-bridge'

const MCP_HTTP_METHOD_HEADER = TERMINAL_CLIENT_MCP_HEADERS[0]
const MCP_MESSAGE_HEADER = TERMINAL_CLIENT_MCP_HEADERS[1]
const MAXIMUM_MESSAGE_SIZE_BYTES = 4 * 1024 * 1024
const KEEPALIVE_INTERVAL_MS = 25_000
const KEEPALIVE_FRAME = ': keepalive\n\n'

type McpWorker = {
  fetch: (request: Request, env: TerminalEnv, ctx: TerminalMcpContext) => Promise<Response>
}

export type TerminalMcpContext = {
  props?: TerminalProps
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'mcp-session-id',
    'Access-Control-Max-Age': '86400',
  }
}

function startKeepalive(writer: WritableStreamDefaultWriter<Uint8Array>, encoder: TextEncoder) {
  const handle = setInterval(() => {
    writer.write(encoder.encode(KEEPALIVE_FRAME)).catch(() => clearInterval(handle))
  }, KEEPALIVE_INTERVAL_MS)
  return handle
}

async function pinnedSessionIdFromCtx(
  ctx: TerminalMcpContext | undefined,
): Promise<string | null> {
  const sessionKey = ctx?.props?.sessionKey
  if (!sessionKey)
    return null
  return terminalMcpSessionHeaderId(sessionKey)
}

function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  return value != null && typeof value === 'object' && 'idFromName' in value && 'get' in value
}

function matchesMcpPath(basePath: string, pathname: string): boolean {
  if (basePath === '/')
    return true
  if (basePath.endsWith('/*'))
    return pathname === basePath.slice(0, -2) || pathname.startsWith(`${basePath.slice(0, -2)}/`)
  return pathname === basePath || pathname === `${basePath}/`
}

export function createTerminalStreamingHttpHandler(
  basePath: string,
  binding: keyof TerminalEnv,
): McpWorker {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      if (!matchesMcpPath(basePath, url.pathname))
        return new Response('not_found', { status: 404 })

      if (request.method !== 'POST')
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST', ...corsHeaders() } })

      const acceptHeader = request.headers.get('accept')
      if (!acceptHeader?.includes('application/json') || !acceptHeader.includes('text/event-stream')) {
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32_000, message: 'Not Acceptable: Client must accept both application/json and text/event-stream' },
          id: null,
        }, { status: 406 })
      }
      const ct = request.headers.get('content-type')
      if (!ct || !ct.includes('application/json')) {
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32_000, message: 'Unsupported Media Type: Content-Type must be application/json' },
          id: null,
        }, { status: 415 })
      }
      if (Number.parseInt(request.headers.get('content-length') ?? '0', 10) > MAXIMUM_MESSAGE_SIZE_BYTES) {
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32_000, message: `Request body too large. Maximum size is ${MAXIMUM_MESSAGE_SIZE_BYTES} bytes` },
          id: null,
        }, { status: 413 })
      }

      let sessionId = request.headers.get('mcp-session-id')
      let rawMessage: unknown
      try {
        rawMessage = await request.json()
      }
      catch {
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32_700, message: 'Parse error: Invalid JSON' },
          id: null,
        }, { status: 400 })
      }

      const arrayMessage = Array.isArray(rawMessage) ? rawMessage : [rawMessage]
      for (const msg of arrayMessage) {
        if (!JSONRPCMessageSchema.safeParse(msg).success) {
          return Response.json({
            jsonrpc: '2.0',
            error: { code: -32_700, message: 'Parse error: Invalid JSON-RPC message' },
            id: null,
          }, { status: 400 })
        }
      }
      const messages = arrayMessage.map(msg => JSONRPCMessageSchema.parse(msg))
      const hasInitialize = mcpRequestIncludesInitialize(rawMessage)
      const maybeInitializeRequest = messages.find(msg => InitializeRequestSchema.safeParse(msg).success)

      if (hasInitialize && sessionId) {
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32_600, message: 'Invalid Request: Initialization requests must not include a sessionId' },
          id: null,
        }, { status: 400 })
      }
      if (hasInitialize && messages.length > 1) {
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32_600, message: 'Invalid Request: Only one initialization request is allowed' },
          id: null,
        }, { status: 400 })
      }
      if (!hasInitialize && !sessionId) {
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32_000, message: 'Bad Request: Mcp-Session-Id header is required' },
          id: null,
        }, { status: 400 })
      }

      const bindingValue = env[binding]
      if (!isDurableObjectNamespace(bindingValue)) {
        throw new Error(`Could not find McpAgent binding for ${String(binding)}`)
      }
      const namespace = bindingValue
      const pinned = await pinnedSessionIdFromCtx(ctx)
      sessionId = sessionId ?? pinned ?? namespace.newUniqueId().toString()

      const agent = await getAgentByName(namespace, `streamable-http:${sessionId}`, {
        props: ctx?.props,
      })
      const isInitialized = await agent.getInitializeRequest()
      if (maybeInitializeRequest)
        await agent.setInitializeRequest(maybeInitializeRequest)
      else if (!isInitialized) {
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32_001, message: 'Session not found' },
          id: null,
        }, { status: 404 })
      }

      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const encoder = new TextEncoder()
      const existingHeaders: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        existingHeaders[key] = value
      })
      const req = new Request(request.url, {
        headers: {
          ...existingHeaders,
          [MCP_HTTP_METHOD_HEADER]: 'POST',
          [MCP_MESSAGE_HEADER]: Buffer.from(JSON.stringify(messages)).toString('base64'),
          [TERMINAL_INTERNAL_MCP_BRIDGE]: '1',
          Upgrade: 'websocket',
        },
      })
      const wsResponse = await agent.fetch(req)
      const ws = wsResponse.webSocket
      if (!ws) {
        await writer.close()
        return Response.json({
          jsonrpc: '2.0',
          error: { code: -32_001, message: 'Failed to establish WebSocket connection' },
          id: null,
        }, { status: 500 })
      }
      ws.accept()

      if (messages.every(msg => isJSONRPCNotification(msg) || isJSONRPCResultResponse(msg))) {
        ws.close()
        return new Response(null, { headers: corsHeaders(), status: 202 })
      }

      const keepAlive = startKeepalive(writer, encoder)
      ws.addEventListener('message', (event) => {
        const onMessage = async () => {
          try {
            const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
            const message = JSON.parse(data) as { type?: string, event?: string, close?: boolean }
            if (message.type !== 'cf_mcp_agent_event')
              return
            await writer.write(encoder.encode(message.event!))
            if (message.close) {
              clearInterval(keepAlive)
              ws?.close()
              await writer.close().catch(() => {})
            }
          }
          catch (error) {
            console.error(JSON.stringify({ event: 'terminal_mcp_sse_forward_error', message: String(error) }))
            clearInterval(keepAlive)
            ws?.close()
            void writer.close().catch(() => {})
          }
        }
        onMessage().catch(console.error)
      })
      ws.addEventListener('error', () => {
        clearInterval(keepAlive)
        void writer.close().catch(() => {})
      })
      ws.addEventListener('close', () => {
        clearInterval(keepAlive)
        void writer.close().catch(() => {})
      })

      return new Response(readable, {
        headers: {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream',
          'mcp-session-id': sessionId,
          ...corsHeaders(),
        },
        status: 200,
      })
    },
  }
}