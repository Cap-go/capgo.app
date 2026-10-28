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

describe('hosted MCP app creation conflicts', () => {
  const orgId = '7b1c2d3e-4f50-4a61-8b72-9c83d4e5f601'

  function conflictContext(getApp: { ok: boolean, status: number, data: unknown }) {
    const calls: McpApiRequest[] = []
    const ctx: McpToolContext = {
      call: async (request) => {
        calls.push(request)
        if (request.method === 'POST')
          return { ok: false, status: 409, data: { error: 'app_id_already_exists', message: 'App ID already exists' } }
        return getApp
      },
      caller: { userId: 'u', apikeyId: 1, apikeyName: 'k', apikeyExpiresAt: null },
    }
    return { ctx, calls }
  }

  async function addApp(ctx: McpToolContext) {
    const response = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'capgo_add_app', arguments: { appId: 'com.example.app', name: 'Example', orgId } },
    }, ctx)
    const result = response?.result as { content: Array<{ text: string }>, isError?: boolean }
    return { result, body: JSON.parse(result.content[0].text) }
  }

  it.concurrent('reports an app already in the target organization as usable, not as an error', async () => {
    const { ctx, calls } = conflictContext({ ok: true, status: 200, data: { app_id: 'com.example.app', owner_org: orgId } })
    const { result, body } = await addApp(ctx)
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['POST /app', 'GET /app/com.example.app'])
    expect(result.isError).toBeUndefined()
    expect(body.status).toBe('already_exists')
  })

  it.concurrent('offers solutions and alternative IDs when another account owns the app ID', async () => {
    const { ctx } = conflictContext({ ok: false, status: 404, data: { error: 'app_not_found' } })
    const { result, body } = await addApp(ctx)
    expect(result.isError).toBe(true)
    expect(body.error).toBe('app_id_already_exists')
    expect(body.suggested_app_ids).toEqual(['com.example.app.mobile', 'com.example.app.capgo', 'com.example.app.live'])
    expect(body.how_to_fix.next_steps.join(' ')).toContain('plugins.CapacitorUpdater.appId')
    expect(body.how_to_fix.next_steps.join(' ')).toContain('Transfer app ownership')
  })

  it.concurrent('explains an app ID used by another organization the caller can access', async () => {
    const { ctx } = conflictContext({ ok: true, status: 200, data: { app_id: 'com.example.app', owner_org: 'other-org' } })
    const { result, body } = await addApp(ctx)
    expect(result.isError).toBe(true)
    expect(body.owner_org).toBe('other-org')
    expect(body.suggested_app_ids.length).toBeGreaterThan(0)
  })
})

describe('hosted MCP signed-URL upload and build tools', () => {
  it.concurrent('prepares a bundle upload with the CLI packer metadata', async () => {
    const { ctx, calls } = fakeContext({ upload_token: 't' })
    await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'capgo_prepare_bundle_upload',
        arguments: { appId: 'com.example.app', version: '1.2.3', channel: ['beta', 'production'], checksum: 'abc', native_packages: [{ name: '@capacitor/camera', version: '7.0.0' }], delta: true },
      },
    }, ctx)
    expect(calls).toEqual([{
      method: 'POST',
      path: '/bundle/upload/prepare',
      body: { app_id: 'com.example.app', version: '1.2.3', channel: ['beta', 'production'], checksum: 'abc', native_packages: [{ name: '@capacitor/camera', version: '7.0.0' }], delta: true },
    }])
  })

  it.concurrent('completes a bundle upload with only the signed token', async () => {
    const { ctx, calls } = fakeContext({ version: '1.2.3' })
    await handleJsonRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capgo_complete_bundle_upload', arguments: { upload_token: 'tok' } } }, ctx)
    expect(calls).toEqual([{ method: 'POST', path: '/bundle/upload/complete', body: { upload_token: 'tok' } }])
  })

  it.concurrent('requests a build with stored credentials and returns a signed upload URL', async () => {
    const calls: McpApiRequest[] = []
    const ctx: McpToolContext = {
      call: async (request) => {
        calls.push(request)
        const data = request.path === '/build/request'
          ? { job_id: 'job-1' }
          : { upload_url: 'https://builder.example/builder_upload_direct_input/x', method: 'PUT' }
        return { ok: true, status: 200, data }
      },
      caller: { userId: 'u', apikeyId: 1, apikeyName: 'k', apikeyExpiresAt: null },
    }
    const response = await handleJsonRpcMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'capgo_request_build', arguments: { appId: 'com.example.app', platform: 'ios', build_options: { iosSourceDir: 'ios', iosDistribution: 'ad_hoc' } } },
    }, ctx)
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/build/request',
      body: {
        app_id: 'com.example.app',
        platform: 'ios',
        build_mode: 'release',
        build_options: { iosSourceDir: 'ios', iosDistribution: 'ad_hoc', platform: 'ios', buildMode: 'release' },
        use_stored_credentials: true,
      },
    })
    expect(calls[1]).toEqual({ method: 'POST', path: '/build/upload_url/job-1', body: { app_id: 'com.example.app' } })
    const result = response?.result as { content: Array<{ text: string }>, isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0].text)).toMatchObject({ job_id: 'job-1', upload: { method: 'PUT' } })
  })

  it.concurrent('keeps the job id when the signed build URL cannot be issued', async () => {
    const ctx: McpToolContext = {
      call: async request => request.path === '/build/request'
        ? { ok: true, status: 200, data: { job_id: 'job-2' } }
        : { ok: false, status: 503, data: { error: 'builder_error' } },
      caller: { userId: 'u', apikeyId: 1, apikeyName: 'k', apikeyExpiresAt: null },
    }
    const response = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'capgo_request_build', arguments: { appId: 'com.example.app', platform: 'android' } } }, ctx)
    expect(response?.result).toMatchObject({ isError: true })
    expect(JSON.stringify(response?.result)).toContain('job-2')
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

describe('hosted MCP errors always give a way out', () => {
  function failingContext(status: number, data: unknown, requestId?: string): McpToolContext {
    return {
      call: async () => ({ ok: false, status, data, requestId }),
      caller: { userId: 'u', apikeyId: 1, apikeyName: 'k', apikeyExpiresAt: null },
    }
  }

  async function callTool(name: string, args: Record<string, unknown>, ctx: McpToolContext) {
    const response = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx)
    return response?.result as { content: Array<{ text: string }>, isError?: boolean }
  }

  function guidanceOf(result: { content: Array<{ text: string }> }) {
    const text = result.content.map(part => part.text).join('\n')
    try {
      return (JSON.parse(text) as { how_to_fix?: { kind: string, next_steps: string[] } }).how_to_fix
    }
    catch {
      return text.includes('how_to_fix') ? { kind: 'text', next_steps: [text] } : undefined
    }
  }

  it.concurrent('adds how_to_fix to every error of every tool', async () => {
    const failures = [
      [400, { error: 'invalid_body', message: 'Invalid body' }],
      [401, { error: 'invalid_apikey', message: 'Invalid API key' }],
      [404, { error: 'app_not_found', message: 'App not found' }],
      [500, '<html>Internal Server Error</html>'],
    ] as const
    for (const tool of MCP_TOOLS) {
      for (const [status, data] of failures) {
        const result = await callTool(tool.name, {}, failingContext(status, data, 'req-1'))
        if (!result.isError)
          continue
        const guidance = guidanceOf(result)
        expect(guidance, `${tool.name} → ${status}`).toBeDefined()
        expect(guidance!.next_steps.length, `${tool.name} → ${status}`).toBeGreaterThan(0)
      }
    }
  })

  it.concurrent('classifies API errors and ends with a support escape hatch', async () => {
    const cases = [
      [400, 'invalid_body', 'fix_input'],
      [401, 'invalid_apikey', 'authentication'],
      [400, 'not_authorized', 'permission'],
      [404, 'app_not_found', 'not_found'],
      [409, 'version_already_exists', 'conflict'],
      [429, 'api_key_rate_limit_exceeded', 'rate_limited'],
      [400, 'need_plan_upgrade', 'plan_limit'],
      [429, 'need_plan_upgrade', 'plan_limit'],
      [400, 'org_requires_expiring_key', 'security_policy'],
      [400, 'upload_token_expired', 'expired'],
      [500, 'internal_error', 'unexpected'],
    ] as const
    for (const [status, error, kind] of cases) {
      const result = await callTool('capgo_get_app', { appId: 'com.example.app' }, failingContext(status, { error, message: error }, 'req-42'))
      const body = JSON.parse(result.content[0].text)
      expect(body.how_to_fix.kind, error).toBe(kind)
      expect(body.request_id).toBe('req-42')
      expect(body.how_to_fix.next_steps.join(' '), error).toContain('support@capgo.app')
    }
  })

  it.concurrent('guides the agent when a tool throws or gets invalid arguments', async () => {
    const throwing: McpToolContext = {
      call: async () => { throw new Error('socket hang up') },
      caller: { userId: 'u', apikeyId: 1, apikeyName: 'k', apikeyExpiresAt: null },
    }
    const thrown = await callTool('capgo_get_app', { appId: 'com.example.app' }, throwing)
    expect(thrown.isError).toBe(true)
    expect(guidanceOf(thrown)?.kind).toBe('unexpected')

    const invalid = await callTool('capgo_get_app', {}, throwing)
    expect(guidanceOf(invalid)?.kind).toBe('fix_input')
  })

  it.concurrent('points to tools/list for an unknown tool', async () => {
    const response = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'capgo_nope', arguments: {} } }, failingContext(500, null))
    expect(response?.error?.message).toContain('tools/list')
  })
})
