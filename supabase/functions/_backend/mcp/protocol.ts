import type { McpTool, McpToolContext, McpToolResult } from './tools.ts'
import { z } from 'zod'
import { version } from '../utils/version.ts'
import { MCP_TOOLS, MCP_TOOLS_BY_NAME, textResult } from './tools.ts'

/**
 * Minimal, stateless MCP server over JSON-RPC 2.0 (Streamable HTTP transport, JSON responses).
 * No session state is kept between requests, so any worker isolate can serve any call.
 */

export const LATEST_PROTOCOL_VERSION = '2025-11-25'
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'] as const

export const SERVER_INSTRUCTIONS = 'Capgo Cloud MCP server: manage Capacitor live updates (OTA). '
  + 'List organizations and apps, inspect bundles, channels and devices, deploy a bundle by updating a channel, '
  + 'run progressive rollouts, read statistics and Observe health data, follow native builds, and manage webhooks and push notifications. '
  + 'Start with capgo_whoami and capgo_list_apps. Uploading local bundle files and requesting native builds need the Capgo CLI (npx @capgo/cli@latest). '
  + 'Always confirm destructive actions (delete tools) and push notifications with the user first.'

export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

type JsonRpcId = string | number | null

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number, message: string, data?: unknown }
}

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

function isValidId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

const toolListCache = new Map<string, unknown>()

function toolJsonSchema(tool: McpTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete schema.$schema
  return schema
}

export function listTools(): unknown[] {
  return MCP_TOOLS.map((tool) => {
    let entry = toolListCache.get(tool.name)
    if (!entry) {
      entry = {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: toolJsonSchema(tool),
        annotations: tool.annotations,
      }
      toolListCache.set(tool.name, entry)
    }
    return entry
  })
}

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION
}

async function callTool(params: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult | JsonRpcResponse['error']> {
  const name = typeof params.name === 'string' ? params.name : ''
  const tool = MCP_TOOLS_BY_NAME.get(name)
  if (!tool)
    return { code: JSON_RPC_ERRORS.invalidParams, message: `Unknown tool: ${name}` }

  // Invalid arguments are reported as a tool error (not a protocol error) so the model can self-correct.
  const parsed = tool.inputSchema.safeParse(params.arguments ?? {})
  if (!parsed.success)
    return textResult(`Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`, true)

  return tool.run(parsed.data as Record<string, unknown>, ctx)
}

/**
 * Handle one JSON-RPC message. Returns null for notifications and responses (nothing to send back).
 */
export async function handleJsonRpcMessage(message: unknown, ctx: McpToolContext): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message))
    return jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, 'Invalid JSON-RPC message')

  const { jsonrpc, id, method, params } = message as JsonRpcMessage
  const hasId = id !== undefined
  if (jsonrpc !== '2.0' || (hasId && !isValidId(id)))
    return jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, 'Invalid JSON-RPC message')
  if (typeof method !== 'string') {
    // A JSON-RPC response from the client (we never send requests): acknowledge silently.
    return null
  }
  // Notifications (notifications/initialized, notifications/cancelled, ...) need no response.
  if (!hasId)
    return null

  const requestId = id as string | number
  const paramsObject = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}

  switch (method) {
    case 'initialize':
      return jsonRpcResult(requestId, {
        protocolVersion: negotiateProtocolVersion(paramsObject.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'capgo',
          title: 'Capgo',
          version,
          websiteUrl: 'https://capgo.app',
        },
        instructions: SERVER_INSTRUCTIONS,
      })
    case 'ping':
      return jsonRpcResult(requestId, {})
    case 'tools/list':
      return jsonRpcResult(requestId, { tools: listTools() })
    case 'tools/call': {
      try {
        const result = await callTool(paramsObject, ctx)
        if (result && 'code' in result)
          return jsonRpcError(requestId, result.code, result.message)
        return jsonRpcResult(requestId, result)
      }
      catch (error) {
        return jsonRpcResult(requestId, textResult(`Tool failed: ${error instanceof Error ? error.message : String(error)}`, true))
      }
    }
    case 'resources/list':
      return jsonRpcResult(requestId, { resources: [] })
    case 'resources/templates/list':
      return jsonRpcResult(requestId, { resourceTemplates: [] })
    case 'prompts/list':
      return jsonRpcResult(requestId, { prompts: [] })
    default:
      return jsonRpcError(requestId, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}`)
  }
}
