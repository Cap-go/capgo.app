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
  resolveWorkspacePath,
  sessionAlarmAtMs,
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
}

export interface TerminalProps extends Record<string, unknown> {
  sessionKey: string
  orgId: string
  appId: string
}

export interface TerminalAgentState {
  startedAtMs: number
  outputBytes: number
  ended: boolean
}

export class TerminalSession extends McpAgent<TerminalEnv, TerminalAgentState, TerminalProps> {
  server = new McpServer({ name: 'Capgo Cloud Terminal', version: '1.0.0' })

  initialState: TerminalAgentState = {
    startedAtMs: Date.now(),
    outputBytes: 0,
    ended: false,
  }

  private files: Files | null = null

  private assertActive() {
    if (this.state.ended)
      throw new Error('session_ended')
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
        await this.ensureContainer()
        const container = this.ctx.container!
        const proc = await container.exec(['sh', '-c', command], {
          cwd: TERMINAL_WORKSPACE_ROOT,
          user: '1000',
          stdout: 'pipe',
          stderr: 'combined',
          signal: AbortSignal.timeout(TERMINAL_COMMAND_TIMEOUT_MS),
        })
        let bytes = this.state.outputBytes
        let combined = ''
        let truncated = false
        let exitCode = -1
        try {
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
        }
        finally {
          this.setState({ ...this.state, outputBytes: bytes })
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
    await this.ctx.storage.setAlarm(sessionAlarmAtMs(startedAt, TERMINAL_MAX_SESSION_MINUTES))
  }

  async ensureContainer() {
    const container = this.ctx.container
    if (!container)
      throw new Error('container_not_configured')
    if (!container.running) {
      // Preview: allowlist in TERMINAL_EGRESS_ALLOWLIST; wire container outbound filtering when CF Sandbox exposes it.
      container.start({
        image: container.images.sandbox,
        enableInternet: true,
      })
      await container.setInactivityTimeout(TERMINAL_IDLE_MS)
    }
  }

  async alarm() {
    await this.teardown('max_duration_alarm')
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