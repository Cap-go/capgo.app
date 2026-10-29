import { AsyncLocalStorage } from 'node:async_hooks'
import { cwd, env } from 'node:process'
import pack from '../../package.json'
import { isTruthyEnvValue } from '../posthog'
import { findSavedKeySilent, getAppId, getConfig, getLocalConfig, sendEvent } from '../utils'
import { getBuilderAppId } from '../build/app-id'
import { withCwd } from '../build/cwd'
import { resolveOwnerOrgId } from './org-resolver'
import { categorizeCliError, categorizeHttpStatus } from './error-category'
import { deriveApiOperation, setApiCallRecorder, SLOW_THRESHOLD_MS } from './api-perf'
import type { ApiCallInfo } from './api-perf'

// Global analytics props + invocation source live in ./global-props so the
// shared sendEvent() path (cli/src/utils.ts) can inject them on every event
// without a circular import. Re-exported here for existing import sites.
export { getGlobalAnalyticsProps, getInvocationSource, setInvocationSource } from './global-props'

export function isTelemetryDisabled(): boolean {
  return isTruthyEnvValue(env.CAPGO_DISABLE_TELEMETRY) || isTruthyEnvValue(env.CAPGO_DISABLE_POSTHOG)
}

// --- flush registry: keep in-flight telemetry alive until the process drains ---
const pending = new Set<Promise<unknown>>()
const pendingControllers = new Set<AbortController>()

function registerPending(promise: Promise<unknown>): void {
  pending.add(promise)
  void promise.finally(() => pending.delete(promise))
}

export async function flushAnalytics(timeoutMs = 2000): Promise<void> {
  if (pending.size === 0)
    return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      // Don't let the flush timer itself keep the process alive.
      timer.unref?.()
    }),
  ])
  if (timer)
    clearTimeout(timer)
  // Abort any still-in-flight telemetry so its sockets/timers can't keep the
  // CLI process alive past the flush window (offline / firewalled users).
  for (const controller of pendingControllers)
    controller.abort()
  pendingControllers.clear()
}

// --- best-effort app + owner-org context from the local Capacitor config ---
export function isBuilderInvocation(commandPath: string): boolean {
  return commandPath === 'build' || commandPath.startsWith('build ')
    || /^mcp:(?:capgo_builder_|start_capgo_builder_|start_capgo_build$|capgo_build_|cancel_capgo_build$)/u.test(commandPath)
}

export async function resolveTrackingContext(apikey: string, signal?: AbortSignal, builder = false): Promise<{ appId?: string, orgId?: string, apiHost?: string }> {
  try {
    const readContext = async () => {
      const extConfig = await getConfig(true).catch(() => undefined)
      const appId = (builder ? getBuilderAppId(undefined, extConfig?.config) : getAppId('', extConfig?.config)) || undefined
      const { hostApi: apiHost } = await getLocalConfig(true)
      return { appId, apiHost }
    }
    const context = mcpCommandPathStore.getStore() ? await withCwd(cwd(), readContext) : await readContext()
    const orgId = context.appId ? await resolveOwnerOrgId(apikey, context.appId, { apiHost: context.apiHost }, signal) : undefined
    return { ...context, orgId }
  }
  catch {
    return {}
  }
}

export interface TrackEventInput {
  channel: string
  event: string
  /** Org id for actor-scoped attribution. Omitted => resolved best-effort. */
  orgId?: string
  /** App id (also lets the backend verify org ownership). */
  appId?: string
  /** Explicit key; falls back to the saved key. No key => no event. */
  apikey?: string
  timestamp?: Date
  tags?: Record<string, string | number | boolean>
  nonPersonTags?: Record<string, unknown>
}

/**
 * Generic v2 actor-scoped event. Never throws. Does nothing when telemetry is
 * disabled or no API key is resolvable (the accepted unauthenticated gap).
 * When the caller omits appId/orgId, both are resolved best-effort from the
 * local Capacitor config (app_id → owner_org) so local commands still get
 * user + org attribution when the user is logged in.
 */
export function trackEvent(input: TrackEventInput): Promise<void> {
  // Sync guards run before we register, so a `void trackEvent()` followed by an
  // immediate flushAnalytics() still observes the in-flight work.
  if (isTelemetryDisabled())
    return Promise.resolve()
  const apikey = input.apikey ?? findSavedKeySilent()
  if (!apikey)
    return Promise.resolve()

  const controller = new AbortController()
  pendingControllers.add(controller)

  const work = (async () => {
    try {
      let appId = input.appId
      let orgId = input.orgId
      let apiHost: string | undefined
      if (appId === undefined && orgId === undefined) {
        const commandPath = mcpCommandPathStore.getStore() ?? (typeof input.tags?.command_path === 'string' ? input.tags.command_path : currentCommandPath)
        const ctx = await resolveTrackingContext(apikey, controller.signal, isBuilderInvocation(commandPath))
        appId = ctx.appId
        orgId = ctx.orgId
        apiHost = ctx.apiHost
        if (!apiHost)
          return
      }

      const tags: Record<string, string | number | boolean> = {
        ...(appId ? { app_id: appId } : {}),
        ...(input.tags ?? {}),
      }

      await sendEvent(apikey, {
        channel: input.channel,
        event: input.event,
        tracking_version: 2,
        ...(input.timestamp ? { timestamp: input.timestamp } : {}),
        ...(orgId ? { org_id: orgId } : {}),
        tags,
        ...(input.nonPersonTags ? { nonPersonTags: input.nonPersonTags } : {}),
      }, false, controller.signal, apiHost).catch(() => {})
    }
    catch {
      // telemetry must never break a command
    }
    finally {
      pendingControllers.delete(controller)
    }
  })()

  registerPending(work)
  return work
}

// --- universal command lifecycle ---
const CLI_USAGE_CHANNEL = 'cli-usage'

let commandStartedAt = 0
// The active command path ('bundle upload', or 'mcp:<tool>'), read by perf
// events. One command per CLI process, so a module-level value is sufficient.
let currentCommandPath = ''

// MCP tools can run concurrently, so a module-level path would race between
// overlapping handlers. The CLI runs one command per process (module-level is
// safe there); MCP scopes its path per-invocation via this async-local store.
const mcpCommandPathStore = new AsyncLocalStorage<string>()

export interface CommandContext {
  flags: string[]
  positional_arg_count: number
}

interface DeferredCommandInvocation {
  commandPath: string
  ctx: CommandContext
}

let deferredCommandInvocation: DeferredCommandInvocation | undefined

interface CommanderLike {
  args: readonly string[]
  opts: () => Record<string, unknown>
  getOptionValueSource: (key: string) => string | undefined
}

/**
 * Pulls only privacy-safe context from a Commander command: the NAMES of
 * user-provided flags (never their values) and the positional arg count.
 */
export function extractCommandContext(command: CommanderLike): CommandContext {
  const flags = Object.keys(command.opts())
    .filter(key => command.getOptionValueSource(key) === 'cli')
    .sort()
  return {
    flags,
    positional_arg_count: command.args.length,
  }
}

function emitCommandInvoked(commandPath: string, ctx: CommandContext, apikey?: string): void {
  void trackEvent({
    apikey,
    channel: CLI_USAGE_CHANNEL,
    event: 'CLI Command Invoked',
    tags: {
      command_path: commandPath,
      flags: ctx.flags.join(','),
      flags_count: ctx.flags.length,
      positional_arg_count: ctx.positional_arg_count,
    },
  })
}

export function trackCommandInvoked(commandPath: string, ctx: CommandContext, apikey?: string): void {
  commandStartedAt = Date.now()
  currentCommandPath = commandPath
  emitCommandInvoked(commandPath, ctx, apikey)
}

export function deferCommandInvocation(commandPath: string, ctx: CommandContext): void {
  commandStartedAt = Date.now()
  currentCommandPath = commandPath
  deferredCommandInvocation = { commandPath, ctx }
}

export function flushDeferredCommandInvocation(apikey: string): void {
  const invocation = deferredCommandInvocation
  if (!invocation)
    return

  deferredCommandInvocation = undefined
  emitCommandInvoked(invocation.commandPath, invocation.ctx, apikey)
}

export function trackCommandSucceeded(commandPath: string): void {
  void trackEvent({
    channel: CLI_USAGE_CHANNEL,
    event: 'CLI Command Succeeded',
    tags: {
      command_path: commandPath,
      ...(commandStartedAt ? { duration_ms: Date.now() - commandStartedAt } : {}),
    },
  })
}

export function trackCommandFailed(commandPath: string, opts: { errorCategory: string, exitCode: number }): void {
  void trackEvent({
    channel: CLI_USAGE_CHANNEL,
    event: 'CLI Command Failed',
    tags: {
      command_path: commandPath,
      error_category: opts.errorCategory,
      exit_code: opts.exitCode,
      ...(commandStartedAt ? { duration_ms: Date.now() - commandStartedAt } : {}),
    },
  })
}

// --- MCP ---
const MCP_CHANNEL = 'mcp'

type AnyAsyncFn = (...args: any[]) => Promise<any>

/**
 * Wraps an MCP tool handler to emit a `MCP Tool Invoked` event with the tool
 * name, success flag, and duration. Re-throws so behavior is unchanged.
 */
export function withMcpToolTracking<H extends AnyAsyncFn>(toolName: string, handler: H): H {
  const wrapped = (...args: Parameters<H>) => mcpCommandPathStore.run(`mcp:${toolName}`, async () => {
    const start = Date.now()
    let success = true
    try {
      const result = await handler(...args)
      if (result && typeof result === 'object' && 'isError' in result && (result as { isError?: unknown }).isError)
        success = false
      return result
    }
    catch (error) {
      success = false
      throw error
    }
    finally {
      void trackEvent({
        channel: MCP_CHANNEL,
        event: 'MCP Tool Invoked',
        tags: {
          tool_name: toolName,
          success,
          duration_ms: Date.now() - start,
        },
      })
    }
  })
  return wrapped as H
}

export function trackMcpServerStarted(hasApikey: boolean): void {
  void trackEvent({
    channel: MCP_CHANNEL,
    event: 'MCP Server Started',
    tags: {
      has_apikey: hasApikey,
      mcp_sdk_version: pack.version,
    },
  })
}

// --- Capgo API performance events ---
const CLI_PERF_CHANNEL = 'cli-perf'

/**
 * Turns a raw timed-fetch observation into a fire-and-forget `API Call`
 * event. Injected into api-perf so that module stays a leaf (no cycle).
 *
 * Only slow or failed calls are emitted. Successful fast calls were ~50% of
 * PostHog volume (mostly CI `bundle upload`) and added little beyond the
 * existing CLI command lifecycle events.
 */
function recordApiCall(info: ApiCallInfo): void {
  const slow = info.durationMs > SLOW_THRESHOLD_MS
  if (info.ok && !slow)
    return

  // MCP tool calls scope their path via the async-local store; the CLI uses the
  // module-level value set in trackCommandInvoked.
  const commandPath = mcpCommandPathStore.getStore() ?? currentCommandPath
  const tags: Record<string, string | number | boolean> = {
    operation: deriveApiOperation(info.route ?? info.url, info.method),
    method: info.method,
    status_code: info.status,
    duration_ms: info.durationMs,
    ok: info.ok,
    slow,
  }
  if (info.source)
    tags.source = info.source
  if (commandPath)
    tags.command_path = commandPath
  if (!info.ok) {
    tags.error_category = info.error !== undefined
      ? categorizeCliError(info.error)
      : categorizeHttpStatus(info.status)
  }
  // Use the key from the request itself so events fire even when the
  // key came from --apikey (not env / a saved file); trackEvent still falls back.
  void trackEvent({ apikey: info.apikey, channel: CLI_PERF_CHANNEL, event: 'API Call', tags })
}

setApiCallRecorder(recordApiCall)

export { enableApiInstrumentation } from './api-perf'
