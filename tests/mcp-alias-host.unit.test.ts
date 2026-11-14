import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'
import { LATEST_LEGACY_PROTOCOL_VERSION } from '../supabase/functions/_backend/mcp/metadata.ts'
import { handleJsonRpcMessage } from '../supabase/functions/_backend/mcp/protocol.ts'

const env = {
  MCP_OAUTH_API_ORIGIN: 'https://api.capgo.app',
  MCP_OAUTH_ISSUER: 'https://capgo.app',
}

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'vitest', version: '1' } },
})

const listBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

function post(url: string, body: string, headers: Record<string, string> = {}) {
  return apiWorker.fetch(new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...headers,
    },
    body,
  }), env)
}

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  isIPRateLimited: async () => ({ limited: false }),
  recordFailedAuth: async () => {},
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/supabase.ts')>(),
  checkKey: async (_c: unknown, token: string) => token === 'alias-test-key'
    ? { id: 9, user_id: '00000000-0000-0000-0000-000000000099', name: 'MCP alias test', expires_at: null }
    : null,
}))

vi.mock('../supabase/functions/_backend/mcp/oauth_shared.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/mcp/oauth_shared.ts')>(),
  withPg: async () => ({ rows: [] }),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  backgroundTask: async (_c: unknown, task: unknown) => await task,
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: async () => {} }))

beforeEach(() => {
  for (const [key, value] of Object.entries(env))
    vi.stubEnv(key, value)
})

afterEach(() => vi.unstubAllEnvs())

describe('mcp.capgo.app alias host', () => {
  it('returns 404 for non-MCP routes', async () => {
    const response = await apiWorker.fetch(new Request('https://mcp.capgo.app/ok'), env)
    expect(response.status).toBe(404)
  })

  it.concurrent('routes POST / to the MCP handler with root resource metadata', async () => {
    const response = await post('https://mcp.capgo.app/', initBody)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://mcp.capgo.app/.well-known/oauth-protected-resource/mcp"')
    const prm = await apiWorker.fetch(new Request('https://mcp.capgo.app/.well-known/oauth-protected-resource/mcp'), env)
    await expect(prm.json()).resolves.toMatchObject({
      resource: 'https://mcp.capgo.app/',
      authorization_servers: ['https://capgo.app'],
    })
  })

  it.concurrent('serves POST /mcp with path-specific resource metadata on the challenge', async () => {
    const response = await post('https://mcp.capgo.app/mcp', initBody)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://mcp.capgo.app/.well-known/oauth-protected-resource/mcp"')
    const authed = await post('https://mcp.capgo.app/mcp', initBody, { authorization: 'Bearer alias-test-key' })
    expect(authed.status).toBe(200)
  })

  it.concurrent('authenticates initialize and tools/list on / and /mcp', async () => {
    const auth = { authorization: 'Bearer alias-test-key' }
    for (const path of ['https://mcp.capgo.app/', 'https://mcp.capgo.app/mcp']) {
      const init = await post(path, initBody, auth)
      expect(init.status).toBe(200)
      const initJson = await init.json()
      expect(initJson).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: expect.any(String) } })
      const list = await post(path, listBody, auth)
      expect(list.status).toBe(200)
      const listJson = await list.json()
      expect(listJson).toMatchObject({ jsonrpc: '2.0', id: 2, result: { tools: expect.any(Array) } })
      expect(listJson.result.tools.length).toBeGreaterThan(10)
    }
  })

  it.concurrent('keeps api.capgo.app/mcp metadata on the API host', async () => {
    const response = await post('https://api.capgo.app/mcp', initBody)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://api.capgo.app/.well-known/oauth-protected-resource/mcp"')
    const prm = await apiWorker.fetch(new Request('https://api.capgo.app/.well-known/oauth-protected-resource/mcp'), env)
    await expect(prm.json()).resolves.toMatchObject({ resource: 'https://api.capgo.app/mcp' })
  })

  it.concurrent('advertises OAuth endpoints on the alias host', async () => {
    const response = await apiWorker.fetch(new Request('https://mcp.capgo.app/mcp/oauth/metadata'), env)
    await expect(response.json()).resolves.toMatchObject({
      issuer: 'https://capgo.app',
      authorization_endpoint: 'https://mcp.capgo.app/mcp/oauth/authorize',
      token_endpoint: 'https://mcp.capgo.app/mcp/oauth/token',
    })
  })

  it('proof log: full initialize and tools/list on / and /mcp (Host mcp.capgo.app)', async () => {
    const auth = { authorization: 'Bearer alias-test-key' }
    const chunks: string[] = []
    for (const path of ['https://mcp.capgo.app/', 'https://mcp.capgo.app/mcp']) {
      for (const [label, body] of [['initialize', initBody], ['tools/list', listBody]] as const) {
        const response = await post(path, body, auth)
        const json = await response.json()
        const toolCount = label === 'tools/list' ? (json as { result?: { tools?: unknown[] } }).result?.tools?.length : undefined
        chunks.push([
          `=== POST ${path} ${label} (Host: mcp.capgo.app via URL) status=${response.status}${toolCount != null ? ` tools=${toolCount}` : ''} ===`,
          JSON.stringify(json, null, 2),
        ].join('\n'))
        expect(response.status).toBe(200)
      }
    }
    const proofOut = process.env.CAPGO_MCP_PROOF_OUT
    if (proofOut)
      writeFileSync(proofOut, chunks.join('\n\n'))
  })
})

describe('mcp alias initialize parity', () => {
  it('matches direct protocol handling for initialize', async () => {
    const init = await handleJsonRpcMessage(JSON.parse(initBody), {
      caller: { userId: '00000000-0000-0000-0000-000000000099', apikeyId: 9, apikeyName: 'MCP alias test', apikeyExpiresAt: null },
      call: async () => ({ ok: true, status: 200, data: {} }),
    })
    const response = await post('https://mcp.capgo.app/mcp', initBody, { authorization: 'Bearer alias-test-key' })
    const workerJson = await response.json()
    expect(workerJson.result).toMatchObject({ protocolVersion: init?.result && (init.result as { protocolVersion?: string }).protocolVersion })
  })
})