import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (typeof globalThis.URLPattern === 'undefined') {
    globalThis.URLPattern = class URLPattern {
      #pathname: string
      constructor(init: { pathname?: string }) {
        this.#pathname = init.pathname ?? '/*'
      }

      test(url: URL) {
        if (this.#pathname === '/*')
          return true
        return url.pathname === this.#pathname
      }
    } as unknown as typeof URLPattern
  }
})

vi.mock('@cloudflare/sandbox', () => ({
  Files: class {},
}))
import { buildSessionKey } from '../cloudflare_workers/terminal/lib/security.ts'

const getAgentByNameMock = vi.fn()
const isTerminalSessionActiveMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../cloudflare_workers/terminal/lib/agent_routing.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cloudflare_workers/terminal/lib/agent_routing.ts')>()
  return {
    ...actual,
    getAgentByName: (...args: unknown[]) => getAgentByNameMock(...args),
  }
})

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
    __unsafe_ensureInitialized: vi.fn(async () => {}),
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

async function mockStreamableNamespace(agent: ReturnType<typeof makeAgent>, sessionKey: string) {
  const { terminalMcpSessionHeaderId } = await import('../cloudflare_workers/terminal/lib/security.ts')
  const headerId = await terminalMcpSessionHeaderId(sessionKey)
  const ns = {
    newUniqueId: () => ({ toString: () => headerId }),
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => agent,
    jurisdiction: () => ns,
  }
  return ns
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

  it('handleTerminalMcpRequest initializes without a client mcp-session-id header', async () => {
    const agent = makeAgent()
    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000001', 'com.test.app', 'sess')
    const terminalNs = await mockStreamableNamespace(agent, sessionKey)
    const { handleTerminalMcpRequest } = await import('../cloudflare_workers/terminal/lib/mcp_serve.ts')
    const response = await handleTerminalMcpRequest(
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
      { TERMINAL_SESSION: terminalNs as never, HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'x' } },
      {
        sessionKey,
        orgId: '00000000-0000-4000-8000-000000000001',
        appId: 'com.test.app',
      },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns 410 after session ended before routing follow-up mcp', async () => {
    isTerminalSessionActiveMock.mockResolvedValueOnce(true).mockResolvedValue(false)
    const { handleTerminalMcpWhenSessionActive } = await import('../cloudflare_workers/terminal/lib/mcp_active.ts')
    const agent = makeAgent()
    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000001', 'com.test.app', 'sess-end')
    const terminalNs = await mockStreamableNamespace(agent, sessionKey)
    const env = { HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'x' }, TERMINAL_SESSION: terminalNs } as never
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
})