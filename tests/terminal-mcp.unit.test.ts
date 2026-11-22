import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSessionKey } from '../cloudflare_workers/terminal/lib/security.ts'

const fetchSpy = vi.fn(async (req: Request) => {
  expect(req.headers.get('mcp-session-id')).toMatch(/^[a-f0-9]{64}$/)
  const body = await req.json() as { method: string }
  expect(body.method).toBe('tools/call')
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: '{}' }] },
  }), { headers: { 'content-type': 'application/json' } })
})

const serveSpy = vi.fn(() => ({ fetch: fetchSpy }))

vi.mock('../cloudflare_workers/terminal/terminal_session.ts', () => ({
  TerminalSession: {
    serve: serveSpy,
  },
}))

describe('terminal mcp http', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('routes tools/call through streamable-http serve with session header', async () => {
    const { handleTerminalMcpRequest } = await import('../cloudflare_workers/terminal/lib/mcp_serve.ts')

    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000001', 'com.test.app', 'sess')
    const request = new Request('https://api.capgo.app/terminal/mcp?session_key=x', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'run_command', arguments: { command: 'echo ok' } },
      }),
    })

    const response = await handleTerminalMcpRequest(request, {} as never, {
      sessionKey,
      orgId: '00000000-0000-4000-8000-000000000001',
      appId: 'com.test.app',
    })

    expect(serveSpy).toHaveBeenCalledWith('/terminal/mcp', {
      binding: 'TERMINAL_SESSION',
      transport: 'streamable-http',
    })
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(response.status).toBe(200)
  })
})