// src/build/onboarding/mcp/build-tools.ts
//
// The MCP build tools — start_capgo_build / capgo_build_wait / capgo_build_logs /
// cancel_capgo_build — registered alongside the onboarding spine. They wrap the
// process-local build-job manager (build-job.ts) and render its results into the
// onboarding NextStepResult contract (so the agent gets the same `next`-chain +
// rules guidance it gets everywhere else).
//
// Execution model (v1): the build is a CLOUD build. start spawns the published
// CLI's `build request … --output-record` as a tracked BACKGROUND CHILD of the
// MCP server (NOT a Terminal.app/AppleScript launch — that's gone), streaming its
// stdout/stderr straight to a local log file the user can tail. The cloud build
// runs server-side regardless; status is read from the per-(appId, platform)
// build record, and a COMPLETED build hands back to the onboarding
// `checkBuild` step which reads the record and enters the post-build tail.

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { dirname } from 'node:path'
import type { McpRegistrar } from '../../../mcp/registrar.js'
import { cancelCapgoBuildInputSchema, capgoBuildLogsInputSchema, capgoBuildWaitInputSchema, startCapgoBuildInputSchema } from './build-tool-schemas.js'
import { getLogCapturePath } from '../../../ai/log-capture.js'
import { defaultBuildRecordPath, readBuildOutputRecord, removeBuildOutputRecord } from '../../output-record.js'
import type { BuildChild, BuildJobDeps, BuildJobResult } from './build-job.js'
import { buildLogs, cancelBuild, startBuild, waitBuild } from './build-job.js'
import type { NextStepResult, Platform } from './contract.js'
import { ONBOARDING_RULES, renderResult } from './contract.js'



/** Per-(appId, platform) local log file path, kept filesystem-safe. */
function buildLogPath(appId: string, platform: Platform): string {
  const safe = `${platform}-${appId}`.replace(/[^a-z0-9._-]/gi, '_')
  return getLogCapturePath(`capgo-build-${safe}`)
}

/**
 * Production build-job deps: spawn the published CLI's `build request` as a
 * tracked background child streaming to a local log file, read/clear the build
 * record, and drain the log file by byte offset. No cloud cancel in v1 (cancel
 * stops the local watcher; the cloud build may still finish — surfaced in the
 * result). All injectable for tests (test-mcp-build-job covers the manager).
 */
export function buildJobDeps(cwd: string): BuildJobDeps {
  return {
    spawnBuild: ({ appId, platform, recordPath, logPath }): BuildChild => {
      mkdirSync(dirname(logPath), { recursive: true })
      const fd = openSync(logPath, 'w')
      const args = ['-y', '@capgo/cli@latest', 'build', 'request', appId, '--platform', platform, '--output-upload', '--output-record', recordPath]
      const child = spawn('npx', args, { cwd, stdio: ['ignore', fd, fd], detached: false })
      try {
        closeSync(fd)
      }
      catch {
        // the child inherited its own dup of the fd; the parent copy is closable
      }
      const exited = new Promise<number | null>((resolve) => {
        child.once('exit', code => resolve(code))
        child.once('error', () => resolve(null))
      })
      return {
        pid: child.pid ?? -1,
        kill: (signal) => {
          try {
            child.kill(signal)
          }
          catch {
            // already exited
          }
        },
        exited,
      }
    },
    buildRecordPath: defaultBuildRecordPath,
    readBuildRecord: readBuildOutputRecord,
    clearBuildRecord: removeBuildOutputRecord,
    logPath: buildLogPath,
    readLogSlice: async (logPath, cursor) => {
      try {
        const st = await stat(logPath)
        if (cursor >= st.size)
          return { text: '', nextCursor: st.size, eof: true }
        // Bound the read: capgo_build_logs only keeps the last MAX_LOG_CHARS, so a
        // cursor:0 request on a huge native build log must NOT allocate the whole
        // file — read at most the last 64 KiB (well above the 8k display cap).
        const start = Math.max(cursor, st.size - 64 * 1024)
        const len = st.size - start
        const fh = await open(logPath, 'r')
        try {
          const buf = Buffer.alloc(len)
          await fh.read(buf, 0, len, start)
          return { text: buf.toString('utf8'), nextCursor: st.size, eof: true }
        }
        finally {
          await fh.close()
        }
      }
      catch {
        // log file not created yet (or unreadable) — no new bytes.
        return { text: '', nextCursor: cursor, eof: false }
      }
    },
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}

const NEXT_STEP_TOOL = 'capgo_builder_onboarding_next_step'

function text(result: NextStepResult): { content: Array<{ type: 'text', text: string }> } {
  return { content: [{ type: 'text' as const, text: renderResult(result) }] }
}

/** start_capgo_build → "build launched", point the agent at capgo_build_wait. */
function renderStarted(r: BuildJobResult): NextStepResult {
  return {
    onboarding: 'capgo-builder',
    phase: 'build',
    state: 'build-launched',
    platform: r.platform,
    progress: 92,
    kind: 'human_gate',
    summary: r.alreadyRunning
      ? `A cloud build for "${r.appId}" (${r.platform}) is already running — I'll keep watching it.`
      : `Your first cloud build for "${r.appId}" (${r.platform}) is running in the cloud. It takes a few minutes and won't block me.`,
    context: { jobId: r.jobId },
    human: { instruction: `You can watch the live build logs here:\n${r.logsPath}` },
    next: {
      tool: 'capgo_build_wait',
      with: { job_id: r.jobId, timeout_seconds: 40 },
      instruction: 'Tell the user the build started and where to watch logs, then call capgo_build_wait to wait for it.',
      call: `capgo_build_wait({ job_id: "${r.jobId}", timeout_seconds: 40 })`,
    },
    rules: ONBOARDING_RULES,
  }
}

/** capgo_build_wait → route by terminal status. */
function renderWait(r: BuildJobResult): NextStepResult {
  const base = { onboarding: 'capgo-builder' as const, phase: 'build' as const, platform: r.platform, context: { jobId: r.jobId }, rules: ONBOARDING_RULES }
  if (r.status === 'completed') {
    return {
      ...base,
      state: 'build-complete',
      progress: 100,
      kind: 'human_gate',
      summary: `Your cloud build for "${r.appId}" (${r.platform}) succeeded${r.outputUrl ? `: ${r.outputUrl}` : ''}.`,
      next: {
        tool: NEXT_STEP_TOOL,
        with: { checkBuild: true, platform: r.platform },
        instruction: 'Tell the user the build succeeded and share the download URL / QR. Then call capgo_builder_onboarding_next_step to record it and continue setup.',
        call: `${NEXT_STEP_TOOL}({ checkBuild: true, platform: "${r.platform}" })`,
      },
    }
  }
  if (r.status === 'failed') {
    return {
      ...base,
      state: 'build-failed',
      progress: 92,
      kind: 'error',
      summary: `The cloud build for "${r.appId}" (${r.platform}) did not succeed. ${r.error ?? ''} This build is a REQUIRED gate: onboarding CANNOT be finished, skipped, restarted, or "continued past" until a build succeeds.`.trim(),
      next: {
        tool: 'capgo_build_logs',
        with: { job_id: r.jobId, cursor: 0 },
        instruction: `Call capgo_build_logs({ job_id: "${r.jobId}" }) to read why it failed and summarize the cause for the user. Then STOP and ask the user how they want to proceed. Do NOT call start_capgo_builder_onboarding or capgo_builder_onboarding_next_step — neither can skip, retry, restart, or move past a failed build, and calling them does not help. Do NOT edit files or rebuild on your own. The ONLY way to retry is to call start_capgo_build again, and only AFTER the user has addressed the cause and explicitly asked to rebuild.`,
        call: `capgo_build_logs({ job_id: "${r.jobId}", cursor: 0 })`,
      },
    }
  }
  if (r.status === 'cancelled') {
    return { ...base, state: 'build-skipped', progress: 100, kind: 'done', summary: `The build for "${r.appId}" (${r.platform}) was cancelled.` }
  }
  if (r.status === 'unknown') {
    return {
      ...base,
      state: 'build-waiting',
      progress: 95,
      kind: 'human_gate',
      summary: `I lost the live handle for that build (the session may have restarted). The cloud build may still be running.`,
      next: {
        tool: NEXT_STEP_TOOL,
        with: { checkBuild: true, platform: r.platform },
        instruction: 'Call capgo_builder_onboarding_next_step with checkBuild to read the saved build result.',
        call: `${NEXT_STEP_TOOL}({ checkBuild: true, platform: "${r.platform}" })`,
      },
    }
  }
  // still running
  return {
    ...base,
    state: 'build-waiting',
    progress: 95,
    kind: 'human_gate',
    summary: `Still building "${r.appId}" (${r.platform})…`,
    next: {
      tool: 'capgo_build_wait',
      with: { job_id: r.jobId, timeout_seconds: 40 },
      instruction: 'The build is still running. Call capgo_build_wait again to keep waiting — do not stop here.',
      call: `capgo_build_wait({ job_id: "${r.jobId}", timeout_seconds: 40 })`,
    },
  }
}

function renderCancel(r: BuildJobResult): NextStepResult {
  return {
    onboarding: 'capgo-builder',
    phase: 'build',
    state: 'build-skipped',
    platform: r.platform,
    progress: 100,
    kind: 'done',
    summary: r.status === 'unknown'
      ? `I have no live handle for that build to cancel. If a build is still running, it will finish in the cloud.`
      : `Stopped watching the build for "${r.appId}" (${r.platform}). If it had already started in the cloud, it may still finish there.`,
    rules: ONBOARDING_RULES,
  }
}

/** Cap log output returned to the model so a huge log can't blow up the transcript. */
const MAX_LOG_CHARS = 8000

/**
 * Register the build tools onto an MCP server. `getAppId` resolves the current
 * project's Capgo app id; `deps` are the build-job mechanics (production via
 * buildJobDeps; injectable fakes in tests).
 */
export function registerBuildTools(
  server: McpRegistrar,
  getAppId: () => Promise<string | undefined>,
  deps: BuildJobDeps,
): void {
  server.registerTool(
    'start_capgo_build',
    {
      description: 'Start the first cloud build for this app on the given platform. The build runs in Capgo\'s cloud and takes a few minutes; this returns immediately with a job_id you use to track it. Idempotent — if a build for this app and platform is already running, it returns that same job_id instead of starting another.',
      inputSchema: startCapgoBuildInputSchema,
    },
    async (args: { platform: Platform }) => {
      const appId = await getAppId()
      if (!appId) {
        return { content: [{ type: 'text' as const, text: 'Cannot start a build: no Capgo app id found for this project. Run the onboarding from your app directory.' }] }
      }
      const r = await startBuild(deps, { appId, platform: args.platform })
      return text(renderStarted(r))
    },
  )

  server.registerTool(
    'capgo_build_wait',
    {
      description: 'Wait for a running cloud build to finish. Blocks for up to timeout_seconds and returns the moment the build completes, fails, or is cancelled; if it\'s still building when the time is up, it returns status "running" — call this again to keep waiting. This is the main way to make progress on a build.',
      inputSchema: capgoBuildWaitInputSchema,
    },
    async (args: { job_id: string, timeout_seconds?: number }) => {
      const r = await waitBuild(deps, { jobId: args.job_id, timeoutSeconds: args.timeout_seconds })
      return text(renderWait(r))
    },
  )

  server.registerTool(
    'capgo_build_logs',
    {
      description: 'Fetch new build log output since cursor, to summarize progress or explain a failure. Returns the new text, the next cursor, and whether the log is complete. The user can already watch the full live logs locally — use this only when you need to read the logs yourself. Logs may contain sensitive build output: summarize, don\'t paste them verbatim.',
      inputSchema: capgoBuildLogsInputSchema,
    },
    async (args: { job_id: string, cursor?: number }) => {
      const r = await buildLogs(deps, { jobId: args.job_id, cursor: args.cursor })
      const clipped = r.text.length > MAX_LOG_CHARS ? `…(${r.text.length - MAX_LOG_CHARS} earlier chars omitted)…\n${r.text.slice(-MAX_LOG_CHARS)}` : r.text
      const body = clipped.trim().length > 0 ? clipped : '(no new log output)'
      const footer = `\n\n---\n[build logs] next_cursor: ${r.nextCursor}${r.eof ? ' · complete' : ' · more may follow'}\nSummarize these for the user — do not paste them verbatim (they may contain sensitive build output).`
      return { content: [{ type: 'text' as const, text: body + footer }] }
    },
  )

  server.registerTool(
    'cancel_capgo_build',
    {
      description: 'Cancel a running cloud build. Stops watching the build locally and returns. Only use this if the user explicitly asks to stop the build.',
      inputSchema: cancelCapgoBuildInputSchema,
    },
    async (args: { job_id: string }) => {
      const r = await cancelBuild(deps, { jobId: args.job_id })
      return text(renderCancel(r))
    },
  )
}
