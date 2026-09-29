import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'
import { app } from '../supabase/functions/_backend/public/mcp/index.ts'
import { validateRegistration } from '../supabase/functions/_backend/public/mcp/oauth.ts'
import {
  appendRedirectQuery,
  capgoApiRoot,
  issuerUrl,
  mcpResourceUrl,
  negotiateProtocolVersion,
  pkceS256,
  resolvePublicRequestUrl,
  rewriteSupabaseMcpUrl,
  validateRedirectUri,
} from '../supabase/functions/_backend/public/mcp/protocol.ts'
import { listMcpTools } from '../supabase/functions/_backend/public/mcp/tools.ts'

describe('remote MCP protocol', () => {
  it('builds production and function resource URLs', () => {
    expect(mcpResourceUrl('https://api.capgo.app/mcp')).toBe('https://api.capgo.app/mcp')
    expect(mcpResourceUrl('https://api.capgo.app/.well-known/oauth-protected-resource')).toBe('https://api.capgo.app/mcp')
    expect(mcpResourceUrl('https://api.capgo.app/mcp/oauth/token')).toBe('https://api.capgo.app/mcp')
    expect(issuerUrl('https://api.capgo.app/mcp')).toBe('https://api.capgo.app')
    expect(mcpResourceUrl('http://127.0.0.1:54321/functions/v1/mcp/oauth/token')).toBe('http://127.0.0.1:54321/functions/v1/mcp')
    expect(capgoApiRoot('http://127.0.0.1:54321/functions/v1/mcp')).toBe('http://127.0.0.1:54321/functions/v1')
    expect(capgoApiRoot('https://api.capgo.app/mcp')).toBe('https://api.capgo.app')
    expect(rewriteSupabaseMcpUrl('http://127.0.0.1:54321/functions/v1/mcp')).toBe('http://127.0.0.1:54321/mcp')
    expect(rewriteSupabaseMcpUrl('http://127.0.0.1:54321/functions/v1/mcp/oauth/token')).toBe('http://127.0.0.1:54321/mcp/oauth/token')
    expect(rewriteSupabaseMcpUrl('http://127.0.0.1:54321/oauth/token')).toBe('http://127.0.0.1:54321/mcp/oauth/token')
    expect(resolvePublicRequestUrl('https://api.capgo.app/mcp', 'https://evil.example/mcp')).toBe('https://api.capgo.app/mcp')
    expect(resolvePublicRequestUrl(
      'http://127.0.0.1:54321/mcp',
      'http://127.0.0.1:54321/functions/v1/mcp',
    )).toBe('http://127.0.0.1:54321/functions/v1/mcp')
  })

  it('negotiates a supported protocol version', () => {
    expect(negotiateProtocolVersion('2025-06-18')).toBe('2025-06-18')
    expect(negotiateProtocolVersion('1999-01-01')).toBe('2025-03-26')
    expect(negotiateProtocolVersion(undefined)).toBe('2025-03-26')
  })

  it('requires https redirect URIs except localhost', () => {
    expect(validateRedirectUri('https://lovable.dev/callback')).toBeNull()
    expect(validateRedirectUri('http://localhost:3000/callback')).toBeNull()
    expect(validateRedirectUri('http://evil.example/callback')).toMatch(/https/)
    expect(validateRedirectUri('https://lovable.dev/callback#frag')).toMatch(/fragment/)
  })

  it('checks PKCE S256', async () => {
    const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
    const challenge = await pkceS256(verifier)
    expect(challenge).toMatch(/^[\w-]+$/)
    expect(challenge).not.toBe(verifier)
  })

  it('keeps extra query params when appending the auth code', () => {
    expect(appendRedirectQuery('https://example.com/cb?from=lovable', { code: 'abc', state: 's' }))
      .toBe('https://example.com/cb?from=lovable&code=abc&state=s')
  })

  it('rejects public client registration without a redirect', () => {
    expect(validateRegistration({})).toEqual({ error: expect.stringMatching(/client_name/) })
    const ok = validateRegistration({
      client_name: 'Lovable',
      redirect_uris: ['https://lovable.dev/mcp/callback'],
      token_endpoint_auth_method: 'none',
    })
    expect(ok).toMatchObject({ name: 'Lovable', redirectUris: ['https://lovable.dev/mcp/callback'] })
  })
})

describe('remote MCP HTTP', () => {
  it('mounts metadata on the API worker', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/.well-known/oauth-protected-resource'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ resource: 'https://api.capgo.app/mcp' })
  })

  it('publishes protected resource metadata', async () => {
    const response = await app.request('https://api.capgo.app/.well-known/oauth-protected-resource')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      resource: 'https://api.capgo.app/mcp',
      authorization_servers: ['https://api.capgo.app'],
      bearer_methods_supported: ['header'],
    })
  })

  it('publishes authorization server metadata with PKCE', async () => {
    const response = await app.request('https://api.capgo.app/.well-known/oauth-authorization-server')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      issuer: 'https://api.capgo.app',
      authorization_endpoint: 'https://api.capgo.app/mcp/oauth/authorize',
      token_endpoint: 'https://api.capgo.app/mcp/oauth/token',
      registration_endpoint: 'https://api.capgo.app/mcp/oauth/register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  })

  it('keeps TUS discovery on build uploads', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/build/upload/test-job', { method: 'OPTIONS' }))
    expect(response.status).toBe(204)
    expect(response.headers.get('Tus-Version')).toBe('1.0.0')
  })

  it('allows browser clients to preflight the MCP URL', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/mcp', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://lovable.dev',
        'Access-Control-Request-Method': 'POST',
      },
    }))
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('asks unauthenticated MCP calls to start OAuth', async () => {
    const response = await app.request('https://api.capgo.app/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata="https://api.capgo.app/.well-known/oauth-protected-resource"')
  })

  it('rejects incomplete dynamic client registration before touching the database', async () => {
    const response = await app.request('https://api.capgo.app/mcp/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Lovable' }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_client_metadata' })
  })
})

describe('remote MCP tools', () => {
  it('exposes a tool for each cloud action and no duplicate names', () => {
    const tools = listMcpTools()
    const names = tools.map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining([
      'capgo_whoami',
      'capgo_list_apps',
      'capgo_create_app',
      'capgo_delete_app',
      'capgo_list_bundles',
      'capgo_delete_bundle',
      'capgo_set_channel',
      'capgo_list_organizations',
      'capgo_invite_member',
      'capgo_list_devices',
      'capgo_get_app_stats',
      'capgo_create_webhook',
      'capgo_request_build',
      'capgo_send_notification',
    ]))
    for (const tool of tools) {
      expect(tool.name.startsWith('capgo_')).toBe(true)
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
      expect(tool.annotations.openWorldHint).toBe(false)
    }
    expect(tools.find(tool => tool.name === 'capgo_list_apps')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    })
    expect(tools.find(tool => tool.name === 'capgo_delete_app')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    })
  })
})
