import type { McpToolContext } from '../supabase/functions/_backend/mcp/tools.ts'
import { describe, expect, it, vi } from 'vitest'
import { LLM_MODEL_ARGUMENT, MCP_ANALYTICS_SOURCE, mcpSessionId, mcpToolCallEvent, resolveModel, withModelArgument, withoutModelArgument } from '../supabase/functions/_backend/mcp/analytics.ts'
import { MCP_SERVER_INFO } from '../supabase/functions/_backend/mcp/metadata.ts'
import { handleJsonRpcMessage, listTools } from '../supabase/functions/_backend/mcp/protocol.ts'
import { MCP_TOOLS_BY_NAME } from '../supabase/functions/_backend/mcp/tools.ts'

const call = (args: Record<string, unknown> = {}, meta?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'capgo_list_apps', arguments: args, ...(meta ? { _meta: meta } : {}) },
})

const baseInput = {
  durationMs: 41.6,
  startedAt: Date.UTC(2026, 10, 26, 10, 5),
  userId: 'user-1',
  apikeyId: 42,
  oauthClient: 'Claude',
  isKnownTool: (name: string) => name === 'capgo_list_apps',
  headers: { userAgent: 'claude-code/2.1.0', vendorClient: 'claude-code', protocolVersion: '2025-11-25' },
}

describe('hosted MCP PostHog analytics', () => {
  it.concurrent('advertises an optional llm_model argument on every tool', () => {
    for (const tool of listTools() as Array<{ name: string, inputSchema: { properties?: Record<string, { type?: string }>, required?: string[] } }>) {
      expect(tool.inputSchema.properties?.[LLM_MODEL_ARGUMENT]?.type, tool.name).toBe('string')
      expect(tool.inputSchema.required ?? [], tool.name).not.toContain(LLM_MODEL_ARGUMENT)
    }
  })

  it.concurrent('leaves schemas that own llm_model or cannot gain keys untouched', () => {
    const owned = { type: 'object', properties: { llm_model: { type: 'number' } } }
    expect(withModelArgument(owned)).toBe(owned)
    const union = { anyOf: [{ type: 'object' }] }
    expect(withModelArgument(union)).toBe(union)
  })

  // Not concurrent: it spies on a shared tool schema.
  it('strips llm_model before the tool validates its arguments', async () => {
    const tool = MCP_TOOLS_BY_NAME.get('capgo_list_apps')
    if (!tool)
      throw new Error('capgo_list_apps is missing')
    const safeParse = vi.spyOn(tool.inputSchema, 'safeParse')
    const ctx: McpToolContext = {
      call: async () => ({ ok: true, status: 200, data: [] }),
      caller: { userId: 'user-1', apikeyId: 42, apikeyName: 'MCP · Test', apikeyExpiresAt: null },
    }
    try {
      const response = await handleJsonRpcMessage(call({ llm_model: 'claude-opus-5-5' }), ctx)
      expect(response?.error).toBeUndefined()
      expect(response?.result).not.toHaveProperty('isError')
      expect(safeParse).toHaveBeenCalledTimes(1)
      expect(safeParse.mock.calls[0][0]).not.toHaveProperty(LLM_MODEL_ARGUMENT)
    }
    finally {
      safeParse.mockRestore()
    }
    expect(withoutModelArgument({ a: 1, llm_model: 'x' })).toEqual({ a: 1 })
    expect(withoutModelArgument(undefined)).toBeUndefined()
  })

  it.concurrent('prefers Codex client metadata over the self-reported model and drops unknown', () => {
    expect(resolveModel({ arguments: { llm_model: 'gpt-5.2' }, _meta: { 'x-codex-turn-metadata': { model: 'gpt-5.3-codex' } } }))
      .toEqual({ model: 'gpt-5.3-codex', source: 'client_metadata' })
    expect(resolveModel({ arguments: { llm_model: ' claude-opus-5-5 ' } })).toEqual({ model: 'claude-opus-5-5', source: 'self_reported' })
    expect(resolveModel({ arguments: { llm_model: 'Unknown' } })).toBeUndefined()
    expect(resolveModel({ arguments: { llm_model: '' } })).toBeUndefined()
  })

  it.concurrent('builds a $mcp_tool_call event with the properties PostHog requires', () => {
    const event = mcpToolCallEvent({ ...baseInput, message: call({ llm_model: 'claude-opus-5-5' }), response: { jsonrpc: '2.0', id: 1, result: { content: [] } } })
    expect(event).toMatchObject({ event: '$mcp_tool_call', user_id: 'user-1', setPersonProperties: false, timestamp: '2026-11-26T10:05:00.000Z' })
    expect(event?.nonPersonTags).toEqual({
      $mcp_source: MCP_ANALYTICS_SOURCE,
      $mcp_tool_name: 'capgo_list_apps',
      $mcp_resource_name: 'capgo_list_apps',
      $mcp_is_error: false,
      $mcp_duration_ms: 42,
      $session_id: mcpSessionId(42, 'Claude', baseInput.startedAt),
      $mcp_server_name: MCP_SERVER_INFO.name,
      $mcp_server_version: MCP_SERVER_INFO.version,
      $mcp_interface: 'mcp',
      $mcp_client_name: 'Claude',
      $mcp_protocol_version: '2025-11-25',
      $mcp_client_user_agent: 'claude-code/2.1.0',
      $mcp_vendor_client: 'claude-code',
      $mcp_llm_model: 'claude-opus-5-5',
      $mcp_llm_model_source: 'self_reported',
    })
    expect(event?.nonPersonTags?.$session_id).toMatch(/^ses_[0-9a-f]{32}$/)
  })

  it.concurrent('reads the client and protocol from modern per-request metadata', () => {
    const message = call({}, {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'codex', version: '1.2.3' },
    })
    const tags = mcpToolCallEvent({ ...baseInput, message, response: { jsonrpc: '2.0', id: 1, result: {} } })?.nonPersonTags
    expect(tags).toMatchObject({ $mcp_client_name: 'codex', $mcp_client_version: '1.2.3', $mcp_protocol_version: '2026-07-28' })
    expect(tags).not.toHaveProperty('$mcp_llm_model')
  })

  it.concurrent('classifies failures with a low-cardinality error type', () => {
    const toolError = (body: unknown) => ({ jsonrpc: '2.0' as const, id: 1, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] } })
    const typeOf = (response: Parameters<typeof mcpToolCallEvent>[0]['response']) => mcpToolCallEvent({ ...baseInput, message: call(), response })?.nonPersonTags
    expect(typeOf(toolError({ status: 403, error: 'no_access' }))).toMatchObject({ $mcp_is_error: true, $mcp_error_type: 'permission', $mcp_error_status: 403 })
    expect(typeOf(toolError({ status: 404 }))).toMatchObject({ $mcp_error_type: 'not_found' })
    expect(typeOf(toolError({ error: 'invalid_arguments' }))).toMatchObject({ $mcp_error_type: 'validation' })
    expect(typeOf(toolError({ error: 'tool_failed' }))).toMatchObject({ $mcp_error_type: 'internal' })
    expect(typeOf({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'plain failure' }] } })).toMatchObject({ $mcp_error_type: 'tool_error' })
    expect(typeOf({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad' } })).toMatchObject({ $mcp_is_error: true, $mcp_error_type: 'validation' })
  })

  it.concurrent('reports names the server does not know as unknown', () => {
    const message = { ...call(), params: { name: 'capgo_typo_123', arguments: {} } }
    expect(mcpToolCallEvent({ ...baseInput, message, response: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Unknown tool' } } })?.nonPersonTags)
      .toMatchObject({ $mcp_tool_name: 'unknown', $mcp_resource_name: 'unknown' })
  })

  it.concurrent('ignores non-tool messages and notifications', () => {
    expect(mcpToolCallEvent({ ...baseInput, message: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, response: { jsonrpc: '2.0', id: 1, result: {} } })).toBeNull()
    expect(mcpToolCallEvent({ ...baseInput, message: call(), response: null })).toBeNull()
  })

  it.concurrent('keeps one session per key and client within a 30 minute window', () => {
    const start = Date.UTC(2026, 10, 26, 10, 0)
    expect(mcpSessionId(42, 'Claude', start)).toBe(mcpSessionId(42, 'Claude', start + 29 * 60 * 1000))
    expect(mcpSessionId(42, 'Claude', start)).not.toBe(mcpSessionId(42, 'Claude', start + 30 * 60 * 1000))
    expect(mcpSessionId(42, 'Claude', start)).not.toBe(mcpSessionId(43, 'Claude', start))
  })
})
