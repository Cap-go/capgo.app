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
import { finalizeTerminalSession } from './lib/apikey.ts'
import { TERMINAL_INTERNAL_MCP_BRIDGE } from './lib/mcp_bridge.ts'
import { buildRunCommandScript } from './lib/run_command.ts'
import { finalizeOrScheduleRetry, readPendingFinish, resolveSessionStartedAtMs, type TeardownStorage } from './lib/teardown.ts'
import {
  assertSafeCommand,
  capOutputBytes,
  nextSessionAlarmAtMs,
  readTextWithByteCap,
  resolveWorkspacePath,
  teardownReasonAtAlarm,
} from './lib/security.ts'
import { requestHasClientMcpHeaders } from './lib/ws.ts'

type McpTextResult = { content: Array<{ type: 'text', text: string }> }

const SESSION_KEY_STORAGE = 'terminal_session_key'
const SESSION_PROPS_STORAGE = 'terminal_session_props'

function registerMcpTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: (args: Record<string, string>) => Promise<McpTextResult>,
) {
  const register = server.registerTool.bind(server) as (
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
  /** DB `terminal_sessions.started_at` (epoch ms) from the reservation; seeds the session clock. */
  startedAtMs?: number
}

export interface TerminalAgentState {
  startedAtMs: number
  ended: boolean
}

export class TerminalSession extends McpAgent<TerminalEnv, TerminalAgentState, TerminalProps> {
  server = new McpServer({ name: 'Capgo Cloud Terminal', version: '1.0.0' })

  initialState: TerminalAgentState = {
    startedAtMs: 0,
    ended: false,
  }

  private files: Files | null = null

  shouldConnectionBeReadonly(_connection: unknown, _ctx: unknown): boolean {
    return true
  }

  validateStateChange(_nextState: TerminalAgentState, source: unknown): void {
    if (source !== 'server')
      throw new Error('state_readonly')
  }

  override async onConnect(
    conn: Parameters<McpAgent<TerminalEnv, TerminalAgentState, TerminalProps>['onConnect']>[0],
    ctx: Parameters<McpAgent<TerminalEnv, TerminalAgentState, TerminalProps>['onConnect']>[1],
  ): Promise<void> {
    if (requestHasClientMcpHeaders(ctx.request) && ctx.request.headers.get(TERMINAL_INTERNAL_MCP_BRIDGE) !== '1') {
      conn.close(1008, 'mcp_headers_forbidden')
      return
    }
    await super.onConnect(conn, ctx)
  }

  async onStart(props?: TerminalProps): Promise<void> {
    if (this.state.ended)
      throw new Error('session_ended')
    const key = props?.sessionKey
    if (key) {
      await this.ctx.storage.put(SESSION_KEY_STORAGE, key)
      if (props?.orgId && props?.appId)
        await this.ctx.storage.put(SESSION_PROPS_STORAGE, JSON.stringify(props))
    }
    if (props?.startedAtMs !== undefined) {
      const startedAtMs = resolveSessionStartedAtMs(props.startedAtMs, this.state.startedAtMs, Date.now())
      if (startedAtMs !== this.state.startedAtMs)
        this.setState({ ...this.state, startedAtMs })
    }
    await super.onStart(props)
  }

  private async restoreSessionIdentityFromStorage(): Promise<void> {
    if (!this.props?.sessionKey) {
      const key = await this.ctx.storage.get<string>(SESSION_KEY_STORAGE)
      if (!key)
        return
      const raw = await this.ctx.storage.get<string>(SESSION_PROPS_STORAGE)
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as TerminalProps
          if (parsed.sessionKey)
            this.props = parsed
          return
        }
        catch {
          // fall through with key only
        }
      }
      this.props = { ...this.props, sessionKey: key, orgId: this.props?.orgId ?? '', appId: this.props?.appId ?? '' }
    }
  }

  private async sessionKeyForTeardown(): Promise<string | undefined> {
    return this.props?.sessionKey
      ?? await this.ctx.storage.get<string>(SESSION_KEY_STORAGE)
      ?? undefined
  }

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
    if (this.ctx.container)
      this.files = new Files(this.ctx.container)

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
        const controller = new AbortController()
        const deadline = setTimeout(() => controller.abort(), TERMINAL_COMMAND_TIMEOUT_MS)
        const proc = await container.exec(['sh', '-c', buildRunCommandScript(command, TERMINAL_COMMAND_TIMEOUT_MS)], {
          cwd: TERMINAL_WORKSPACE_ROOT,
          user: '1000',
          stdout: 'pipe',
          stderr: 'combined',
          signal: controller.signal,
        })
        let bytes = 0
        let combined = ''
        let truncated = false
        let exitCode = -1
        try {
          if (proc.stdout) {
            const reader = proc.stdout.getReader()
            const decoder = new TextDecoder()
            // Stop reading as soon as the deadline fires, even if something still holds the pipe.
            controller.signal.addEventListener('abort', () => {
              void reader.cancel().catch(() => {})
            }, { once: true })
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
              const tail = decoder.decode()
              if (tail) {
                const capped = capOutputBytes(tail, bytes)
                bytes = capped.total
                truncated = truncated || capped.truncated
                if (capped.text) {
                  combined += capped.text
                  this.broadcast(JSON.stringify({ type: 'stdout', chunk: capped.text, truncated }))
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
          clearTimeout(deadline)
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
        const { text, truncated } = await readTextWithByteCap(response)
        return {
          content: [{ type: 'text', text: JSON.stringify({ content: text, truncated }) }],
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
      const certCheck = await container.exec(
        ['sh', '-c', 'test -r /etc/cloudflare/certs/cloudflare-containers-ca.crt'],
        { user: '0' },
      )
      const certExit = await certCheck.exitCode
      if (certExit !== 0)
        throw new Error('container_ca_cert_unavailable')
      if (this.env.TERMINAL_EGRESS) {
        await container.interceptAllOutboundHttp(this.env.TERMINAL_EGRESS)
        await container.interceptOutboundHttps('*', this.env.TERMINAL_EGRESS)
      }
    }
    await container.setInactivityTimeout(TERMINAL_IDLE_MS)
  }

  async alarm() {
    await this.restoreSessionIdentityFromStorage()
    const pending = await readPendingFinish(this.ctx.storage)
    if (pending) {
      await this.teardown(pending.reason, pending.endedAtMs)
      return
    }
    const started = this.state.startedAtMs || Date.now()
    const reason = teardownReasonAtAlarm(started, TERMINAL_MAX_SESSION_MINUTES, Date.now())
    await this.teardown(reason)
  }

  /**
   * @param endedAtMs original teardown time; retries pass the stored value so
   * billing stops at the teardown, not at the retry.
   */
  async teardown(reason: string, endedAtMs: number = Date.now()) {
    this.setState({ ...this.state, ended: true })
    await this.restoreSessionIdentityFromStorage()
    const key = await this.sessionKeyForTeardown()
    let dbFinalized = !key
    if (key) {
      dbFinalized = await finalizeOrScheduleRetry({
        storage: this.ctx.storage as unknown as TeardownStorage,
        sessionKey: key,
        reason,
        endedAtMs,
        finalize: (sessionKey, finishReason, finishEndedAtMs) =>
          finalizeTerminalSession(this.env.HYPERDRIVE_CAPGO_DIRECT_EU, sessionKey, finishReason, finishEndedAtMs),
        nowMs: () => Date.now(),
        onError: (error) => {
          console.error(JSON.stringify({
            event: 'terminal_finish_failed',
            session_key: key,
            reason,
            message: error instanceof Error ? error.message : String(error),
          }))
        },
      })
    }
    try {
      const container = this.ctx.container
      if (container?.running)
        await container.destroy()
    }
    finally {
      if (dbFinalized) {
        await this.ctx.storage.deleteAll()
      }
    }
  }
}