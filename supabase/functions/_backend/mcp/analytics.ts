import type { PostHogCapturePayload } from '../utils/posthog_delivery.ts'
import type { JsonRpcResponse } from './protocol.ts'
import { MCP_SERVER_INFO } from './metadata.ts'
import { PROTOCOL_VERSION_META, record } from './modern_protocol.ts'

/**
 * PostHog MCP Analytics for the hosted server (https://posthog.com/docs/mcp-analytics).
 *
 * The hosted server dispatches JSON-RPC itself on Workers, so instead of `@posthog/mcp` it sends the
 * documented `$mcp_tool_call` shape over the capture API. PostHog's MCP dashboards key on
 * `$mcp_source`, not on the sending library.
 *
 * MCP has no standard field for the calling model. Like the SDK, the server reads it from known
 * client metadata first (Codex turn metadata), then from an optional `llm_model` argument that every
 * tool advertises. Both are unverified client input: right for comparing tool quality, latency and
 * errors per model, never for billing or authorization.
 */

export const MCP_ANALYTICS_SOURCE = 'posthog_mcp_analytics'
export const MCP_TOOL_CALL_EVENT = '$mcp_tool_call'
export const LLM_MODEL_ARGUMENT = 'llm_model'
export const LLM_MODEL_DESCRIPTION = 'The model identifier you are running as, for example "claude-opus-4-8" or "gpt-5.2". Pass "unknown" if you are not certain. Recorded only for Capgo\'s tool quality analytics and never changes the result.'

const CODEX_TURN_METADATA = 'x-codex-turn-metadata'
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo'
const MAX_PROPERTY_CHARS = 256

function text(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_PROPERTY_CHARS) : undefined
}

function normalizeModel(value: unknown): string | undefined {
  const model = text(value)
  return model && model.toLowerCase() !== 'unknown' ? model : undefined
}

/** Adds the optional `llm_model` argument to a tool's JSON Schema, unless the tool already owns that name. */
export function withModelArgument(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = record(schema.properties) ?? {}
  if (LLM_MODEL_ARGUMENT in properties || schema.$ref || schema.oneOf || schema.anyOf || schema.allOf)
    return schema
  return { ...schema, properties: { ...properties, [LLM_MODEL_ARGUMENT]: { type: 'string', description: LLM_MODEL_DESCRIPTION } } }
}

/** Removes the analytics-only `llm_model` argument before the tool validates and runs its own arguments. */
export function withoutModelArgument(args: unknown): unknown {
  const values = record(args)
  if (!values || !(LLM_MODEL_ARGUMENT in values))
    return args
  const { [LLM_MODEL_ARGUMENT]: _model, ...rest } = values
  return rest
}

export function resolveModel(params: unknown): { model: string, source: 'client_metadata' | 'self_reported' } | undefined {
  const paramsRecord = record(params)
  const codexModel = normalizeModel(record(record(paramsRecord?._meta)?.[CODEX_TURN_METADATA])?.model)
  if (codexModel)
    return { model: codexModel, source: 'client_metadata' }
  const selfReported = normalizeModel(record(paramsRecord?.arguments)?.[LLM_MODEL_ARGUMENT])
  return selfReported ? { model: selfReported, source: 'self_reported' } : undefined
}

/** Low-cardinality failure class, so error rates group cleanly per tool and model. */
export function errorType(response: JsonRpcResponse): { type: string, status?: number } | undefined {
  if (response.error)
    return { type: response.error.code === -32602 ? 'validation' : 'protocol' }
  const result = record(response.result)
  if (result?.isError !== true)
    return undefined
  const body = (Array.isArray(result.content) ? result.content : [])
    .map(part => record(part))
    .find(part => part?.type === 'text' && typeof part.text === 'string')
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = record(JSON.parse(String(body?.text)))
  }
  catch {}
  const status = typeof parsed?.status === 'number' ? parsed.status : undefined
  const code = typeof parsed?.error === 'string' ? parsed.error : undefined
  if (code === 'invalid_arguments' || status === 400 || status === 422)
    return { type: 'validation', status }
  if (status === 401 || status === 403)
    return { type: 'permission', status }
  if (status === 404)
    return { type: 'not_found', status }
  if (status === 408 || status === 504)
    return { type: 'timeout', status }
  if (status === 429)
    return { type: 'rate_limit', status }
  if (code === 'tool_failed' || (status !== undefined && status >= 500))
    return { type: 'internal', status }
  return { type: 'tool_error', status }
}

/** RFC 9562 UUIDv7: 48-bit millisecond timestamp, version and variant bits, the rest random. */
function uuidV7(now: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let ms = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256
    ms = Math.floor(ms / 256)
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0F)
  bytes[8] = 0x80 | (bytes[8] & 0x3F)
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * `ses_<UUIDv7>` for one hosted HTTP request. The server is stateless, so per PostHog's manual
 * integration contract each request is its own session; never group by credential, since agents
 * sharing an API key would merge.
 */
export function newMcpSessionId(now = Date.now()): string {
  return `ses_${uuidV7(now)}`
}

export interface McpToolCallEventInput {
  message: unknown
  response: JsonRpcResponse | null | undefined
  durationMs: number
  startedAt: number
  userId: string
  /** From newMcpSessionId, shared only by the messages of one HTTP request. */
  sessionId: string
  /** OAuth client that minted the key, or `api_key` for pasted keys. */
  oauthClient: string
  /** Whether the server has a tool by this name; other names are reported as `unknown` to keep the property low-cardinality. */
  isKnownTool: (name: string) => boolean
  headers: { userAgent?: string, vendorClient?: string, protocolVersion?: string }
}

/** `$mcp_tool_call` for one tools/call that produced a response; null for anything else. */
export function mcpToolCallEvent(input: McpToolCallEventInput): PostHogCapturePayload | null {
  const message = record(input.message)
  const response = input.response
  if (message?.method !== 'tools/call' || response?.id == null)
    return null
  const params = record(message.params)
  const meta = record(params?._meta)
  const clientInfo = record(meta?.[CLIENT_INFO_META])
  const requestedName = text(params?.name)
  const toolName = requestedName && input.isKnownTool(requestedName) ? requestedName : 'unknown'
  const clientName = text(clientInfo?.name) ?? text(input.oauthClient) ?? 'unknown'
  const clientVersion = text(clientInfo?.version)
  const protocolVersion = text(meta?.[PROTOCOL_VERSION_META]) ?? text(input.headers.protocolVersion)
  const userAgent = text(input.headers.userAgent)
  const vendorClient = text(input.headers.vendorClient)
  const model = resolveModel(params)
  const failure = errorType(response)
  return {
    channel: 'mcp-hosted',
    event: MCP_TOOL_CALL_EVENT,
    user_id: input.userId,
    setPersonProperties: false,
    timestamp: new Date(input.startedAt).toISOString(),
    nonPersonTags: {
      $mcp_source: MCP_ANALYTICS_SOURCE,
      $mcp_tool_name: toolName,
      $mcp_resource_name: toolName,
      $mcp_is_error: failure !== undefined,
      $mcp_duration_ms: Math.max(0, Math.round(input.durationMs)),
      $session_id: input.sessionId,
      $mcp_server_name: MCP_SERVER_INFO.name,
      $mcp_server_version: MCP_SERVER_INFO.version,
      $mcp_interface: 'mcp',
      $mcp_client_name: clientName,
      ...(clientVersion ? { $mcp_client_version: clientVersion } : {}),
      ...(protocolVersion ? { $mcp_protocol_version: protocolVersion } : {}),
      ...(userAgent ? { $mcp_client_user_agent: userAgent } : {}),
      ...(vendorClient ? { $mcp_vendor_client: vendorClient } : {}),
      ...(model ? { $mcp_llm_model: model.model, $mcp_llm_model_source: model.source } : {}),
      ...(failure ? { $mcp_error_type: failure.type, ...(failure.status !== undefined ? { $mcp_error_status: failure.status } : {}) } : {}),
    },
  }
}
