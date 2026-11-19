import type { McpApiRequest, McpToolContext } from '../supabase/functions/_backend/mcp/tools.ts'
import { describe, expect, it } from 'vitest'
import { handleJsonRpcMessage } from '../supabase/functions/_backend/mcp/protocol.ts'

function context() {
  const calls: McpApiRequest[] = []
  const ctx: McpToolContext = {
    caller: { userId: 'example-user', apikeyId: 1, apikeyName: 'Example key', apikeyExpiresAt: null },
    call: async (request) => { calls.push(request); return { ok: true, status: 200, data: { monitoring: true } } },
  }
  return { ctx, calls }
}

describe('hosted MCP monitoring calls', () => {
  it.concurrent.each([
    { view: 'release', channelId: 7, versionName: '1.2.0' },
    { view: 'errors', source: 'updater' },
    { view: 'logs', source: 'native', limit: 10 },
  ])('forwards %j through the authorized Observe API', async (input) => {
    const { ctx, calls } = context()
    await handleJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'capgo_observe', arguments: { appId: 'com.example.app', ...input } } }, ctx)
    expect(calls).toEqual([{ method: 'POST', path: '/private/observe', body: { appId: 'com.example.app', ...input } }])
  })
  it.concurrent('uses non-cancelling build snapshots with cursor', async () => {
    const { ctx, calls } = context()
    await handleJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'capgo_get_build_logs', arguments: { appId: 'com.example.app', job_id: 'ci-job', cursor: 9 } } }, ctx)
    expect(calls).toEqual([{ method: 'GET', path: '/build/logs/ci-job', query: { app_id: 'com.example.app', snapshot: true, cursor: 9 } }])
  })
})
