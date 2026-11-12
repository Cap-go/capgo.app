import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'
import { MCP_SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS } from '../supabase/functions/_backend/mcp/metadata.ts'
import { handleJsonRpcMessage } from '../supabase/functions/_backend/mcp/protocol.ts'
import { API_CONTENT_SECURITY_POLICY } from '../supabase/functions/_backend/utils/hono.ts'

const env = { MCP_OAUTH_API_ORIGIN: 'https://api.capgo.app', MCP_OAUTH_ISSUER: 'https://capgo.app' }
const endpoint = `${env.MCP_OAUTH_API_ORIGIN}/mcp`
const request = (path: string, init?: RequestInit) => apiWorker.fetch(new Request(`https://api.usecapgo.com${path}`, init), env)

beforeAll(() => {
  for (const [key, value] of Object.entries(env))
    vi.stubEnv(key, value)
})
afterAll(() => vi.unstubAllEnvs())

describe('public MCP discovery', () => {
  it.concurrent('serves a public Server Card with the canonical endpoint and runtime identity', async () => {
    const response = await request('/mcp/server-card', { headers: { accept: 'application/mcp-server-card+json', origin: 'https://example.com' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/mcp-server-card+json')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-expose-headers')).toContain('ETag')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(response.headers.get('content-security-policy')).toBe(API_CONTENT_SECURITY_POLICY)
    const card = await response.json() as { name: string, description: string }
    expect(card).toMatchObject({
      $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
      ...MCP_SERVER_INFO,
      remotes: [{ type: 'streamable-http', url: endpoint, supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS] }],
    })
    expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/)
    expect(card.description.length).toBeLessThanOrEqual(100)
    expect(card).not.toHaveProperty('tools')
    expect(card).not.toHaveProperty('capabilities')
    const initialized = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {
      caller: { userId: 'test', apikeyId: 1, apikeyName: 'test', apikeyExpiresAt: null },
      call: async () => { throw new Error('Discovery must not call the API') },
    })
    expect(initialized?.result).toMatchObject({ serverInfo: MCP_SERVER_INFO })
  })

  it.concurrent('serves the same card at the legacy scanner URL', async () => {
    const response = await request('/.well-known/mcp/server-card.json')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(await (await request('/mcp/server-card')).json())
  })

  it.concurrent.each(['/.well-known/mcp.json', '/mcp.json'])('serves a Registry manifest at %s', async (path) => {
    const response = await request(path)
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toMatchObject({
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name: MCP_SERVER_INFO.name,
      version: MCP_SERVER_INFO.version,
      remotes: [{ type: 'streamable-http', url: endpoint }],
    })
  })

  it.concurrent('links the API host catalog to a retrievable Server Card', async () => {
    const response = await request('/.well-known/ai-catalog.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/ai-catalog+json')
    const catalog = await response.json() as { entries: { url: string }[] }
    expect(catalog).toEqual({
      specVersion: '1.0',
      entries: [{ identifier: 'urn:air:capgo.app:mcp:capgo', type: 'application/mcp-server-card+json', url: `${endpoint}/server-card` }],
    })
    expect((await apiWorker.fetch(new Request(catalog.entries[0].url), env)).status).toBe(200)
  })

  it.concurrent('supports conditional reads without returning a body', async () => {
    const initial = await request('/mcp/server-card')
    const tag = initial.headers.get('etag')!
    expect(tag).toMatch(/^"[a-f0-9]+"$/)
    const cached = await request('/mcp/server-card', { headers: { 'if-none-match': `"old", W/${tag}` } })
    expect(cached.status).toBe(304)
    expect(cached.headers.get('etag')).toBe(tag)
    expect(cached.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(cached.headers.get('access-control-allow-origin')).toBe('*')
    expect(await cached.text()).toBe('')
    expect((await request('/mcp/server-card', { headers: { 'if-none-match': '"old"' } })).status).toBe(200)
  })

  it.concurrent('allows browser cache validation preflights', async () => {
    const response = await request('/mcp/server-card', {
      method: 'OPTIONS',
      headers: { 'origin': 'https://example.com', 'access-control-request-method': 'GET', 'access-control-request-headers': 'if-none-match' },
    })
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('if-none-match')
  })
})

describe('MCP setup page and transport', () => {
  it.concurrent('allows only the setup stylesheet with a fresh CSP nonce for each response', async () => {
    const responses = await Promise.all([request('/mcp'), request('/mcp')])
    const nonces = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = await response.text()
      const nonce = body.match(/<style nonce="([\w-]+)">/)?.[1] ?? ''
      expect(Buffer.from(nonce, 'base64url').byteLength).toBeGreaterThanOrEqual(16)
      const policy = response.headers.get('content-security-policy') ?? ''
      const directives = policy.split('; ')
      expect(directives.filter(value => value.startsWith('style-src '))).toEqual([`style-src 'nonce-${nonce}'`])
      expect(directives.filter(value => !value.startsWith('style-src ')))
        .toEqual(API_CONTENT_SECURITY_POLICY.split('; ').filter(value => !value.startsWith('style-src ')))
      return nonce
    }))
    expect(new Set(nonces).size).toBe(responses.length)
  })

  it.concurrent.each([
    undefined,
    '*/*',
    'text/html,application/xhtml+xml',
    'text/html;q=1,application/json;q=0.5',
    'text/*',
    'text/*;q=1, application/json;q=0.5',
    'application/json;q=0.5, text/*;q=1',
    '*/*;q=1, application/json;q=0.5, text/event-stream;q=0.5',
    'text/*;q=0, text/html;q=1, application/json;q=0.5',
  ])('shows setup instructions for Accept %s', async (accept) => {
    const response = await request('/mcp?token=do-not-reflect', { headers: accept ? { accept } : {} })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('vary')).toContain('Accept')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).toContain('Connect with OAuth')
    expect(body).toContain(endpoint)
    expect(body).toContain('Authorization: Bearer &lt;Capgo API key&gt;')
    expect(body).toContain(`${endpoint}/server-card`)
    expect(body).not.toContain('do-not-reflect')
    expect(body).not.toContain('<script')
  })

  it.concurrent.each([
    'text/event-stream',
    'application/json',
    'application/json, text/event-stream',
    'application/*;q=1, text/html;q=0.5',
    'text/*;q=0.5, application/json;q=1',
    'text/*;q=1, text/html;q=0, application/json;q=0.5',
    'text/*;q=0, */*;q=1',
    'text/event-stream, */*',
    'application/json, */*',
    'text/html;q=0',
    '*/*;q=0',
  ])('keeps GET transport requests unsupported for %s', async (accept) => {
    const response = await request('/mcp', { headers: { accept } })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST, OPTIONS')
    expect(response.headers.get('vary')).toContain('Accept')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } })
    expect(response.headers.get('content-security-policy')).toBe(API_CONTENT_SECURITY_POLICY)
  })

  it.concurrent('still requires authentication for MCP POST requests', async () => {
    const response = await request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })
    expect(response.status).toBe(401)
    expect(response.headers.get('content-security-policy')).toBe(API_CONTENT_SECURITY_POLICY)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://api.capgo.app/.well-known/oauth-protected-resource/mcp"')
  })

  it.concurrent.each(['/mcp', '/mcp/server-card'])('supports HEAD at %s without a body', async (path) => {
    const response = await request(path, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })
})
