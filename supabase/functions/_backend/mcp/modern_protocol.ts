import { LATEST_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSIONS, SUPPORTED_PROTOCOL_VERSIONS } from './metadata.ts'

export const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion'
export const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities'

export interface ProtocolError {
  code: number
  message: string
  data?: unknown
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function isModernRequest(message: unknown, headerVersion?: string) {
  const request = record(message)
  const version = record(record(request?.params)?._meta)?.[PROTOCOL_VERSION_META]
  return (headerVersion !== undefined && !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion))
    || version !== undefined || ['server/discover', 'skills/list', 'skills/get'].includes(String(request?.method))
}

function unsupportedVersion(requested: string): ProtocolError {
  return { code: -32022, message: 'Unsupported MCP protocol version', data: { requested, supported: [...SUPPORTED_PROTOCOL_VERSIONS] } }
}

export function validateModernRequest(message: unknown): ProtocolError | undefined {
  const request = record(message)
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
    || (request.id !== undefined && typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isInteger(request.id))))
    return { code: -32600, message: 'Invalid JSON-RPC request' }
  const meta = record(record(request.params)?._meta)
  const version = meta?.[PROTOCOL_VERSION_META]
  if (typeof version !== 'string' || !record(meta?.[CLIENT_CAPABILITIES_META]))
    return { code: -32602, message: 'Each modern MCP request requires protocolVersion and clientCapabilities in params._meta.' }
  if ((LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version))
    return { code: -32602, message: 'Use initialize for legacy MCP versions, or per-request metadata with protocol version 2026-07-28.' }
  if (version !== LATEST_PROTOCOL_VERSION)
    return unsupportedVersion(version)
  const clientInfo = meta?.['io.modelcontextprotocol/clientInfo']
  if (clientInfo !== undefined && (typeof record(clientInfo)?.name !== 'string' || typeof record(clientInfo)?.version !== 'string'))
    return { code: -32602, message: 'clientInfo must contain a name and version.' }
}

function decodeName(value: string): string | undefined {
  if (!value.startsWith('=?base64?') || !value.endsWith('?='))
    return value
  try {
    const bytes = Uint8Array.from(atob(value.slice(9, -2)), char => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  }
  catch {
    return undefined
  }
}

export function validateModernHttpRequest(message: unknown, headers: Headers): ProtocolError | undefined {
  for (const name of ['MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name']) {
    const value = headers.get(name)
    if (value && Array.from(value).some(char => char !== '\t' && (char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126)))
      return { code: -32020, message: `${name} contains invalid header characters. Encode Mcp-Name using the Base64 sentinel format when needed.` }
  }
  const headerVersion = headers.get('MCP-Protocol-Version')
  if (headerVersion && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion))
    return unsupportedVersion(headerVersion)
  const invalid = validateModernRequest(message)
  if (invalid)
    return invalid
  const request = record(message)!
  const params = record(request.params)!
  const version = record(params._meta)![PROTOCOL_VERSION_META]
  if (headerVersion !== version || headers.get('Mcp-Method') !== request.method)
    return { code: -32020, message: 'MCP-Protocol-Version and Mcp-Method headers must match the request body.' }
  const name = request.method === 'resources/read' ? params.uri : params.name
  const requiresName = ['tools/call', 'resources/read', 'prompts/get'].includes(String(request.method))
  const headerName = headers.get('Mcp-Name')
  if (requiresName && (typeof name !== 'string' || headerName === null || decodeName(headerName) !== name))
    return { code: -32020, message: 'Mcp-Name must match the tool name, prompt name or resource URI in the request body.' }
}

export function modernErrorStatus(code: number): 400 | 404 | 500 {
  return code === -32601 ? 404 : code === -32603 ? 500 : 400
}
