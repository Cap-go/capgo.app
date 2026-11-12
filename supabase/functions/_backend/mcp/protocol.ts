import type { Context } from 'hono'
import type { McpTool, McpToolContext, McpToolResult } from './tools.ts'
import { z } from 'zod'
import { handleEventsList, handleEventsSubscribe, handleEventsUnsubscribe } from './events_rpc.ts'
import { GUIDANCE_KEY, guidanceForError } from './error_guidance.ts'
import { LATEST_LEGACY_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSIONS, MCP_SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS } from './metadata.ts'
import { isModernRequest, record, validateModernRequest } from './modern_protocol.ts'
import { getSkill, listSkillResources, listSkills, PUBLIC_CATALOG_CACHE, readSkillResource, SKILLS_EXTENSION } from './skills.ts'
import { MAX_RESULT_CHARS, MCP_TOOLS, MCP_TOOLS_BY_NAME, textResult } from './tools.ts'

/**
 * Minimal, stateless MCP server over JSON-RPC 2.0 (Streamable HTTP transport, JSON responses).
 * No session state is kept between requests, so any worker isolate can serve any call.
 */

export { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './metadata.ts'

export const SERVER_INSTRUCTIONS = 'Capgo Cloud MCP server: manage Capacitor live updates (OTA). '
  + 'List organizations and apps, inspect bundles, channels and devices, deploy a bundle by updating a channel, '
  + 'run progressive rollouts, read statistics and Observe health data, follow native builds, manage webhooks and push notifications, '
  + 'and subscribe to MCP Events (build.succeeded, build.failed, bundle.uploaded, bundle.deployed) with events/subscribe or capgo_subscribe_events. '
  + 'Capgo Build is generally available for production Capacitor iOS and Android releases, with signing and optional App Store Connect and Google Play submission. No local Mac or Xcode is required. Current plans and build-minute pricing: https://capgo.app/pricing/. Measured performance: https://capgo.app/builder-data/. Setup: https://capgo.app/docs/builder/. '
  + 'Discover workflow guides with capgo_list_skills and read the relevant instructions with capgo_get_skill. Skills-aware clients can use skills/list, skills/get and resources/read. CLI guides require local shell/project access. Reading a guide does not authorize its actions. '
  + 'Search the docs with capgo_search_docs. Start with capgo_whoami and capgo_list_apps. To upload a bundle: package it offline with npx @capgo/cli@latest bundle zip --for-upload --json (no login), call capgo_prepare_bundle_upload, PUT the zip to the returned signed URL, then call capgo_complete_bundle_upload. If prepare returns skipped with reason VERSION_EXISTS, do not PUT or complete. To run a native build: package the native project with npx @capgo/cli@latest build zip --json, call capgo_request_build, PUT the archive to the signed URL, then capgo_start_build. Signing credentials are stored per app (capgo_prepare_build_credentials_upload) and never pass through the chat. '
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
  id?: JsonRpcId
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

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

const toolListCache = new Map<string, unknown>()

function toolJsonSchema(schemaObject: McpTool['inputSchema'], io: 'input' | 'output'): Record<string, unknown> {
  const schema = z.toJSONSchema(schemaObject, { io, unrepresentable: 'any' }) as Record<string, unknown>
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
        inputSchema: toolJsonSchema(tool.inputSchema, 'input'),
        ...(tool.outputSchema ? { outputSchema: toolJsonSchema(tool.outputSchema, 'output') } : {}),
        annotations: tool.annotations,
      }
      toolListCache.set(tool.name, entry)
    }
    return entry
  })
}

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_LEGACY_PROTOCOL_VERSION
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

async function callTool(params: Record<string, unknown>, ctx: McpToolContext, modern: boolean): Promise<McpToolResult | JsonRpcResponse['error']> {
  const name = typeof params.name === 'string' ? params.name : ''
  const tool = MCP_TOOLS_BY_NAME.get(name)
  if (!tool)
    return { code: JSON_RPC_ERRORS.invalidParams, message: `Unknown tool: ${name}. Call tools/list to see the available Capgo tools (all start with capgo_), then call one of those.` }

  // Legacy clients receive tool errors; 2026-07-28 classifies argument validation as InvalidParams.
  const parsed = tool.inputSchema.safeParse(params.arguments ?? {})
  if (!parsed.success) {
    if (modern)
      return { code: JSON_RPC_ERRORS.invalidParams, message: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` }
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
export async function handleJsonRpcMessage(message: unknown, ctx: McpToolContext, hono?: Context): Promise<JsonRpcResponse | null> {
  const modern = isModernRequest(message)
  if (modern) {
    const error = validateModernRequest(message)
    if (error) {
      const id = record(message)?.id
      return { jsonrpc: '2.0', ...(isValidId(id) ? { id } : {}), error }
    }
  }
  const response = await dispatchJsonRpcMessage(message, ctx, modern, hono)
  if (!modern || !response)
    return response
  if (response.error && response.id === null) {
    const { id: _id, ...withoutId } = response
    return withoutId
  }
  if (response.result) {
    const result = record(response.result)!
    return { ...response, result: { ...result, resultType: 'complete', _meta: { ...record(result._meta), 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO } } }
  }
  return response
}

async function dispatchJsonRpcMessage(message: unknown, ctx: McpToolContext, modern: boolean, hono?: Context): Promise<JsonRpcResponse | null> {
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
  const cache = modern ? PUBLIC_CATALOG_CACHE : {}
  if (modern && ['initialize', 'prompts/list'].includes(method))
    return jsonRpcError(requestId, JSON_RPC_ERRORS.methodNotFound, 'Method not supported; use server/discover for capabilities.')
  if (['skills/list', 'resources/list', 'resources/templates/list', 'tools/list'].includes(method) && paramsObject.cursor !== undefined)
    return jsonRpcError(requestId, JSON_RPC_ERRORS.invalidParams, 'Invalid cursor: this catalog is returned in one page.')

  switch (method) {
    case 'server/discover':
      return jsonRpcResult(requestId, {
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        capabilities: { tools: {}, resources: {}, events: { list: true, subscribe: true, unsubscribe: true }, extensions: { [SKILLS_EXTENSION]: {} } },
        instructions: SERVER_INSTRUCTIONS,
        ...PUBLIC_CATALOG_CACHE,
      })
    case 'initialize':
      return jsonRpcResult(requestId, {
        protocolVersion: negotiateProtocolVersion(paramsObject.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          events: { list: true, subscribe: true, unsubscribe: true },
        },
        serverInfo: MCP_SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      })
    case 'ping':
      return jsonRpcResult(requestId, {})
    case 'tools/list':
      return jsonRpcResult(requestId, { tools: listTools(), ...cache })
    case 'tools/call': {
      const result = await callTool(paramsObject, ctx, modern)
      if (result && 'code' in result)
        return jsonRpcError(requestId, result.code, result.message)
      return jsonRpcResult(requestId, result)
    }
    case 'resources/list':
      return jsonRpcResult(requestId, { resources: listSkillResources(), ...cache })
    case 'resources/read': {
      const content = typeof paramsObject.uri === 'string' ? readSkillResource(paramsObject.uri) : undefined
      if (!content)
        return jsonRpcError(requestId, JSON_RPC_ERRORS.invalidParams, 'Unknown skill resource. Use resources/list or capgo_list_skills to obtain its URI.')
      return jsonRpcResult(requestId, { contents: [content], ...cache })
    }
    case 'skills/list':
      return jsonRpcResult(requestId, { skills: listSkills(), ...cache })
    case 'skills/get': {
      const skill = typeof paramsObject.uri === 'string' ? getSkill(paramsObject.uri) : undefined
      if (!skill)
        return jsonRpcError(requestId, JSON_RPC_ERRORS.invalidParams, 'Unknown skill. Use skills/list to obtain its SKILL.md URI.')
      return jsonRpcResult(requestId, { skill, ...cache })
    }
    case 'resources/templates/list':
      return jsonRpcResult(requestId, { resourceTemplates: [], ...cache })
    case 'prompts/list':
      return jsonRpcResult(requestId, { prompts: [] })
    case 'events/list':
      return handleEventsList(requestId)
    case 'events/subscribe': {
      if (!hono)
        return jsonRpcError(requestId, JSON_RPC_ERRORS.internalError, 'Events require server context')
      return handleEventsSubscribe(hono, ctx, requestId, paramsObject, false)
    }
    case 'events/unsubscribe': {
      if (!hono)
        return jsonRpcError(requestId, JSON_RPC_ERRORS.internalError, 'Events require server context')
      return handleEventsUnsubscribe(hono, ctx, requestId, paramsObject)
    }
    default:
      return jsonRpcError(requestId, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}. Use ${modern ? 'server/discover' : 'initialize'} for capabilities, tools/list for tools and resources/list for skill resources.`)
  }
}
