// src/build/onboarding/mcp/build-job.ts
//
// The MCP-owned cloud-build job manager backing the build tools
// (start_capgo_build / capgo_build_wait / capgo_build_logs / cancel_capgo_build).
//
// The build is a CLOUD build: locally we spawn `capgo build request … --output-
// record <path>` as a TRACKED BACKGROUND CHILD of the long-lived MCP server (NOT
// detached — it dies cleanly with the session, no orphans). The child streams its
// stdout/stderr straight to a local log file (an OS-level fd redirect, so logs
// keep landing on disk independent of the server's event loop), and writes the
// build OUTCOME to the per-(appId, platform) build record when the cloud build
// finishes. From those two artifacts the manager derives status, drains logs by
// cursor, and cancels.
//
// DURABILITY (v1, deliberately minimal): the live handle (child pid) lives ONLY
// in this process-local registry. The build itself runs cloud-side regardless,
// and the OUTCOME is always recoverable from the on-disk record — so if the MCP
// server is killed mid-build the live tail stops but the result is not lost
// (a returning session reads the record via the onboarding checkBuild path).
// A future Durable-Object relay / encrypted store can slot behind the same tools
// without changing them.
//
// ALL timing + IO is injected (BuildJobDeps) so the bounded wait loop is
// deterministically testable without real clocks, files, or subprocesses.

import type { BuildOutputRecord } from '../../output-record.js'
import type { Platform } from './contract.js'

export type BuildJobStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'

export interface BuildJobResult {
  jobId: string
  status: BuildJobStatus
  platform: Platform
  appId: string
  /** Absolute path to the local log file the user can tail. NEVER read by the agent directly. */
  logsPath: string
  outputUrl?: string
  qrCodeAscii?: string
  error?: string
  /** True when start found an in-flight build for this target and returned it instead of starting a second. */
  alreadyRunning?: boolean
}

/** A handle to the spawned build process (injectable so tests never spawn anything). */
export interface BuildChild {
  pid: number
  kill: (signal?: NodeJS.Signals) => void
  /** Resolves with the exit code (or null on signal) when the process exits. */
  exited: Promise<number | null>
}

export interface BuildJobDeps {
  /** Spawn the build command, streaming stdout+stderr to `logPath`. Returns a handle. */
  spawnBuild: (args: {
    appId: string
    platform: Platform
    recordPath: string
    logPath: string
    /** Called when the child fails to start or exits before writing a build record. */
    onProcessFailure?: (message: string) => void
  }) => BuildChild
  buildRecordPath: (appId: string, platform: Platform) => string
  /** Read the build record; resolves null when absent, THROWS on a present-but-corrupt record. */
  readBuildRecord: (path: string) => Promise<BuildOutputRecord | null>
  /** Remove a stale record before a fresh build so wait can't read last run's result as this one's. */
  clearBuildRecord?: (path: string) => Promise<void>
  /** Absolute path of the local log file for a target. */
  logPath: (appId: string, platform: Platform) => string
  /** Read `logPath` from byte offset `cursor`; returns new text, the next cursor, and whether at EOF. */
  readLogSlice: (logPath: string, cursor: number) => Promise<{ text: string, nextCursor: number, eof: boolean }>
  /** Best-effort cloud cancel by the cloud jobId (POST /build/cancel/:jobId). Optional. */
  cancelCloud?: (cloudJobId: string) => Promise<void>
  /** Injected so the bounded wait loop is deterministic in tests. */
  sleep: (ms: number) => Promise<void>
  now: () => number
}

interface JobEntry {
  jobId: string
  appId: string
  platform: Platform
  recordPath: string
  logsPath: string
  child: BuildChild
  startedAt: number
  /** undefined while the child is running; null/number once it has exited. */
  exitCode: number | null | undefined
  cloudJobId?: string
  cancelled: boolean
  /** Set when the local build child fails to start or dies before Capgo writes a record. */
  processFailure?: string
}

/** Bounded wait window (seconds), kept under the ~60s client tool-call timeout. */
export const DEFAULT_WAIT_SECONDS = 40
export const MAX_WAIT_SECONDS = 59
const POLL_INTERVAL_MS = 1000

const registry = new Map<string, JobEntry>()

/** Drop every tracked build job (test isolation only). */
export function clearAllBuildJobs(): void {
  registry.clear()
}

/**
 * The job id is deterministic per (appId, platform) — one live build per target —
 * which makes `start` naturally idempotent and lets `wait`/`logs` recover the
 * appId/platform from the id alone (e.g. for a graceful "unknown job" message
 * after a server restart). appIds are reverse-domain (no colons), so the first
 * colon is an unambiguous separator.
 */
function makeJobId(appId: string, platform: Platform): string {
  return `${platform}:${appId}`
}

function parseJobId(jobId: string): { platform: Platform, appId: string } {
  const idx = jobId.indexOf(':')
  const head = idx === -1 ? '' : jobId.slice(0, idx)
  const platform: Platform = head === 'ios' ? 'ios' : 'android'
  return { platform, appId: idx === -1 ? jobId : jobId.slice(idx + 1) }
}

/**
 * Start (or re-attach to) the cloud build for a target. Idempotent: if a build
 * for this (appId, platform) is already running this session, returns that job
 * instead of spawning a second.
 */
export async function startBuild(deps: BuildJobDeps, args: { appId: string, platform: Platform }): Promise<BuildJobResult> {
  const { appId, platform } = args
  const jobId = makeJobId(appId, platform)

  const existing = registry.get(jobId)
  if (existing && existing.exitCode === undefined && !existing.cancelled) {
    return { jobId, status: 'running', platform, appId, logsPath: existing.logsPath, alreadyRunning: true }
  }

  const recordPath = deps.buildRecordPath(appId, platform)
  const logsPath = deps.logPath(appId, platform)

  // Clear any record left by an earlier build BEFORE spawning, so a fresh wait
  // can never read the previous run's result as this build's.
  if (deps.clearBuildRecord) {
    try {
      await deps.clearBuildRecord(recordPath)
    }
    catch {
      // Best-effort — a leftover record is re-validated by status derivation
      // (stale-record correlation lives in the onboarding checkBuild path).
    }
  }

  const entry: JobEntry = {
    jobId,
    appId,
    platform,
    recordPath,
    logsPath,
    child: { pid: -1, kill: () => {}, exited: Promise.resolve(null) },
    startedAt: deps.now(),
    exitCode: undefined,
    cancelled: false,
  }
  const child = deps.spawnBuild({
    appId,
    platform,
    recordPath,
    logPath: logsPath,
    onProcessFailure: (message) => { entry.processFailure = message },
  })
  entry.child = child
  registry.set(jobId, entry)
  // Track exit without blocking; status derivation uses this to catch a build
  // process that died without writing a terminal record.
  void child.exited.then(
    (code) => { entry.exitCode = code },
    () => { entry.exitCode = null },
  )

  return { jobId, status: 'running', platform, appId, logsPath }
}

/** Derive the current status from the record + child liveness. Read-only. */
async function deriveStatus(deps: BuildJobDeps, entry: JobEntry): Promise<BuildJobResult> {
  const base = { jobId: entry.jobId, platform: entry.platform, appId: entry.appId, logsPath: entry.logsPath }

  if (entry.cancelled)
    return { ...base, status: 'cancelled' }

  let rec: BuildOutputRecord | null = null
  let recError: string | undefined
  try {
    rec = await deps.readBuildRecord(entry.recordPath)
  }
  catch (err) {
    // A present-but-corrupt record is a real failure, not "still waiting".
    recError = err instanceof Error ? err.message : String(err)
  }

  if (rec) {
    if (rec.jobId)
      entry.cloudJobId = rec.jobId
    const done = rec.status === 'success' || Boolean(rec.outputUrl)
    if (done)
      return { ...base, status: 'completed', outputUrl: rec.outputUrl ?? undefined, qrCodeAscii: rec.qrCodeAscii ?? undefined }
    return { ...base, status: 'failed', error: `The build did not succeed (status: ${rec.status}).` }
  }

  if (recError)
    return { ...base, status: 'failed', error: `The build result could not be read: ${recError}` }

  // No record yet. Still running?
  if (entry.exitCode === undefined)
    return { ...base, status: 'running' }

  // The build process exited but wrote no terminal record — the "failed without
  // a record" gap. Report failed rather than polling 'running' forever.
  if (entry.processFailure)
    return { ...base, status: 'failed', error: entry.processFailure }
  return { ...base, status: 'failed', error: `The build process exited (code ${entry.exitCode ?? 'unknown'}) without writing a result.` }
}

/**
 * Bounded wait: block up to `timeoutSeconds` (default 40, max 59 — kept under the
 * client tool-call timeout), returning the instant the build reaches a terminal
 * state, otherwise 'running' for the caller to re-call.
 */
export async function waitBuild(deps: BuildJobDeps, args: { jobId: string, timeoutSeconds?: number }): Promise<BuildJobResult> {
  const entry = registry.get(args.jobId)
  if (!entry) {
    const { platform, appId } = parseJobId(args.jobId)
    return { jobId: args.jobId, status: 'unknown', platform, appId, logsPath: '' }
  }

  const seconds = Math.max(1, Math.min(MAX_WAIT_SECONDS, Math.floor(args.timeoutSeconds ?? DEFAULT_WAIT_SECONDS)))
  const deadline = deps.now() + seconds * 1000

  for (;;) {
    const status = await deriveStatus(deps, entry)
    if (status.status !== 'running')
      return status
    if (deps.now() >= deadline)
      return status // still building — time's up, caller re-calls
    await deps.sleep(POLL_INTERVAL_MS)
  }
}

/** Non-blocking status peek. */
export async function statusBuild(deps: BuildJobDeps, args: { jobId: string }): Promise<BuildJobResult> {
  const entry = registry.get(args.jobId)
  if (!entry) {
    const { platform, appId } = parseJobId(args.jobId)
    return { jobId: args.jobId, status: 'unknown', platform, appId, logsPath: '' }
  }
  return deriveStatus(deps, entry)
}

/**
 * Drain new log output since `cursor`. `eof` is true only once the build is
 * terminal AND the read reached the end of the file, so a streamer knows to stop.
 */
export async function buildLogs(
  deps: BuildJobDeps,
  args: { jobId: string, cursor?: number },
): Promise<{ jobId: string, text: string, nextCursor: number, eof: boolean }> {
  const entry = registry.get(args.jobId)
  const parsed = parseJobId(args.jobId)
  const logsPath = entry?.logsPath ?? deps.logPath(parsed.appId, parsed.platform)
  const cursor = Math.max(0, Math.floor(args.cursor ?? 0))
  const slice = await deps.readLogSlice(logsPath, cursor)

  let terminal = false
  let failureText: string | undefined
  if (entry) {
    const s = await deriveStatus(deps, entry)
    terminal = s.status !== 'running'
    if (terminal && slice.text.length === 0 && s.error)
      failureText = s.error
  }
  const text = failureText ?? slice.text
  return { jobId: args.jobId, text, nextCursor: slice.nextCursor, eof: terminal && slice.eof }
}

/** Cancel a running build: kill the local child + best-effort cloud cancel. */
export async function cancelBuild(deps: BuildJobDeps, args: { jobId: string }): Promise<BuildJobResult> {
  const entry = registry.get(args.jobId)
  if (!entry) {
    const { platform, appId } = parseJobId(args.jobId)
    return { jobId: args.jobId, status: 'unknown', platform, appId, logsPath: '' }
  }
  entry.cancelled = true
  try {
    entry.child.kill('SIGTERM')
  }
  catch {
    // Already exited — nothing to kill.
  }
  if (entry.cloudJobId && deps.cancelCloud) {
    try {
      await deps.cancelCloud(entry.cloudJobId)
    }
    catch {
      // Best-effort: the cloud build may still finish; the user can cancel in the dashboard.
    }
  }
  return { jobId: entry.jobId, status: 'cancelled', platform: entry.platform, appId: entry.appId, logsPath: entry.logsPath }
}
