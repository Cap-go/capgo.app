import { describe, expect, it } from 'vitest'
import { buildSessionKey } from '../cloudflare_workers/terminal/lib/security.ts'
import { mcpRequestIncludesInitialize } from '../cloudflare_workers/terminal/lib/mcp_rpc.ts'

describe('terminal mcp request parsing', () => {
  it('detects initialize in json-rpc payloads', () => {
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }
    expect(mcpRequestIncludesInitialize(init)).toBe(true)
    expect(mcpRequestIncludesInitialize({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })).toBe(false)
  })

  it('maps session keys to stable mcp session ids for follow-up calls', async () => {
    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000001', 'com.test.app', 'sess')
    const { terminalMcpSessionHeaderId } = await import('../cloudflare_workers/terminal/lib/security.ts')
    const id = await terminalMcpSessionHeaderId(sessionKey)
    expect(id).toMatch(/^[a-f0-9]{64}$/)
  })
})