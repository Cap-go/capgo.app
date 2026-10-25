import type { McpApiRequest, McpToolContext } from '../supabase/functions/_backend/mcp/tools.ts'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import apiWorker from '../cloudflare_workers/api/index.ts'
import {
  base64UrlEncode,
  buildRedirectUrl,
  decryptWithCode,
  encryptWithCode,
  getPinnedClientMetadata,
  isAllowedRedirectUri,
  isClientIdMetadataUrl,
  randomToken,
  redirectUriMatches,
  sanitizeClientName,
  verifyPkceS256,
} from '../supabase/functions/_backend/mcp/oauth_utils.ts'
import { handleJsonRpcMessage, LATEST_PROTOCOL_VERSION, listTools } from '../supabase/functions/_backend/mcp/protocol.ts'
import { MCP_TOOLS } from '../supabase/functions/_backend/mcp/tools.ts'

function fakeContext(response: unknown = { ok: true }) {
  const calls: McpApiRequest[] = []
  const ctx: McpToolContext = {
    call: async (request) => {
      calls.push(request)
      return { ok: true, status: 200, data: response }
    },
    caller: { userId: '00000000-0000-0000-0000-000000000001', apikeyId: 42, apikeyName: 'MCP · Test', apikeyExpiresAt: null },
  }
  return { ctx, calls }
}

describe('hosted MCP discovery', () => {
  it.concurrent('serves RFC 9728 protected resource metadata', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/.well-known/oauth-protected-resource/mcp'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      resource: 'https://api.capgo.app/mcp',
      authorization_servers: ['https://api.capgo.app'],
      bearer_methods_supported: ['header'],
    })
  })

  it.concurrent('serves RFC 8414 authorization server metadata with PKCE, DCR and CIMD', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/.well-known/oauth-authorization-server'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      issuer: 'https://api.capgo.app',
      authorization_endpoint: 'https://api.capgo.app/mcp/oauth/authorize',
      token_endpoint: 'https://api.capgo.app/mcp/oauth/token',
      registration_endpoint: 'https://api.capgo.app/mcp/oauth/register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    })
  })

  it.concurrent('exposes the same metadata at /mcp/oauth/metadata', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/mcp/oauth/metadata'))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ issuer: 'https://api.capgo.app' })
  })

  it.concurrent('allows browser-based MCP clients through CORS', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/mcp', {
      method: 'OPTIONS',
      headers: {
        'origin': 'https://lovable.dev',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,mcp-protocol-version',
      },
    }))
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('hosted MCP transport', () => {
  it.concurrent('asks unauthenticated clients to start OAuth with a WWW-Authenticate challenge', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } }),
    }))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://api.capgo.app/.well-known/oauth-protected-resource/mcp"')
  })

  it.concurrent('rejects GET because the server is stateless', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/mcp', { headers: { accept: 'text/event-stream' } }))
    expect(response.status).toBe(405)
  })
})

describe('hosted MCP protocol', () => {
  it.concurrent('negotiates the protocol version on initialize', async () => {
    const { ctx } = fakeContext()
    const latest = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx)
    expect(latest?.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'capgo' } })
    const unknown = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, ctx)
    expect(unknown?.result).toMatchObject({ protocolVersion: LATEST_PROTOCOL_VERSION })
  })

  it.concurrent('does not answer notifications', async () => {
    const { ctx } = fakeContext()
    await expect(handleJsonRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)).resolves.toBeNull()
  })

  it.concurrent('returns method not found for unknown methods', async () => {
    const { ctx } = fakeContext()
    const response = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 3, method: 'sampling/createMessage' }, ctx)
    expect(response?.error?.code).toBe(-32601)
  })

  it.concurrent('lists every tool with a JSON object schema and annotations', () => {
    const tools = listTools() as Array<{ name: string, inputSchema: { type: string }, annotations: Record<string, unknown> }>
    expect(tools.length).toBe(MCP_TOOLS.length)
    expect(tools.length).toBeGreaterThan(40)
    const names = new Set<string>()
    for (const tool of tools) {
      expect(tool.name).toMatch(/^capgo_[a-z_]{2,58}$/)
      expect(names.has(tool.name)).toBe(false)
      names.add(tool.name)
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema).not.toHaveProperty('$schema')
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean')
    }
  })

  it.concurrent('uses delta terms, never the deprecated partial ones, in hosted and local MCP tools', () => {
    const deprecated = /partial/i
    expect(JSON.stringify(listTools())).not.toMatch(deprecated)
    for (const file of ['cli/src/mcp/tool-schemas.ts', 'cli/src/mcp/server.ts']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replaceAll(/\bPartial</g, '')
      expect(source, file).not.toMatch(deprecated)
    }
  })

  it.concurrent('marks tools that reach systems outside Capgo as open-world', () => {
    const openWorld = [
      'capgo_invite_organization_member', // sends an invitation email
      'capgo_create_bundle_from_url', // devices download from a third-party URL
      'capgo_fetch_store_metadata',
      'capgo_add_webhook',
      'capgo_test_webhook',
      'capgo_retry_webhook_delivery',
      'capgo_send_notification',
      'capgo_trigger_update_check',
      'capgo_set_website_live_icon', // fetches the customer's website icon
      'capgo_update_website_live_store', // checks the customer's website
    ]
    const byName = new Map(MCP_TOOLS.map(tool => [tool.name, tool]))
    for (const name of openWorld)
      expect(byName.get(name)?.annotations.openWorldHint, name).toBe(true)
  })

  it.concurrent('replays tool calls as public API requests', async () => {
    const { ctx, calls } = fakeContext([{ id: 1, name: '1.0.0' }])
    const response = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'capgo_list_bundles', arguments: { appId: 'com.example.app', page: 1 } },
    }, ctx)
    expect(calls).toEqual([{ method: 'GET', path: '/bundle', query: { app_id: 'com.example.app', page: 1, fields: 'summary' } }])
    expect(response?.result).toMatchObject({ content: [{ type: 'text' }] })
    expect(response?.result).not.toHaveProperty('isError')
  })

  it.concurrent('keeps full bundle rows for single-bundle lookups', async () => {
    const { ctx, calls } = fakeContext([{ id: 1, name: '1.0.0', native_packages: [{ name: '@capacitor/camera', version: '6.0.0' }], manifest: [{ file_name: 'index.html' }] }])
    const response = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'capgo_list_bundles', arguments: { appId: 'com.example.app', version: '1.0.0' } },
    }, ctx)
    expect(calls).toEqual([{ method: 'GET', path: '/bundle', query: { app_id: 'com.example.app', version: '1.0.0' } }])
    const text = (response?.result as { content: { text: string }[] }).content[0].text
    expect(text).toContain('@capacitor/camera')
    expect(text).toContain('index.html')
  })

  it.concurrent('maps channel deploys to POST /channel without undefined fields', async () => {
    const { ctx, calls } = fakeContext()
    await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'capgo_update_channel', arguments: { appId: 'com.example.app', channel: 'production', version: '1.2.3' } },
    }, ctx)
    expect(calls).toEqual([{ method: 'POST', path: '/channel', body: { app_id: 'com.example.app', channel: 'production', version: '1.2.3' } }])
  })

  it.concurrent('maps settings parity tools to their public API routes', async () => {
    const { ctx, calls } = fakeContext()
    const call = (id: number, name: string, args: Record<string, unknown>) => handleJsonRpcMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, ctx)
    await call(20, 'capgo_update_app', { appId: 'com.example.app', allow_preview: true, build_timeout_seconds: 600, default_upload_channel: 'beta', device_data_collection: { country: false } })
    await call(21, 'capgo_update_channel', { appId: 'com.example.app', channel: 'production', paused: true, updatePackage: 'delta' })
    await call(22, 'capgo_delete_channel', { appId: 'com.example.app', channel: 'beta', delete_bundle: true })
    await call(23, 'capgo_update_organization', { orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8', email_preferences: { weekly_stats: false } })
    await call(24, 'capgo_update_organization_member_role', { orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8', email: 'member@example.com', role: 'org_admin' })
    await call(25, 'capgo_get_account', {})
    await call(26, 'capgo_update_account', { first_name: 'Ada', email_preferences: { weekly_stats: false } })
    expect(calls).toEqual([
      { method: 'PUT', path: '/app/com.example.app', body: { allow_preview: true, build_timeout_seconds: 600, default_upload_channel: 'beta', device_data_collection: { country: false } } },
      { method: 'POST', path: '/channel', body: { app_id: 'com.example.app', channel: 'production', paused: true, updatePackage: 'delta' } },
      { method: 'DELETE', path: '/channel', body: { app_id: 'com.example.app', channel: 'beta', delete_bundle: true } },
      { method: 'PUT', path: '/organization', body: { orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8', email_preferences: { weekly_stats: false } } },
      { method: 'PUT', path: '/organization/members', body: { orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8', email: 'member@example.com', role: 'org_admin' } },
      { method: 'GET', path: '/user' },
      { method: 'PUT', path: '/user', body: { first_name: 'Ada', email_preferences: { weekly_stats: false } } },
    ])
  })

  it.concurrent('rejects build timeouts outside the API range before calling it', async () => {
    const { ctx, calls } = fakeContext()
    const response = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 27,
      method: 'tools/call',
      params: { name: 'capgo_update_app', arguments: { appId: 'com.example.app', build_timeout_seconds: 60 } },
    }, ctx)
    expect(calls).toHaveLength(0)
    expect(response?.result).toMatchObject({ isError: true })
  })

  it.concurrent('reports invalid arguments as a tool error so the model can retry', async () => {
    const { ctx, calls } = fakeContext()
    const response = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'capgo_delete_bundle', arguments: { appId: 'com.example.app' } },
    }, ctx)
    expect(calls).toHaveLength(0)
    expect(response?.result).toMatchObject({ isError: true })
  })

  it.concurrent('surfaces API errors as tool errors', async () => {
    const ctx: McpToolContext = {
      call: async () => ({ ok: false, status: 400, data: { error: 'cannot_delete_linked_version', message: 'linked' } }),
      caller: { userId: 'u', apikeyId: 1, apikeyName: 'k', apikeyExpiresAt: null },
    }
    const response = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'capgo_delete_bundle', arguments: { appId: 'com.example.app', version: '1.0.0' } },
    }, ctx)
    expect(response?.result).toMatchObject({ isError: true })
    expect(JSON.stringify(response?.result)).toContain('cannot_delete_linked_version')
  })

  it.concurrent('answers whoami from the authenticated key without an API call', async () => {
    const { ctx, calls } = fakeContext()
    const response = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'capgo_whoami' } }, ctx)
    expect(calls).toHaveLength(0)
    expect(JSON.stringify(response?.result)).toContain('MCP · Test')
  })

  it.concurrent('returns a quoted CLI upload command using the caller key', async () => {
    const { ctx, calls } = fakeContext({ app_id: 'com.example.app' })
    ctx.apikey = 'key-123'
    const response = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'capgo_get_upload_command', arguments: { appId: 'com.example.app', path: 'dist', channel: 'it\'s', delta: true } },
    }, ctx)
    expect(calls).toEqual([{ method: 'GET', path: '/app/com.example.app' }])
    const result = response?.result as { content: Array<{ text: string }>, isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text).command).toBe(
      `CAPGO_TOKEN='key-123' bunx @capgo/cli@latest bundle upload 'com.example.app' --path 'dist' --channel 'it'\\''s' --delta`,
    )
  })

  it.concurrent('refuses the upload command when the key cannot read the app', async () => {
    const ctx: McpToolContext = {
      call: async () => ({ ok: false, status: 404, data: { error: 'app_not_found' } }),
      caller: { userId: 'u', apikeyId: 1, apikeyName: 'k', apikeyExpiresAt: null },
      apikey: 'key-123',
    }
    const response = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'capgo_get_upload_command', arguments: { appId: 'com.example.app' } },
    }, ctx)
    expect(response?.result).toMatchObject({ isError: true })
    expect(JSON.stringify(response?.result)).not.toContain('key-123')
  })
})

describe('hosted MCP OAuth helpers', () => {
  it.concurrent('verifies PKCE S256 challenges', async () => {
    const verifier = randomToken(48)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    await expect(verifyPkceS256(verifier, challenge)).resolves.toBe(true)
    await expect(verifyPkceS256(randomToken(48), challenge)).resolves.toBe(false)
    await expect(verifyPkceS256('short', challenge)).resolves.toBe(false)
  })

  it.concurrent('encrypts the minted key so only the code holder can read it', async () => {
    const code = randomToken(32)
    const sealed = await encryptWithCode('ae6e7458-c46d-4c00-aa3b-153b0b8520ea', code)
    expect(sealed).not.toContain('ae6e7458')
    await expect(decryptWithCode(sealed, code)).resolves.toBe('ae6e7458-c46d-4c00-aa3b-153b0b8520ea')
    await expect(decryptWithCode(sealed, randomToken(32))).resolves.toBeNull()
  })

  it.concurrent('only accepts safe redirect URIs', () => {
    expect(isAllowedRedirectUri('https://lovable.dev/oauth/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost:6274/oauth/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://127.0.0.1/callback')).toBe(true)
    expect(isAllowedRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://evil.example/callback')).toBe(false)
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false)
    expect(isAllowedRedirectUri('https://lovable.dev/cb#fragment')).toBe(false)
    expect(isAllowedRedirectUri(42)).toBe(false)
  })

  it.concurrent('matches loopback redirect URIs on any port only', () => {
    expect(redirectUriMatches(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(redirectUriMatches(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/other')).toBe(false)
    expect(redirectUriMatches(['http://127.0.0.1:3000/cb'], 'http://127.0.0.1:53121/cb')).toBe(true)
    expect(redirectUriMatches(['http://127.0.0.1:3000/cb'], 'http://127.0.0.1:53121/other')).toBe(false)
    expect(redirectUriMatches(['https://app.example/cb'], 'https://app.example:444/cb')).toBe(false)
  })

  it.concurrent('builds redirects and sanitizes client metadata', () => {
    expect(buildRedirectUrl('https://app.example/cb?x=1', { code: 'abc', state: null, iss: 'https://api.capgo.app' }))
      .toBe('https://app.example/cb?x=1&code=abc&iss=https%3A%2F%2Fapi.capgo.app')
    expect(sanitizeClientName('  Lovable\n', 'fallback')).toBe('Lovable')
    expect(sanitizeClientName('', 'fallback')).toBe('fallback')
    expect(isClientIdMetadataUrl('https://app.example/oauth/client.json')).toBe(true)
    expect(isClientIdMetadataUrl('mcp_abc')).toBe(false)
    expect(getPinnedClientMetadata('https://chatgpt.com/oauth/client.json')?.redirect_uris)
      .toEqual(['https://chatgpt.com/connector_platform_oauth_redirect'])
    expect(getPinnedClientMetadata('https://connect.smithery.ai/.well-known/oauth-client')?.redirect_uris)
      .toEqual(['https://connect.smithery.ai/oauth/callback'])
    expect(getPinnedClientMetadata('https://mcp.so/api/mcp-servers/oauth/client-metadata')?.redirect_uris)
      .toEqual(['https://mcp.so/api/mcp-servers/oauth/callback'])
    expect(getPinnedClientMetadata('https://app.example/oauth/client.json')).toBeNull()
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe('-_8')
  })
})
