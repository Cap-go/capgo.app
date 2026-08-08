import { readFile, stat, writeFile } from 'node:fs/promises'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { cleanupCapturedJobFiles, getAiPromptPath, getLogCapturePath } from './log-capture'
import { SYSTEM_PROMPT } from './prompt'
import { createSseParser } from './sse'

export type AnalyzeBehavior = 'ask_then_menu' | 'auto_upload' | 'skip'

export interface DecideInput {
  isTTY: boolean
  aiAnalyticsFlag: boolean
  sendLogsFlag: boolean
}

export function decideAnalyzeBehavior(input: DecideInput): AnalyzeBehavior {
  // Explicit opt-in via --ai-analytics or --send-logs means the user has
  // already chosen - run the action(s) directly, never prompt (any terminal).
  if (input.aiAnalyticsFlag || input.sendLogsFlag)
    return 'auto_upload'
  // No flags + interactive terminal: ask, then show the help menu.
  if (input.isTTY)
    return 'ask_then_menu'
  // No flags + non-interactive (CI/CD): stay silent (+ existing CI tip).
  return 'skip'
}

// Tip printed to stderr when a build fails non-interactively and the user opted
// into NEITHER AI analysis nor log upload — so CI users discover both options
// instead of getting a silent failure.
export const CI_FAILURE_TIP = 'Build failed. Tip: re-run with --ai-analytics for an AI-powered diagnosis, or --send-logs-to-support to upload the build logs to Capgo support.'

export interface CiFailureActionsInput {
  // --ai-analytics passed?
  aiAnalyticsFlag: boolean
  // --send-logs passed?
  sendLogsFlag: boolean
}

export interface CiFailureActions {
  // Run the existing Capgo AI auto-upload analysis path.
  runAiAnalysis: boolean
  // Upload the captured build logs to Capgo support via uploadSupportLogs.
  sendLogs: boolean
  // Neither flag set — print CI_FAILURE_TIP so the user learns both options exist.
  tip: string | null
}

// Pure decision for the direct-action build-failure path (CI/CD, or any terminal
// when --ai-analytics/--send-logs is passed). Both flags are independent and
// additive: --ai-analytics and --send-logs can both be passed and both run.
// When neither is passed we surface a one-line tip instead of failing silently.
// No-flag interactive terminals never reach this; they use the
// decideAnalyzeBehavior ask_then_menu flow instead.
export function decideCiFailureActions(input: CiFailureActionsInput): CiFailureActions {
  return {
    runAiAnalysis: input.aiAnalyticsFlag,
    sendLogs: input.sendLogsFlag,
    tip: (!input.aiAnalyticsFlag && !input.sendLogsFlag) ? CI_FAILURE_TIP : null,
  }
}

export interface ShouldPrintCiTipInput {
  // Is the current stdout an interactive terminal?
  isTTY: boolean
  // --ai-analytics passed?
  aiAnalytics: boolean
  // --send-logs passed?
  sendLogs: boolean
}

// Whether to print CI_FAILURE_TIP at the build-failure point. This is the ONLY
// case where the tip should appear: a non-interactive (CI/CD) build that failed
// while the user opted into NEITHER --ai-analytics NOR --send-logs. Interactive
// terminals use the clack menu instead; if either flag is set the corresponding
// action runs and no tip is wanted. Pure + unit-tested so the emit site stays
// trivial and self-documenting.
export function shouldPrintCiTip(input: ShouldPrintCiTipInput): boolean {
  return !input.isTTY && !input.aiAnalytics && !input.sendLogs
}

export async function writeLocalAiFile(jobId: string): Promise<string> {
  const logsPath = getLogCapturePath(jobId)
  const logs = await readFile(logsPath, 'utf8')
  const promptPath = getAiPromptPath(jobId)
  // Wrap the log in the same <BUILD_LOG>...</BUILD_LOG> boundary the worker
  // uses, so SYSTEM_PROMPT's anti-prompt-injection instructions apply when
  // a user runs this file against any LLM.
  const content = `${SYSTEM_PROMPT}\n\n<BUILD_LOG>\n${logs}\n</BUILD_LOG>\n`
  await writeFile(promptPath, content)
  return promptPath
}

export interface PostAnalyzeInput {
  apiHost: string
  apikey: string
  jobId: string
  appId: string
  logs: string
}

// Watchdog values deliberately LARGER than the edge fn's (90s/30s) so the
// server layer always times out first and can send an in-band error event.
export const STREAM_FIRST_BYTE_TIMEOUT_MS = 120_000
export const STREAM_IDLE_TIMEOUT_MS = 45_000
export const STREAM_TOTAL_TIMEOUT_MS = 600_000

export type PostAnalyzeResult
  = | { kind: 'ok', analysis: string }
    | { kind: 'already_analyzed' }
    | { kind: 'too_big' }
    | { kind: 'upgrade_required', message?: string }
    | { kind: 'error', status?: number, message?: string, partial?: string }

export interface PostAnalyzeStreamInput extends PostAnalyzeInput {
  // Fired once per text delta as it arrives — used for progressive TTY rendering.
  onChunk?: (text: string) => void
}

export async function postAnalyzeStreamRequest(input: PostAnalyzeStreamInput): Promise<PostAnalyzeResult> {
  const url = `${input.apiHost}/build/ai_analyze_stream`
  const controller = new AbortController()
  let idleTimer = setTimeout(() => controller.abort(), STREAM_FIRST_BYTE_TIMEOUT_MS)
  const totalTimer = setTimeout(() => controller.abort(), STREAM_TOTAL_TIMEOUT_MS)
  let partial = ''
  try {
    const res = await fetch(url, {
      method: 'POST',
headers: buildCliRequestHeaders({ capgkey: input.apikey, 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify({ jobId: input.jobId, appId: input.appId, logs: input.logs }),
      signal: controller.signal,
    })
    if (res.status === 409)
      return { kind: 'already_analyzed' }
    if (res.status === 413)
      return { kind: 'too_big' }
    if (res.status === 426) {
      const body = await res.json().catch(() => ({})) as { error?: string, message?: string }
      return { kind: 'upgrade_required', message: body.error || body.message }
    }
    if (res.status !== 200) {
      let message: string | undefined
      try {
        const body = await res.json() as { error?: string, message?: string }
        message = body.error || body.message
      }
      catch {
        // ignore
      }
      return { kind: 'error', status: res.status, message }
    }
    if (!res.body)
      return { kind: 'error', status: 200, message: 'no_body' }

    let terminal: PostAnalyzeResult | undefined
    const feed = createSseParser((e) => {
      if (e.event === 'chunk') {
        try {
          const text = (JSON.parse(e.data) as { text?: string }).text
          if (typeof text === 'string') {
            partial += text
            input.onChunk?.(text)
          }
        }
        catch {
          // malformed chunk frame — skip
        }
      }
      else if (e.event === 'done') {
        terminal = { kind: 'ok', analysis: partial }
      }
      else if (e.event === 'error') {
        let code = 'ai_error'
        try {
          code = (JSON.parse(e.data) as { code?: string }).code ?? code
        }
        catch {
          // keep default
        }
        terminal = { kind: 'error', message: code, partial }
      }
    })

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          // Flush the decoder tail — a multibyte character split across the
          // final network chunks would otherwise be silently dropped.
          feed(decoder.decode())
          break
        }
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS)
        feed(decoder.decode(value, { stream: true }))
        if (terminal) {
          // A terminal frame (done/error) decides the outcome — stop reading
          // so a server that keeps the connection open afterwards can't
          // idle-abort and overwrite a valid result.
          await reader.cancel().catch(() => { /* best-effort */ })
          break
        }
      }
    }
    catch (err) {
      // Late transport failures must not overwrite an already-decided outcome.
      if (!terminal)
        throw err
    }
    return terminal ?? { kind: 'error', message: 'stream_ended_without_done', partial }
  }
  catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err), partial: partial || undefined }
  }
  finally {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
  }
}

export const HARD_LOG_SIZE_LIMIT = 10 * 1024 * 1024

export async function isLogTooBig(jobId: string): Promise<boolean> {
  try {
    const s = await stat(getLogCapturePath(jobId))
    return s.size > HARD_LOG_SIZE_LIMIT
  }
  catch {
    return false
  }
}

export interface RunCapgoAiAnalysisInput {
  apiHost: string
  apikey: string
  jobId: string
  appId: string
  // Fired per streamed text delta — used by the onboarding TUI for a live
  // preview while the analysis generates. Omit for buffered behavior.
  onChunk?: (text: string) => void
}

// Reads the captured log file for a failed job, then sends it to the Capgo AI
// edge function. Used by callers (e.g. the Ink onboarding TUI) that can't show
// the interactive clack menu in `requestBuildInternal`.
export async function runCapgoAiAnalysis(input: RunCapgoAiAnalysisInput): Promise<PostAnalyzeResult> {
  // Check the byte limit before the read so a multi-MB log file doesn't get
  // pulled into memory just to be rejected.
  if (await isLogTooBig(input.jobId))
    return { kind: 'too_big' }

  let logs: string
  try {
    logs = await readFile(getLogCapturePath(input.jobId), 'utf8')
  }
  catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'log_unavailable' }
  }

  return postAnalyzeStreamRequest({
    apiHost: input.apiHost,
    apikey: input.apikey,
    jobId: input.jobId,
    appId: input.appId,
    logs,
    onChunk: input.onChunk,
  })
}

// Best-effort cleanup of captured artifacts for a job. Callers in caller-handled
// mode use this once the user has either viewed the analysis or chosen to skip,
// since `requestBuildInternal` leaves the log file in place for them.
export async function releaseCapturedLogs(jobId: string): Promise<void> {
  await cleanupCapturedJobFiles(jobId, { keepAiPromptFile: false })
}
