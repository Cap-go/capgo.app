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
    await post({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'capgo_list_apps' } })
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
  })
})
