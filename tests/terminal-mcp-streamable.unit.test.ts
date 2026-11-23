import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSessionKey } from '../cloudflare_workers/terminal/lib/security.ts'
import { InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const getAgentByNameMock = vi.fn()
const isTerminalSessionActiveMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../cloudflare_workers/terminal/lib/agent_routing.ts', () => ({
  getAgentByName: (...args: unknown[]) => getAgentByNameMock(...args),
}))

vi.mock('../cloudflare_workers/terminal/lib/apikey.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cloudflare_workers/terminal/lib/apikey.ts')>()
  return { ...actual, isTerminalSessionActive: isTerminalSessionActiveMock }
})

function mockBridgeWebSocket() {
  const listeners: Record<string, Array<(event: { data: string }) => void>> = {}
  const client = {
    accept: vi.fn(),
    addEventListener: vi.fn((name: string, fn: (event: { data: string }) => void) => {
      listeners[name] = listeners[name] ?? []
      listeners[name].push(fn)
    }),
    send: vi.fn(),
    close: vi.fn(),
  }
  const server = {
    accept: vi.fn(),
    send: vi.fn((data: string) => {
      for (const fn of listeners.message ?? [])
        fn({ data })
    }),
    close: vi.fn(),
  }
  return { client, server }
}

function makeAgent(stubs?: { initialized?: boolean }) {
  const { client, server } = mockBridgeWebSocket()
  return {
    getInitializeRequest: vi.fn(async () => stubs?.initialized ? { method: 'initialize' } : null),
    setInitializeRequest: vi.fn(async () => {}),
    fetch: vi.fn(async () => {
      queueMicrotask(() => {
        server.send(JSON.stringify({
          type: 'cf_mcp_agent_event',
          event: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{},"serverInfo":{"name":"test","version":"0"}}}\n\n',
          close: true,
        }))
      })
      return { webSocket: client } as unknown as Response
    }),
  }
}

function mockNamespace() {
  return {
    newUniqueId: () => ({ toString: () => 'unused' }),
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({}),
  }
}

function mcpHeaders(sessionId?: string): HeadersInit {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  }
  if (sessionId)
    headers['mcp-session-id'] = sessionId
  return headers
}

describe('terminal mcp streamable http', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    isTerminalSessionActiveMock.mockImplementation(async () => true)
  })

  it('initializes without a client mcp-session-id header', async () => {
    const { createTerminalStreamingHttpHandler } = await import('../cloudflare_workers/terminal/lib/mcp_streamable_http.ts')
    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000001', 'com.test.app', 'sess')
    const agent = makeAgent()
    getAgentByNameMock.mockResolvedValue(agent)

    const ns = mockNamespace()
    const handler = createTerminalStreamingHttpHandler('/terminal/mcp', 'TERMINAL_SESSION')
    const initBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1' },
      },
    }

    const response = await handler.fetch(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify(initBody),
      }),
      { TERMINAL_SESSION: ns as never } as never,
      { props: { sessionKey, orgId: '00000000-0000-4000-8000-000000000001', appId: 'com.test.app' } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toMatch(/^[a-f0-9]{64}$/)
    expect(getAgentByNameMock).toHaveBeenCalledWith(
      ns,
      expect.stringMatching(/^streamable-http:[a-f0-9]{64}$/),
      expect.objectContaining({ props: expect.objectContaining({ sessionKey }) }),
    )
    expect(agent.setInitializeRequest).toHaveBeenCalled()
    expect(InitializeRequestSchema.safeParse(initBody).success).toBe(true)
  })

  it('lists tools after initialize with pinned session id', async () => {
    const { createTerminalStreamingHttpHandler } = await import('../cloudflare_workers/terminal/lib/mcp_streamable_http.ts')
    const { terminalMcpSessionHeaderId } = await import('../cloudflare_workers/terminal/lib/security.ts')
    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000001', 'com.test.app', 'sess2')
    const pinned = await terminalMcpSessionHeaderId(sessionKey)
    const agent = makeAgent({ initialized: true })
    getAgentByNameMock.mockResolvedValue(agent)

    const ns = mockNamespace()
    const handler = createTerminalStreamingHttpHandler('/terminal/mcp', 'TERMINAL_SESSION')
    const listBody = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }

    const response = await handler.fetch(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'POST',
        headers: mcpHeaders(pinned),
        body: JSON.stringify(listBody),
      }),
      { TERMINAL_SESSION: ns as never } as never,
      { props: { sessionKey, orgId: '00000000-0000-4000-8000-000000000001', appId: 'com.test.app' } },
    )

    expect(response.status).toBe(200)
    expect(getAgentByNameMock).toHaveBeenCalledWith(ns, `streamable-http:${pinned}`, expect.anything())
  })

  it('handleTerminalMcpRequest routes initialize through the streamable handler', async () => {
    getAgentByNameMock.mockResolvedValue(makeAgent())
    const { handleTerminalMcpRequest } = await import('../cloudflare_workers/terminal/lib/mcp_serve.ts')
    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000001', 'com.test.app', 'sess3')
    const response = await handleTerminalMcpRequest(
      new Request('https://api.capgo.app/terminal/mcp?session_key=x', {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '1' },
          },
        }),
      }),
      { TERMINAL_SESSION: mockNamespace() as never } as never,
      {
        sessionKey,
        orgId: '00000000-0000-4000-8000-000000000001',
        appId: 'com.test.app',
      },
    )
    expect(response.status).toBe(200)
    expect(getAgentByNameMock).toHaveBeenCalled()
  })

  it('returns 410 after session ended before routing follow-up mcp', async () => {
    isTerminalSessionActiveMock.mockResolvedValueOnce(true).mockResolvedValue(false)
    const { handleTerminalMcpWhenSessionActive } = await import('../cloudflare_workers/terminal/lib/mcp_active.ts')
    getAgentByNameMock.mockResolvedValue(makeAgent())
    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000001', 'com.test.app', 'sess-end')
    const env = { HYPERDRIVE_CAPGO_DIRECT_EU: {}, TERMINAL_SESSION: mockNamespace() } as never
    const initResponse = await handleTerminalMcpWhenSessionActive(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '1' },
          },
        }),
      }),
      env,
      {
        sessionKey,
        orgId: '00000000-0000-4000-8000-000000000001',
        appId: 'com.test.app',
      },
    )
    expect(initResponse.status).toBe(200)

    const ended = await handleTerminalMcpWhenSessionActive(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
      }),
      env,
      {
        sessionKey,
        orgId: '00000000-0000-4000-8000-000000000001',
        appId: 'com.test.app',
      },
    )
    expect(ended.status).toBe(410)
    expect(isTerminalSessionActiveMock).toHaveBeenCalledTimes(2)
  })

  it('rejects follow-up calls before initialize with 404 session not found', async () => {
    const { createTerminalStreamingHttpHandler } = await import('../cloudflare_workers/terminal/lib/mcp_streamable_http.ts')
    const { terminalMcpSessionHeaderId } = await import('../cloudflare_workers/terminal/lib/security.ts')
    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000001', 'com.test.app', 'sess4')
    const pinned = await terminalMcpSessionHeaderId(sessionKey)
    getAgentByNameMock.mockResolvedValue(makeAgent({ initialized: false }))

    const handler = createTerminalStreamingHttpHandler('/terminal/mcp', 'TERMINAL_SESSION')
    const response = await handler.fetch(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'POST',
        headers: mcpHeaders(pinned),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/list',
          params: {},
        }),
      }),
      { TERMINAL_SESSION: mockNamespace() as never } as never,
      { props: { sessionKey, orgId: '00000000-0000-4000-8000-000000000001', appId: 'com.test.app' } },
    )
    expect(response.status).toBe(404)
  })
})