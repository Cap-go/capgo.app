import { Files } from '@cloudflare/sandbox'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import { z } from 'zod/v3'
import {
  TERMINAL_COMMAND_TIMEOUT_MS,
  TERMINAL_IDLE_MS,
  TERMINAL_MAX_SESSION_MINUTES,
  TERMINAL_WORKSPACE_ROOT,
} from './lib/constants.ts'
import { finishTerminalSession } from './lib/apikey.ts'
import {
  assertSafeCommand,
  capOutputBytes,
  nextSessionAlarmAtMs,
  resolveWorkspacePath,
  teardownReasonAtAlarm,
} from './lib/security.ts'

type McpTextResult = { content: Array<{ type: 'text', text: string }> }

function registerMcpTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: (args: Record<string, string>) => Promise<McpTextResult>,
) {
  const register = server.registerTool as (
    toolName: string,
    config: { description: string, inputSchema: Record<string, z.ZodTypeAny> },
    cb: (args: Record<string, string>) => Promise<McpTextResult>,
  ) => void
  register(name, { description, inputSchema }, handler)
}

export interface TerminalEnv {
  TERMINAL_SESSION: DurableObjectNamespace<TerminalSession>
  HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: string }
  TERMINAL_EGRESS?: Fetcher
}

export interface TerminalProps extends Record<string, unknown> {
  sessionKey: string
  orgId: string
  appId: string
}

export interface TerminalAgentState {
  startedAtMs: number
  ended: boolean
}

export class TerminalSession extends McpAgent<TerminalEnv, TerminalAgentState, TerminalProps> {
  server = new McpServer({ name: 'Capgo Cloud Terminal', version: '1.0.0' })

  initialState: TerminalAgentState = {
    startedAtMs: Date.now(),
    ended: false,
  }

  private files: Files | null = null

  private assertActive() {
    if (this.state.ended)
      throw new Error('session_ended')
  }

  private async bumpSessionAlarm() {
    const started = this.state.startedAtMs || Date.now()
    await this.ctx.storage.setAlarm(
      nextSessionAlarmAtMs(started, TERMINAL_MAX_SESSION_MINUTES, TERMINAL_IDLE_MS, Date.now()),
    )
  }

  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/terminal/end' && request.method === 'POST') {
      await this.teardown('client_end')
      return Response.json({ status: 'ok' })
    }
    return super.onRequest(request)
  }

  async init() {
    const container = this.ctx.container
    if (!container)
      throw new Error('container_not_configured')

    this.files = new Files(container)

    registerMcpTool(
      this.server,
      'run_command',
      'Run a shell command in the session workspace. Output is streamed to connected WebSocket clients.',
      { command: z.string().min(1) },
      async ({ command }) => {
        this.assertActive()
        assertSafeCommand(command)
        await this.bumpSessionAlarm()
        await this.ensureContainer()
        const container = this.ctx.container!
        const proc = await container.exec(['sh', '-c', command], {
          cwd: TERMINAL_WORKSPACE_ROOT,
          user: '1000',
          stdout: 'pipe',
          stderr: 'combined',
          signal: AbortSignal.timeout(TERMINAL_COMMAND_TIMEOUT_MS),
        })
        let bytes = 0
        let combined = ''
        let truncated = false
        let exitCode = -1
        if (proc.stdout) {
          const reader = proc.stdout.getReader()
          const decoder = new TextDecoder()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done)
                break
              const chunk = decoder.decode(value, { stream: true })
              const capped = capOutputBytes(chunk, bytes)
              bytes = capped.total
              truncated = truncated || capped.truncated
              if (capped.text) {
                combined += capped.text
                this.broadcast(JSON.stringify({ type: 'stdout', chunk: capped.text, truncated }))
              }
              if (truncated) {
                void proc.kill?.()
                break
              }
            }
          }
          finally {
            reader.releaseLock()
          }
        }
        try {
          exitCode = await proc.exitCode
        }
        catch {
          exitCode = -1
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ exitCode, stdout: combined, truncated }),
          }],
        }
      },
    )

    registerMcpTool(
      this.server,
      'read_file',
      'Read a file under /workspace/project.',
      { path: z.string().min(1) },
      async ({ path }) => {
        this.assertActive()
        await this.bumpSessionAlarm()
        const fullPath = resolveWorkspacePath(path)
        await this.ensureContainer()
        const response = await this.files!.readFile(fullPath)
        const text = await response.text()
        const capped = capOutputBytes(text, 0)
        return {
          content: [{ type: 'text', text: JSON.stringify({ content: capped.text, truncated: capped.truncated }) }],
        }
      },
    )

    registerMcpTool(
      this.server,
      'write_file',
      'Write a file under /workspace/project.',
      { path: z.string().min(1), content: z.string() },
      async ({ path, content }) => {
        this.assertActive()
        await this.bumpSessionAlarm()
        const fullPath = resolveWorkspacePath(path)
        await this.ensureContainer()
        await this.files!.writeFile(fullPath, content)
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, path: fullPath }) }],
        }
      },
    )

    const startedAt = this.state.startedAtMs || Date.now()
    if (!this.state.startedAtMs)
      this.setState({ ...this.state, startedAtMs: startedAt })
    await this.bumpSessionAlarm()
  }

  async ensureContainer() {
    const container = this.ctx.container
    if (!container)
      throw new Error('container_not_configured')
    if (!container.running) {
      container.start({
        image: container.images.sandbox,
        enableInternet: false,
      })
      if (this.env.TERMINAL_EGRESS)
        await container.interceptAllOutboundHttp(this.env.TERMINAL_EGRESS)
      await container.setInactivityTimeout(TERMINAL_IDLE_MS)
    }
  }

  async alarm() {
    const started = this.state.startedAtMs || Date.now()
    const reason = teardownReasonAtAlarm(started, TERMINAL_MAX_SESSION_MINUTES, Date.now())
    await this.teardown(reason)
  }

  async teardown(reason: string) {
    this.setState({ ...this.state, ended: true })
    const key = this.props?.sessionKey
    if (key) {
      try {
        await finishTerminalSession(this.env.HYPERDRIVE_CAPGO_DIRECT_EU, key, reason)
      }
      catch {
        /* continue container cleanup */
      }
    }
    const container = this.ctx.container
    if (container?.running)
      await container.destroy()
    await this.ctx.storage.deleteAll()
  }
}