import type { McpTool, McpToolContext, McpToolResult } from './tools.ts'
import { z } from 'zod'
import { version } from '../utils/version.ts'
import { GUIDANCE_KEY, guidanceForError } from './error_guidance.ts'
import { MAX_RESULT_CHARS, MCP_TOOLS, MCP_TOOLS_BY_NAME, textResult } from './tools.ts'

/**
 * Minimal, stateless MCP server over JSON-RPC 2.0 (Streamable HTTP transport, JSON responses).
 * No session state is kept between requests, so any worker isolate can serve any call.
 */

export const LATEST_PROTOCOL_VERSION = '2025-11-25'
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'] as const

export const SERVER_INSTRUCTIONS = 'Capgo Cloud MCP server: manage Capacitor live updates (OTA). '
  + 'List organizations and apps, inspect bundles, channels and devices, deploy a bundle by updating a channel, '
  + 'run progressive rollouts, read statistics and Observe health data, follow native builds, and manage webhooks and push notifications. '
  + 'Search the docs with capgo_search_docs. Start with capgo_whoami and capgo_list_apps. To upload a bundle: package it offline with npx @capgo/cli@latest bundle zip --for-upload --json (no login), call capgo_prepare_bundle_upload, PUT the zip to the returned signed URL, then call capgo_complete_bundle_upload. To run a native build: package the native project with npx @capgo/cli@latest build zip --json, call capgo_request_build, PUT the archive to the signed URL, then capgo_start_build. Signing credentials are stored per app (capgo_prepare_build_credentials_upload) and never pass through the chat. '
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

/**
 * Never hand the agent a dead end: every error result carries a `how_to_fix` block (what to change,
 * which tool to call, what to ask the user, or how to reach support). Tools that already explain
 * their error keep their own block.
 */
export function withErrorGuidance(result: McpToolResult, tool: string): McpToolResult {
  if (!result.isError)
    return result
  const text = result.content.map(part => part.text).join('\n')
  let body: unknown
  try {
    body = JSON.parse(text)
  }
  catch {}
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    if (record[GUIDANCE_KEY])
      return result
    const guidance = guidanceForError({
      status: typeof record.status === 'number' ? record.status : undefined,
      code: typeof record.error === 'string' ? record.error : undefined,
      message: typeof record.message === 'string' ? record.message : undefined,
      requestId: typeof record.request_id === 'string' ? record.request_id : undefined,
      tool,
    })
    // Guidance first, so it survives when a huge error body is cut at the result size limit. Drop any
    // empty how_to_fix the API sent, so it cannot overwrite the generated one.
    const { [GUIDANCE_KEY]: _empty, ...rest } = record
    return textResult({ [GUIDANCE_KEY]: guidance, ...rest }, true)
  }
  const guidance = guidanceForError({ message: text, tool })
  const guidanceText = `\n\n${GUIDANCE_KEY} (${guidance.kind}):\n${guidance.next_steps.map(step => `- ${step}`).join('\n')}`
  // Cut the error text, never the guidance, to stay under the result size limit.
  const room = MAX_RESULT_CHARS - guidanceText.length - 20
  const errorText = text.length > room ? `${text.slice(0, room)}\n… (truncated)` : text
  return textResult(`${errorText}${guidanceText}`, true)
}

async function callTool(params: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult | JsonRpcResponse['error']> {
  const name = typeof params.name === 'string' ? params.name : ''
  const tool = MCP_TOOLS_BY_NAME.get(name)
  if (!tool)
    return { code: JSON_RPC_ERRORS.invalidParams, message: `Unknown tool: ${name}. Call tools/list to see the available Capgo tools (all start with capgo_), then call one of those.` }

  // Invalid arguments are reported as a tool error (not a protocol error) so the model can self-correct.
  const parsed = tool.inputSchema.safeParse(params.arguments ?? {})
  if (!parsed.success) {
    return textResult({
      error: 'invalid_arguments',
      message: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`,
      [GUIDANCE_KEY]: {
        kind: 'fix_input',
        next_steps: [
          `Fix the arguments listed above to match the inputSchema of ${name} (see tools/list) and call it again.`,
          'Read real IDs with the list tools (capgo_list_organizations, capgo_list_apps, capgo_list_channels, capgo_list_bundles) instead of guessing, and ask the user for values you do not know.',
        ],
      },
    }, true)
  }

  try {
    return withErrorGuidance(await tool.run(parsed.data as Record<string, unknown>, ctx), name)
  }
  catch (error) {
    return withErrorGuidance(textResult({ error: 'tool_failed', message: `Tool failed: ${error instanceof Error ? error.message : String(error)}` }, true), name)
  }
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
      const result = await callTool(paramsObject, ctx)
      if (result && 'code' in result)
        return jsonRpcError(requestId, result.code, result.message)
      return jsonRpcResult(requestId, result)
    }
    case 'resources/list':
      return jsonRpcResult(requestId, { resources: [] })
    case 'resources/templates/list':
      return jsonRpcResult(requestId, { resourceTemplates: [] })
    case 'prompts/list':
      return jsonRpcResult(requestId, { prompts: [] })
    default:
      return jsonRpcError(requestId, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}. This server supports initialize, ping, tools/list and tools/call.`)
  }
}
