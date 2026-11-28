/**
 * agents@0.34.0 McpAgent.serve streamable handler against a real Miniflare DO.
 * Worker is built with wrangler.miniflare.jsonc (no container image). Sandbox I/O
 * is not exercised on tools/list after init() tool registration.
 *
 * Runs in the Cloudflare Workers vitest shard, not the fast `tests/*.unit.test.ts` job.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createTestHarness, type TestHarness } from 'wrangler'
import type { ExecutionContext } from '@cloudflare/workers-types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildSessionKey } from '../cloudflare_workers/terminal/lib/security.ts'

const noopExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

const ROOT = resolve(import.meta.dirname, '..')

const sessionActive = vi.hoisted(() => ({ value: true }))

vi.mock('@cloudflare/sandbox', () => ({
  Files: class {},
}))

vi.mock('../cloudflare_workers/terminal/lib/apikey.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cloudflare_workers/terminal/lib/apikey.ts')>()
  return {
    ...actual,
    isTerminalSessionActive: vi.fn(async () => sessionActive.value),
  }
})

function mcpHeaders(sessionId?: string): HeadersInit {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  }
  if (sessionId)
    headers['mcp-session-id'] = sessionId
  return headers
}

async function readSseJson(response: Response): Promise<{ sessionId: string | null, payload: unknown }> {
  const sessionId = response.headers.get('mcp-session-id')
  const text = await response.text()
  const dataLine = text.split('\n').find(line => line.startsWith('data: '))
  const payload = dataLine ? JSON.parse(dataLine.slice(6)) : null
  return { sessionId, payload }
}

describe('terminal mcp agents.serve durable object', () => {
  let server: TestHarness
  let prebuiltDir: string
  let terminalModules: {
    handleTerminalMcpRequest: typeof import('../cloudflare_workers/terminal/lib/mcp_serve.ts').handleTerminalMcpRequest
    handleTerminalMcpWhenSessionActive: typeof import('../cloudflare_workers/terminal/lib/mcp_active.ts').handleTerminalMcpWhenSessionActive
    getAgentByName: typeof import('../cloudflare_workers/terminal/lib/agent_routing.ts').getAgentByName
    terminalMcpSessionHeaderId: typeof import('../cloudflare_workers/terminal/lib/security.ts').terminalMcpSessionHeaderId
    terminalDurableObjectName: typeof import('../cloudflare_workers/terminal/lib/security.ts').terminalDurableObjectName
  }
  let env: import('../cloudflare_workers/terminal/terminal_session.ts').TerminalEnv

  beforeAll(async () => {
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
    sessionActive.value = true
    const [mcpServe, mcpActive, agentRouting, security] = await Promise.all([
      import('../cloudflare_workers/terminal/lib/mcp_serve.ts'),
      import('../cloudflare_workers/terminal/lib/mcp_active.ts'),
      import('../cloudflare_workers/terminal/lib/agent_routing.ts'),
      import('../cloudflare_workers/terminal/lib/security.ts'),
    ])
    terminalModules = {
      handleTerminalMcpRequest: mcpServe.handleTerminalMcpRequest,
      handleTerminalMcpWhenSessionActive: mcpActive.handleTerminalMcpWhenSessionActive,
      getAgentByName: agentRouting.getAgentByName,
      terminalMcpSessionHeaderId: security.terminalMcpSessionHeaderId,
      terminalDurableObjectName: security.terminalDurableObjectName,
    }

    prebuiltDir = mkdtempSync(join(tmpdir(), 'capgo-terminal-mcp-do-'))
    const build = spawnSync('bunx', [
      'wrangler', 'deploy',
      '--config', 'cloudflare_workers/terminal/wrangler.miniflare.jsonc',
      '--dry-run',
      `--outdir=${prebuiltDir}`,
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (build.status !== 0)
      throw new Error(`terminal wrangler dry-run failed:\n${build.stdout}\n${build.stderr}`)

    server = createTestHarness({
      workers: [{
        configPath: join(ROOT, 'cloudflare_workers/terminal/wrangler.miniflare.jsonc'),
        prebuiltWorkerDir: prebuiltDir,
      }],
    })
    await server.listen()
    env = await server.getWorker().getEnv() as import('../cloudflare_workers/terminal/terminal_session.ts').TerminalEnv
  }, 120_000)

  afterAll(async () => {
    await server?.close()
    if (prebuiltDir)
      rmSync(prebuiltDir, { recursive: true, force: true })
  })

  it('streamable MCP: init, tools/list, 410 after end, DELETE pins session id', async () => {
    const {
      handleTerminalMcpRequest,
      handleTerminalMcpWhenSessionActive,
      getAgentByName,
      terminalMcpSessionHeaderId,
      terminalDurableObjectName,
    } = terminalModules

    const sessionKey = buildSessionKey('00000000-0000-4000-8000-000000000011', 'com.test.mcpdo.app', 'sess-do-1')
    const session = {
      sessionKey,
      orgId: '00000000-0000-4000-8000-000000000011',
      appId: 'com.test.mcpdo.app',
    }

    const initResponse = await handleTerminalMcpRequest(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '1' },
          },
        }),
      }),
      env,
      session,
      noopExecutionContext,
    )
    expect(initResponse.status).toBe(200)
    const init = await readSseJson(initResponse)
    const pinned = await terminalMcpSessionHeaderId(sessionKey)
    expect(init.sessionId).toBe(pinned)
    expect(initResponse.headers.has('mcp-session-id')).toBe(true)
    expect(init.payload).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: expect.any(String) },
    })

    const listResponse = await handleTerminalMcpRequest(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'POST',
        headers: mcpHeaders(pinned),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      }),
      env,
      session,
      noopExecutionContext,
    )
    expect(listResponse.status).toBe(200)
    const listed = await readSseJson(listResponse)
    expect(listed.payload).toMatchObject({ jsonrpc: '2.0', id: 2 })
    const toolsResult = (listed.payload as { result?: { tools?: unknown[] } }).result
    expect(Array.isArray(toolsResult?.tools)).toBe(true)
    expect(toolsResult!.tools!.length).toBeGreaterThan(0)

    const agentName = await terminalDurableObjectName(sessionKey)
    const agent = await getAgentByName(env.TERMINAL_SESSION, agentName, { props: session })
    const endResponse = await agent.fetch(new Request('https://do/terminal/end', { method: 'POST' }))
    expect(endResponse.status).toBe(200)
    sessionActive.value = false

    const ended = await handleTerminalMcpWhenSessionActive(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'POST',
        headers: mcpHeaders(pinned),
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      }),
      env,
      session,
      noopExecutionContext,
    )
    expect(ended.status).toBe(410)

    sessionActive.value = true
    const delSessionKey = buildSessionKey('00000000-0000-4000-8000-000000000012', 'com.test.mcpdo.app', 'sess-do-del')
    const delSession = {
      sessionKey: delSessionKey,
      orgId: '00000000-0000-4000-8000-000000000012',
      appId: 'com.test.mcpdo.app',
    }
    const delPinned = await terminalMcpSessionHeaderId(delSessionKey)

    const delInit = await handleTerminalMcpRequest(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '1' },
          },
        }),
      }),
      env,
      delSession,
      noopExecutionContext,
    )
    expect(delInit.status).toBe(200)
    await delInit.text()

    const deleteResponse = await handleTerminalMcpRequest(
      new Request('https://api.capgo.app/terminal/mcp', {
        method: 'DELETE',
        headers: mcpHeaders('client-chosen-session-id-should-not-route'),
      }),
      env,
      delSession,
      noopExecutionContext,
    )
    expect(delPinned).not.toBe('client-chosen-session-id-should-not-route')
    expect(deleteResponse.status).toBeLessThan(500)
  }, 120_000)
})