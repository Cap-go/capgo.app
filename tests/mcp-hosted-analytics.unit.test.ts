import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpApp } from '../supabase/functions/_backend/mcp/index.ts'

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  query: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({ isIPRateLimited: async () => ({ limited: false }), recordFailedAuth: async () => {} }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/supabase.ts')>(),
  checkKey: async () => ({ id: 7, user_id: 'user-1', name: 'MCP · typed by the user', expires_at: null }),
}))
vi.mock('../supabase/functions/_backend/mcp/oauth_shared.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/mcp/oauth_shared.ts')>(),
  withPg: async (_c: unknown, fn: (pg: unknown) => unknown) => fn({ query: mocks.query }),
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', async original => ({ ...await original<typeof import('../supabase/functions/_backend/utils/utils.ts')>(), backgroundTask: async (_c: unknown, task: unknown) => await task }))
vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({ trackPosthogEvent: mocks.track }))

const app = createMcpApp(() => new Response('{}'))
const post = (body: unknown) => app.request('/mcp', { method: 'POST', headers: { 'authorization': 'Bearer key', 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('hosted MCP tool tracking route', () => {
  beforeEach(() => {
    mocks.track.mockReset()
    mocks.query.mockReset()
  })

  it('tracks a tool call with the OAuth client linked to the key, not the key name', async () => {
    mocks.query.mockResolvedValue({ rows: [{ client_name: 'Claude' }] })
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'capgo_nope', arguments: {} } })
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('mcp_oauth_requests'), [7])
    expect(mocks.track).toHaveBeenCalledTimes(1)
    expect(mocks.track.mock.calls[0][1]).toMatchObject({ event: 'Hosted MCP Tool Invoked', user_id: 'user-1', nonPersonTags: { tool_name: 'capgo_nope', success: false, client: 'Claude' } })
  })

  it('reports a pasted key as api_key and skips notifications', async () => {
    mocks.query.mockResolvedValue({ rows: [] })
    await post([
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'capgo_list_apps' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capgo_nope', arguments: {} } },
    ])
    expect(mocks.track).toHaveBeenCalledTimes(1)
    expect(mocks.track.mock.calls[0][1].nonPersonTags.client).toBe('api_key')
  })

  it('sends nothing when no tool ran', async () => {
    await post([
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'capgo_list_apps' } },
      { jsonrpc: '1.0', id: 3, method: 'tools/call', params: { name: 'capgo_list_apps' } },
      { jsonrpc: '2.0', id: { bad: true }, method: 'tools/call', params: { name: 'capgo_list_apps' } },
    ])
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
  })
})

describe('hosted MCP CI evidence forwarding', () => {
  it.each([
    ['GitHub Actions', 'GitHub Actions'],
    ['  GitLab CI  ', 'GitLab CI'],
    ['x'.repeat(80), 'x'.repeat(64)],
    ['Invalid\u00FC CI', null],
    ['', null],
    [undefined, null],
  ])('preserves valid evidence from an authenticated upload completion (%s)', async (provider, expected) => {
    const dispatch = vi.fn((_request: Request) => Response.json({ status: 'ok' }))
    const app = createMcpApp(dispatch)
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer key',
        'content-type': 'application/json',
        ...(provider === undefined ? {} : { 'x-cli-ci': provider }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'capgo_complete_bundle_upload', arguments: { upload_token: 'test-upload-token' } },
      }),
    })
    expect(response.status).toBe(200)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const request = dispatch.mock.calls[0]?.[0]
    expect(request?.url).toBe('http://localhost/bundle/upload/complete')
    expect(request?.method).toBe('POST')
    expect(request?.headers.get('capgkey')).toBe('key')
    expect(request?.headers.get('x-cli-ci')).toBe(expected)
    await expect(request?.json()).resolves.toEqual({ upload_token: 'test-upload-token' })
  })

  it('does not dispatch unauthenticated CI requests', async () => {
    const dispatch = vi.fn(() => Response.json({ status: 'ok' }))
    const app = createMcpApp(dispatch)
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cli-ci': 'GitHub Actions' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'capgo_complete_bundle_upload', arguments: { upload_token: 'test-upload-token' } } }),
    })
    expect(response.status).toBe(401)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('keeps the CI header out of the browser CORS allowlist', async () => {
    const response = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: {
        'origin': 'https://example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,x-cli-ci',
      },
    })
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase().split(',')).not.toContain('x-cli-ci')
  })
})
