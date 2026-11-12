import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMcpApp } from '../supabase/functions/_backend/mcp/index.ts'
import { LATEST_PROTOCOL_VERSION } from '../supabase/functions/_backend/mcp/metadata.ts'
import { skillSchema } from '../supabase/functions/_backend/mcp/skills.ts'
import { CLIENT_CAPABILITIES_META, PROTOCOL_VERSION_META } from '../supabase/functions/_backend/mcp/modern_protocol.ts'

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({ isIPRateLimited: async () => ({ limited: false }), recordFailedAuth: async () => {} }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/supabase.ts')>(),
  checkKey: async (_c: unknown, token: string) => token === 'test-key' ? { id: 7, user_id: 'skill-test-user', name: 'test', expires_at: null } : null,
}))
vi.mock('../supabase/functions/_backend/mcp/oauth_shared.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/mcp/oauth_shared.ts')>(),
  withPg: async () => ({ rows: [] }),
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', async original => ({ ...await original<typeof import('../supabase/functions/_backend/utils/utils.ts')>(), backgroundTask: async (_c: unknown, task: unknown) => await task }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: async () => {} }))

const uri = 'skill://capgo/ship-live-update/SKILL.md'
const meta = { [PROTOCOL_VERSION_META]: LATEST_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META]: {} }
function setup() {
  const dispatch = vi.fn(() => Response.json({ status: 'ok' }))
  return { app: createMcpApp(dispatch), dispatch }
}
function request(method: string, params: Record<string, unknown> = {}, overrides: Record<string, string> = {}) {
  const name = method === 'resources/read' ? params.uri : params.name
  return {
    method: 'POST',
    headers: {
      'authorization': 'Bearer test-key', 'content-type': 'application/json', 'accept': 'application/json, text/event-stream',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-method': method,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}), ...overrides,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: meta, ...params } }),
  }
}

describe('authenticated skills transport', () => {
  it.concurrent('publishes one complete catalog with no more than five unique skill names', async () => {
    const { app, dispatch } = setup()
    const response = await app.request('/mcp', request('skills/list'))
    expect(response.status).toBe(200)
    const payload = z.object({ result: z.object({ resultType: z.literal('complete'), skills: skillSchema.array() }).passthrough() }).parse(await response.json())
    const { skills } = payload.result
    expect(skills).toHaveLength(5)
    expect(new Set(skills.map(skill => skill.frontmatter.name)).size).toBeLessThanOrEqual(5)
    expect(payload.result.resultType).toBe('complete')
    expect(payload.result).not.toHaveProperty('nextCursor')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.concurrent('discovers, lists, gets and reads a skill without initializing or dispatching an API request', async () => {
    const { app, dispatch } = setup()
    for (const [method, params] of [
      ['server/discover', {}], ['skills/list', {}], ['skills/get', { uri }], ['resources/read', { uri }],
      ['tools/list', {}], ['tools/call', { name: 'capgo_get_skill', arguments: { uri } }],
    ] as const) {
      const response = await app.request('/mcp', request(method, params))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } })
    }
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.concurrent.each(['', 'Bearer invalid'])('requires a valid credential for skill reads (%s)', async (authorization) => {
    const { app, dispatch } = setup()
    const response = await app.request('/mcp', request('resources/read', { uri }, { authorization }))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
    expect(await response.json()).not.toHaveProperty('id')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.concurrent.each([
    ['mcp-method', 'skills/list'], ['mcp-method', ''], ['mcp-name', 'capgo_delete_app'],
    ['mcp-name', ''], ['mcp-name', '=?base64?invalid!?='], ['mcp-protocol-version', '2025-11-25'], ['mcp-protocol-version', ''],
    ['mcp-name', 'café'],
  ])('rejects mismatched %s=%s before a tool can run', async (header, value) => {
    const { app, dispatch } = setup()
    const response = await app.request('/mcp', request('tools/call', { name: 'capgo_list_apps', arguments: {} }, { [header]: value }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ id: 1, error: { code: -32020 } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.concurrent('decodes a Base64 Mcp-Name before comparing the resource URI', async () => {
    const { app } = setup()
    const response = await app.request('/mcp', request('resources/read', { uri }, { 'mcp-name': `=?base64?${btoa(uri)}?=` }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: { contents: [{ uri, mimeType: 'text/markdown', text: expect.stringContaining('ship-live-update') }] } })
  })

  it.concurrent('reports unsupported versions with supported alternatives', async () => {
    const { app } = setup()
    const response = await app.request('/mcp', request('skills/list', { _meta: { ...meta, [PROTOCOL_VERSION_META]: '2099-01-01' } }, { 'mcp-protocol-version': '2099-01-01' }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: -32022, data: { requested: '2099-01-01', supported: expect.arrayContaining([LATEST_PROTOCOL_VERSION]) } } })
  })

  it.concurrent.each([undefined, {}, { [PROTOCOL_VERSION_META]: LATEST_PROTOCOL_VERSION }])('rejects missing request metadata %j', async (_meta) => {
    const { app } = setup()
    const response = await app.request('/mcp', request('skills/list', { _meta }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: -32602 } })
  })

  it.concurrent('rejects modern batches before dispatch', async () => {
    const { app, dispatch } = setup()
    const init = request('tools/call', { name: 'capgo_list_apps', arguments: {} })
    init.body = JSON.stringify([JSON.parse(init.body)])
    const response = await app.request('/mcp', init)
    expect(response.status).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.concurrent('returns HTTP 404 for an unknown method and HTTP 400 for an unknown resource', async () => {
    const { app } = setup()
    expect((await app.request('/mcp', request('resources/directory/read', { uri }))).status).toBe(404)
    expect((await app.request('/mcp', request('resources/read', { uri: 'file:///etc/passwd' }))).status).toBe(400)
  })

  it.concurrent('reports invalid modern tool arguments without running the tool', async () => {
    const { app, dispatch } = setup()
    const response = await app.request('/mcp', request('tools/call', { name: 'capgo_get_skill', arguments: {} }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ id: 1, error: { code: -32602 } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.concurrent('allows the modern headers through CORS', async () => {
    const { app } = setup()
    const response = await app.request('/mcp', { method: 'OPTIONS', headers: { 'origin': 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'mcp-method,mcp-name,mcp-protocol-version' } })
    expect(response.headers.get('access-control-allow-headers')).toContain('Mcp-Method')
    expect(response.headers.get('access-control-allow-headers')).toContain('Mcp-Name')
  })
})
