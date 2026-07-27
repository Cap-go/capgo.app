/**
 * Native Build Request Module
 *
 * This module handles native iOS and Android build requests through Capgo's cloud build service.
 *
 * CREDENTIAL SECURITY GUARANTEE:
 * ═══════════════════════════════════════════════════════════════════════════
 * Your build credentials (certificates, keystores, passwords, API keys) are:
 *
 * ✓ NEVER stored permanently on Capgo servers
 * ✓ Used ONLY during the active build process
 * ✓ Automatically deleted from Capgo servers after build completion
 * ✓ Retained for a MAXIMUM of 24 hours (even if build fails)
 * ✓ Builds sent DIRECTLY to app stores (Apple/Google)
 * ✓ Build outputs may optionally be uploaded for time-limited download links
 *
 * Credentials are transmitted securely over HTTPS and used only in ephemeral
 * build environments that are destroyed after each build completes.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BEFORE BUILDING:
 * You must save your credentials first using:
 * - `npx @capgo/cli build credentials save --platform ios` (for iOS)
 * - `npx @capgo/cli build credentials save --platform android` (for Android)
 * - Credentials stored in ~/.capgo/credentials.json (local machine only)
 * - Use `build credentials clear` to remove saved credentials
 */

import type { PostAnalyzeResult } from '../ai/analyze'
import type { BuildCredentials, BuildOptionsPayload, BuildRequestOptions, BuildRequestResult } from '../schemas/build'
import { Buffer } from 'node:buffer'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile as readFileAsync, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process, { cwd, exit } from 'node:process'
import { isCancel as clackIsCancel, log as clackLog, select as clackSelect, confirm, select, spinner as spinnerC } from '@clack/prompts'
import AdmZip from 'adm-zip'
import { WebSocket as PartySocket } from 'partysocket'
import * as tus from 'tus-js-client'
import WS from 'ws' // TODO: remove when min version nodejs 22 is bump, should do it in july 2026 as it become deprecated
import pack from '../../package.json'
import {
  CI_FAILURE_TIP,
  decideAnalyzeBehavior,
  decideCiFailureActions,
  isLogTooBig,
  postAnalyzeStreamRequest,
  shouldPrintCiTip,
  writeLocalAiFile,
} from '../ai/analyze'
import {
  appendCapturedLine,
  registerCleanupHandlers,
  shouldCaptureLogs,
  startCaptureForJob,
} from '../ai/log-capture'
import { renderMarkdown } from '../ai/render-markdown'
import { createStreamingMarkdownRenderer } from '../ai/stream-markdown'
import { aiAnalysisResultFromPostAnalyze, trackAiAnalysisChoice, trackAiAnalysisResult } from '../ai/telemetry'
import { type SupportBundleFiles, writeSupportBundleFiles } from '../onboarding-support.js'
import { copyToClipboard, revealInFinder } from '../support/clipboard.js'
import { contactSupport } from '../support/contact-support.js'
import { appendInternalLog, getInternalLogPath, startInternalLog } from '../support/internal-log.js'
import { uploadSupportLogs } from '../support/support-upload.js'
import { offerSupportUploadBeforeAi } from '../support/support-upload-prompt.js'
import { assertCliPermission, canPromptInteractively, createSupabaseClient, findSavedKey, getConfig, getOrganizationId, getRemoteConfig, sendEvent, TUS_UPLOAD_RETRY_DELAYS } from '../utils'
import { mergeCredentials, MIN_OUTPUT_RETENTION_SECONDS, parseInAppUpdatePriority, parseOptionalBoolean, parseOutputRetentionSeconds } from './credentials'
import { buildProvisioningMap } from './credentials-command'
import { withCwd } from './cwd'
import { syncIosMarketingVersion } from './ios-marketing-version'
import { writeBuildOutputRecord } from './output-record'
import { getPlatformDirFromCapacitorConfig, normalizeNativeDependencyPathsInText } from './platform-paths'
import { handleCustomMsg } from './qr.js'
import { trackBuilderUpload } from './telemetry.js'

/**
 * Callback interface for build logging.
 * Allows callers (like the onboarding UI) to capture log output
 * without stdout/stderr interception hacks.
 */
export interface BuildLogger {
  info: (msg: string) => void
  error: (msg: string) => void
  warn: (msg: string) => void
  success: (msg: string) => void
  /** Called with build log lines streamed from the builder */
  buildLog: (msg: string) => void
  /** Called with upload progress percentage (0-100) */
  uploadProgress: (percent: number) => void
  /** Called with custom messages from the builder (QR codes, etc.) */
  customMsg: (kind: string, data: Record<string, unknown>) => void | Promise<void>
}

type BuildPlatform = 'ios' | 'android'

interface ResolveBuildPlatformOptions {
  silent?: boolean
  interactive?: boolean
  promptPlatform?: () => Promise<unknown>
}

async function promptBuildPlatform(): Promise<unknown> {
  return clackSelect({
    message: 'No platform selected. Which platform do you want to build?',
    options: [
      { value: 'ios', label: 'iOS' },
      { value: 'android', label: 'Android' },
    ],
  })
}

export async function resolveBuildPlatform(
  platform: string | undefined,
  {
    silent = false,
    interactive = canPromptInteractively({ silent }),
    promptPlatform = promptBuildPlatform,
  }: ResolveBuildPlatformOptions = {},
): Promise<BuildPlatform> {
  if (platform === 'ios' || platform === 'android')
    return platform

  if (platform)
    throw new Error(`Invalid platform "${platform}". Must be "ios" or "android"`)

  if (!interactive) {
    throw new Error('Missing required argument: --platform <ios|android>. In an interactive terminal, you can omit --platform and choose one when prompted.')
  }

  const selectedPlatform = await promptPlatform()
  if (clackIsCancel(selectedPlatform))
    throw new Error('Build request canceled.')

  if (selectedPlatform !== 'ios' && selectedPlatform !== 'android')
    throw new Error('Build request canceled.')

  return selectedPlatform
}

/** Default logger that uses @clack/prompts (used by CLI command) */
function createDefaultLogger(silent: boolean): BuildLogger {
  return {
    info: (msg: string) => {
      if (!silent) {
        clackLog.info(msg)
      }
    },
    error: (msg: string) => {
      if (!silent) {
        clackLog.error(msg)
      }
    },
    warn: (msg: string) => {
      if (!silent) {
        clackLog.warn(msg)
      }
    },
    success: (msg: string) => {
      if (!silent) {
        clackLog.success(msg)
      }
    },
    buildLog: (msg: string) => {
      if (!silent) {
        // eslint-disable-next-line no-console
        console.log(msg)
      }
    },
    uploadProgress: (() => {
      const s = silent ? null : spinnerC()
      let started = false
      return (percent: number) => {
        if (silent || !s) {
          return
        }
        if (!started) {
          s.start('Uploading bundle')
          started = true
        }
        if (percent >= 100) {
          s.stop('Upload complete!')
        }
        else {
          s.message(`Uploading ${percent.toFixed(0)}%`)
        }
      }
    })(),
    customMsg: async (kind: string, data: Record<string, unknown>) => {
      if (!silent) {
        await handleCustomMsg(
          kind,
          data,
          // eslint-disable-next-line no-console
          (line: string) => console.log(line),
          (line: string) => clackLog.warn(line),
        )
      }
    },
  }
}

// `withCwd` (the global chdir queue) lives in ./cwd so the prescan context
// builder shares the same queue — see src/build/cwd.ts.

interface CapgoApiErrorBody {
  error?: string
  message?: string
  moreInfo?: {
    upgrade_url?: string
    reason?: string
    activeBuilds?: number
    limit?: number
    planName?: string
  }
}

function parseCapgoApiErrorBody(errorText: string): CapgoApiErrorBody | null {
  try {
    const parsed = JSON.parse(errorText) as CapgoApiErrorBody
    if (!parsed || typeof parsed !== 'object')
      return null
    return parsed
  }
  catch {
    return null
  }
}

/** Surface plan / concurrency limit errors with a clear upgrade CTA, then throw. */
async function throwIfBuildPlanLimitError(
  status: number,
  errorText: string,
  action: 'request' | 'start',
  logger: BuildLogger,
): Promise<void> {
  if (status !== 429)
    return

  const body = parseCapgoApiErrorBody(errorText)
  const errorCode = body?.error
  if (errorCode !== 'native_build_concurrency_limit_exceeded' && errorCode !== 'need_plan_upgrade')
    return

  const config = await getRemoteConfig()
  const upgradeUrl = body?.moreInfo?.upgrade_url || `${config.hostWeb}/settings/organization/plans`
  const message = body?.message
    || (errorCode === 'native_build_concurrency_limit_exceeded'
      ? `Native build concurrency limit reached for your plan. Upgrade here: ${upgradeUrl}`
      : `Cannot ${action} native build, upgrade plan to continue: ${upgradeUrl}`)

  logger.error(message)
  if (!message.includes(upgradeUrl))
    logger.error(`Upgrade here: ${upgradeUrl}`)

  try {
    const module = await import('open')
    await module.default(upgradeUrl)
  }
  catch {
    // Ignore browser-open failures in CI / headless environments.
  }
  throw new Error(message)
}

/**
 * Fetch with retry logic for build requests
 * Retries failed requests with exponential backoff, logging each failure
 *
 * @param url - The URL to fetch
 * @param options - Fetch options
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param logger - Optional BuildLogger for log output
 * @returns The fetch Response if successful
 * @throws Error if all retries are exhausted
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  logger?: BuildLogger,
): Promise<Response> {
  const retryDelays = [1000, 3000, 5000] // 1s, 3s, 5s delays between retries

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options)

      // If response is OK or it's a client error (4xx), don't retry
      // Only retry on server errors (5xx) or network failures
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response
      }

      // Server error (5xx) - log and retry
      const errorText = await response.text().catch(() => 'unknown error')
      logger?.warn(`Build request attempt ${attempt}/${maxRetries} failed: ${response.status} - ${errorText}`)

      if (attempt < maxRetries) {
        const delay = retryDelays[attempt - 1] || 5000
        logger?.info(`Retrying in ${delay / 1000}s...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      else {
        // Last attempt failed, throw error
        throw new Error(`Failed to request build after ${maxRetries} attempts: ${response.status} - ${errorText}`)
      }
    }
    catch (error) {
      // Network error or other fetch failure
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Don't retry if we already threw our own error
      if (errorMessage.startsWith('Failed to request build after')) {
        throw error
      }

      logger?.warn(`Build request attempt ${attempt}/${maxRetries} failed: ${errorMessage}`)

      if (attempt < maxRetries) {
        const delay = retryDelays[attempt - 1] || 5000
        logger?.info(`Retrying in ${delay / 1000}s...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      else {
        throw new Error(`Failed to request build after ${maxRetries} attempts: ${errorMessage}`)
      }
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error('Unexpected error in fetchWithRetry')
}

export type { BuildCredentials, BuildRequestOptions, BuildRequestResult } from '../schemas/build'

/**
 * Stream build logs from the server via WebSocket.
 * Returns the final status if detected from the stream, or null if stream ended without status.
 */
type StatusCheckFn = () => Promise<string | null>
interface WsEntry {
  id?: number
  message?: string
  type?: string
  status?: string
  kind?: string
  data?: Record<string, unknown>
}

const TERMINAL_STATUSES = ['succeeded', 'failed', 'expired', 'released', 'cancelled'] as const
const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_STATUSES)

function decodeEventData(event: MessageEvent): string {
  if (typeof event.data === 'string')
    return event.data
  if (event.data instanceof ArrayBuffer)
    return new TextDecoder().decode(event.data)
  if (ArrayBuffer.isView(event.data)) {
    const view = event.data as ArrayBufferView
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
  }
  if (event.data && typeof (event.data as { toString?: () => string }).toString === 'function')
    return (event.data as { toString: () => string }).toString()
  return ''
}

function warnOrLog(message: string, logger: BuildLogger | undefined, silent: boolean): void {
  if (logger)
    logger.warn(message)
  else if (!silent)
    clackLog.warn(message)
}

async function dispatchCustomMsg(
  kind: string,
  data: Record<string, unknown>,
  logger: BuildLogger | undefined,
  silent: boolean,
): Promise<void> {
  try {
    if (logger) {
      await logger.customMsg(kind, data)
    }
    else if (!silent) {
      await handleCustomMsg(
        kind,
        data,
        // eslint-disable-next-line no-console
        (line: string) => console.log(line),
        (line: string) => clackLog.warn(line),
      )
    }
  }
  catch (error) {
    warnOrLog(`Custom message handler encountered an error, continuing... ${String(error)}`, logger, silent)
  }
}

async function streamBuildLogs(
  silent: boolean,
  _verbose = false,
  logsUrl?: string,
  logsToken?: string,
  statusCheck?: StatusCheckFn,
  abortSignal?: AbortSignal,
  onStreamingGiveUp?: () => void,
  logger?: BuildLogger,
): Promise<string | null> {
  if (silent && !logger)
    return null

  let finalStatus: string | null = null
  let hasReceivedLogs = false
  const processLogMessage = (message: string) => {
    if (!message.trim())
      return

    // Don't display logs after we've received a final status (e.g., cleanup messages after failure)
    if (finalStatus)
      return

    // Print log line directly to console (no spinner to avoid _events errors)
    if (!hasReceivedLogs) {
      hasReceivedLogs = true
      if (logger) {
        logger.buildLog('')
      }
      else {
        // eslint-disable-next-line no-console
        console.log('') // Add blank line before first log
      }
    }
    if (logger) {
      logger.buildLog(message)
    }
    else {
      // eslint-disable-next-line no-console
      console.log(message)
    }
  }

  const streamViaLogsWorker = async (): Promise<string | null> => {
    if (!logsUrl || !logsToken)
      return null

    const baseUrl = logsUrl.replace(/\/+$/, '')
    const startUrl = `${baseUrl}/start`
    const streamUrl = `${baseUrl}/stream?token=${encodeURIComponent(logsToken)}`
    const websocketUrl = streamUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')

    if (logger) {
      logger.info('Connecting to log streaming...')
    }
    else if (!silent) {
      // eslint-disable-next-line no-console
      console.log('Connecting to log streaming...')
    }

    const startResponse = await fetch(startUrl, {
      method: 'POST',
      headers: {
        'x-capgo-log-token': logsToken,
      },
    })
    if (!startResponse.ok) {
      const errorText = await startResponse.text().catch(() => 'unknown error')
      if (logger)
        logger.warn(`Could not start log session (${startResponse.status}): ${errorText}`)
      else if (!silent)
        console.warn(`Could not start log session (${startResponse.status}): ${errorText}`)
      return null
    }

    return await new Promise((resolve) => {
      let settled = false
      const maxRetries = 10
      let retryCount = 0
      let gaveUp = false
      const ws = new PartySocket(websocketUrl, undefined, {
        maxRetries,
        WebSocket: WS,
      })
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null
      let lastConfirmedId = 0
      let lastMessageAt = Date.now()
      let statusCheckInFlight = false
      const HEARTBEAT_INTERVAL_MS = 2000
      const HEARTBEAT_MISSES_BEFORE_STATUS = 4
      const terminalStatuses = TERMINAL_STATUS_SET
      let abortListener: (() => void) | null = null
      let timeout: ReturnType<typeof setTimeout> | null = null

      const finish = (status: string | null) => {
        if (settled)
          return
        settled = true
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }
        if (abortSignal && abortListener) {
          abortSignal.removeEventListener('abort', abortListener)
          abortListener = null
        }
        try {
          ws.close()
        }
        catch (err) {
          appendInternalLog(`ws.close failed during cleanup (ignored): ${err instanceof Error ? err.message : String(err)}`)
          // ignore
        }
        resolve(status)
      }

      timeout = setTimeout(() => {
        if (!settled) {
          if (logger)
            logger.warn('Log streaming timed out after 3 hours')
          else if (!silent)
            console.warn('Log streaming timed out after 3 hours')
          finish(null)
        }
      }, 3 * 60 * 60 * 1000)

      const startHeartbeat = () => {
        if (heartbeatTimer)
          return
        heartbeatTimer = setInterval(async () => {
          try {
            if (ws.readyState === PartySocket.OPEN) {
              ws.send(JSON.stringify({ type: 'heartbeat', lastId: lastConfirmedId }))
            }
            const now = Date.now()
            if (
              statusCheck
              && !statusCheckInFlight
              && (now - lastMessageAt) >= HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISSES_BEFORE_STATUS
            ) {
              statusCheckInFlight = true
              try {
                const status = await statusCheck()
                if (status && terminalStatuses.has(status)) {
                  finalStatus = status
                  finish(finalStatus)
                }
              }
              finally {
                statusCheckInFlight = false
              }
            }
          }
          catch (error) {
            if (logger)
              logger.warn(`Heartbeat encountered an error, continuing... ${String(error)}`)
            else if (!silent)
              clackLog.warn(`Heartbeat encountered an error, continuing... ${String(error)}`)
          }
        }, HEARTBEAT_INTERVAL_MS)
      }

      const handleEntry = async (entry: WsEntry) => {
        if (entry.type === 'custom_msg' && typeof entry.kind === 'string' && entry.data) {
          lastMessageAt = Date.now()
          await dispatchCustomMsg(entry.kind, entry.data, logger, silent)
          return
        }
        if (entry.type === 'status' && typeof entry.status === 'string') {
          const status = entry.status.toLowerCase()
          lastMessageAt = Date.now()
          if (terminalStatuses.has(status))
            finalStatus = status
          return
        }
        if (entry.type === 'log' && typeof entry.message === 'string') {
          lastMessageAt = Date.now()
          processLogMessage(entry.message)
          return
        }
        if (typeof entry.message === 'string') {
          lastMessageAt = Date.now()
          processLogMessage(entry.message)
        }
      }

      const sendConfirmation = (id: number) => {
        if (ws.readyState !== PartySocket.OPEN)
          return
        try {
          ws.send(JSON.stringify({ type: 'confirmed_received', lastId: id }))
        }
        catch (error) {
          warnOrLog(`Failed to send log confirmation, continuing... ${String(error)}`, logger, silent)
        }
      }

      startHeartbeat()

      if (abortSignal) {
        abortListener = () => {
          if (!settled)
            finish('cancelled')
        }
        if (abortSignal.aborted) {
          finish('cancelled')
          return
        }
        abortSignal.addEventListener('abort', abortListener)
      }

      ws.addEventListener('message', async (event: MessageEvent) => {
        const raw = decodeEventData(event)

        let parsed: (WsEntry & { messages?: WsEntry[] }) | null = null
        try {
          parsed = JSON.parse(raw)
        }
        catch {
          parsed = null
        }

        if (parsed?.type === 'heartbeat_response')
          return

        if (parsed?.type === 'batch_messages' && Array.isArray(parsed.messages)) {
          let maxId = lastConfirmedId
          for (const entry of parsed.messages) {
            await handleEntry(entry)
            if (typeof entry.id === 'number')
              maxId = Math.max(maxId, entry.id)
          }
          if (maxId > lastConfirmedId) {
            lastConfirmedId = maxId
            sendConfirmation(maxId)
          }
        }
        else {
          if (parsed) {
            await handleEntry(parsed)
          }
          else if (raw) {
            lastMessageAt = Date.now()
            processLogMessage(raw)
          }

          if (parsed && typeof parsed.id === 'number' && parsed.id > lastConfirmedId) {
            lastConfirmedId = parsed.id
            sendConfirmation(parsed.id)
          }
        }

        if (finalStatus)
          finish(finalStatus)
      })

      ws.addEventListener('error', () => {
        retryCount += 1
        if (logger)
          logger.warn(`Log stream encountered an error, retrying (${retryCount}/${maxRetries})...`)
        else if (!silent)
          console.warn(`Log stream encountered an error, retrying (${retryCount}/${maxRetries})...`)
        if (!gaveUp && retryCount >= maxRetries) {
          gaveUp = true
          if (logger)
            logger.warn('Log stream retry limit reached. Falling back to status checks.')
          else if (!silent)
            clackLog.warn('Log stream retry limit reached. Falling back to status checks.')
          if (onStreamingGiveUp)
            onStreamingGiveUp()
          finish(null)
        }
      })

      ws.addEventListener('close', () => {
        if (settled)
          return
        if (finalStatus) {
          finish(finalStatus)
          return
        }
        if (logger)
          logger.warn('Log stream closed, waiting for reconnect...')
        else if (!silent)
          clackLog.warn('Log stream closed, waiting for reconnect...')
      })
    })
  }

  try {
    const directStatus = await streamViaLogsWorker()
    if (directStatus || finalStatus)
      return directStatus || finalStatus
  }
  catch (err) {
    if (logger)
      logger.warn(`Direct log streaming failed${err instanceof Error ? `: ${err.message}` : ''}`)
    else if (!silent)
      clackLog.warn(`Direct log streaming failed${err instanceof Error ? `: ${err.message}` : ''}`)
  }

  return finalStatus
}

async function pollBuildStatus(
  host: string,
  jobId: string,
  appId: string,
  platform: 'ios' | 'android',
  apikey: string,
  silent: boolean,
  showStatusChecks = false,
  abortSignal?: AbortSignal,
  logger?: BuildLogger,
): Promise<string> {
  const maxAttempts = 120 // 10 minutes max (5 second intervals)
  let attempts = 0

  while (attempts < maxAttempts) {
    if (abortSignal?.aborted)
      return 'cancelled'
    try {
      const response = await fetch(`${host}/build/status?job_id=${encodeURIComponent(jobId)}&app_id=${encodeURIComponent(appId)}&platform=${platform}`, {
        headers: {
          authorization: apikey,
        },
        signal: abortSignal,
      })

      if (!response.ok) {
        logger?.warn(`Status check failed: ${response.status}`)
        await new Promise(resolve => setTimeout(resolve, 5000))
        attempts++
        continue
      }

      const status = await response.json() as {
        status: string
        build_time_seconds?: number | null
        error?: string | null
      }

      const normalized = status.status?.toLowerCase?.() ?? ''

      if (showStatusChecks)
        logger?.info(`Build status: ${normalized || status.status}`)

      if (TERMINAL_STATUS_SET.has(normalized)) {
        return normalized
      }

      // Still running, wait and retry
      await new Promise(resolve => setTimeout(resolve, 5000))
      attempts++
    }
    catch (error) {
      if (abortSignal?.aborted)
        return 'cancelled'
      logger?.warn(`Status check error: ${error}`)
      await new Promise(resolve => setTimeout(resolve, 5000))
      attempts++
    }
  }

  logger?.warn('Build status polling timed out')
  return 'timeout'
}

/**
 * Extract native node_modules roots that contain platform folders.
 */
interface NativeDependencies {
  packages: Set<string> // Capacitor package paths like @capacitor/app
  cordovaPackages: Set<string> // Cordova plugin package paths like onesignal-cordova-plugin
  usesSPM: boolean
  usesCocoaPods: boolean
}

interface ZipDirectoryOptions {
  nodeModules?: string
}

async function extractNativeDependencies(
  projectDir: string,
  platform: 'ios' | 'android',
  platformDir: string,
): Promise<NativeDependencies> {
  const packages = new Set<string>()
  const cordovaPackages = new Set<string>()
  let usesSPM = false
  let usesCocoaPods = false

  if (platform === 'ios') {
    // Detect Swift Package Manager dependencies from CapApp-SPM/Package.swift when present.
    const spmPackagePath = join(projectDir, platformDir, 'App', 'CapApp-SPM', 'Package.swift')
    if (existsSync(spmPackagePath)) {
      usesSPM = true
      const spmContent = await readFileAsync(spmPackagePath, 'utf-8')
      // Match lines like: .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")
      // The path can have varying numbers of ../ depending on project structure
      const spmMatches = spmContent.matchAll(/\.package\s*\([^)]*path:\s*["'](?:\.\.[\\/])*node_modules[\\/]([^"']+)["']\s*\)/g)
      for (const match of spmMatches) {
        let pkgPath = match[1].replace(/\\/g, '/')
        const lastNmIdx = pkgPath.lastIndexOf('node_modules/')
        if (lastNmIdx !== -1)
          pkgPath = pkgPath.substring(lastNmIdx + 'node_modules/'.length)
        packages.add(pkgPath)
      }
    }

    // Detect CocoaPods dependencies from Podfile(s). SPM and CocoaPods may coexist.
    const iosDir = join(projectDir, platformDir)
    if (existsSync(iosDir)) {
      const candidates: string[] = [
        join(iosDir, 'App', 'Podfile'),
        join(iosDir, 'Podfile'),
      ]

      for (const child of readdirSync(iosDir, { withFileTypes: true })) {
        if (child.isDirectory()) {
          candidates.push(join(iosDir, child.name, 'Podfile'))
        }
      }

      const uniqPodfiles = [...new Set(candidates)].filter(candidate => existsSync(candidate))
      if (uniqPodfiles.length > 0)
        usesCocoaPods = true

      for (const podfilePath of uniqPodfiles) {
        const podfileContent = await readFileAsync(podfilePath, 'utf-8')
        // Match lines like: pod 'CapacitorApp', :path => '../../node_modules/@capacitor/app'
        const podMatches = podfileContent.matchAll(/pod\s+['"][^'"]+['"],\s*:path\s*=>\s*['"](?:\.\.[\\/])+node_modules[\\/]([^'"]+)['"]/g)
        for (const match of podMatches) {
          let pkgPath = match[1]
          const lastNmIdx = pkgPath.lastIndexOf('node_modules/')
          if (lastNmIdx !== -1)
            pkgPath = pkgPath.substring(lastNmIdx + 'node_modules/'.length)
          packages.add(pkgPath)
        }
      }
    }
  }
  else if (platform === 'android') {
    // Parse Android capacitor.settings.gradle
    const settingsGradlePath = join(projectDir, platformDir, 'capacitor.settings.gradle')
    if (existsSync(settingsGradlePath)) {
      const settingsContent = await readFileAsync(settingsGradlePath, 'utf-8')
      // Match lines like: project(':capacitor-app').projectDir = new File('../node_modules/@capacitor/app/android')
      // Also matches pnpm paths: new File('../node_modules/.pnpm/@pkg@ver/node_modules/@scope/pkg/android')
      const gradleMatches = settingsContent.matchAll(/new\s+File\s*\(\s*['"]\.\.[\\/]node_modules[\\/]([^'"]+)['"]\s*\)/g)
      for (const match of gradleMatches) {
        let fullPath = match[1].replace(/\\/g, '/')

        // Normalize pnpm paths: .pnpm/@pkg+name@ver/node_modules/@scope/pkg/android → @scope/pkg
        const lastNodeModulesIdx = fullPath.lastIndexOf('node_modules/')
        if (lastNodeModulesIdx !== -1) {
          fullPath = fullPath.substring(lastNodeModulesIdx + 'node_modules/'.length)
        }

        // Strip platform directory suffixes (android, capacitor for @capacitor/android)
        const packagePath = fullPath.replace(/\/(android|capacitor)$/, '')
        packages.add(packagePath)
      }
    }

    // Parse Cordova plugin references from capacitor-cordova-android-plugins/build.gradle.
    // These plugins are NOT listed in capacitor.settings.gradle. They are wired via
    // `apply from: "../../node_modules/<plugin>/<file>.gradle"` lines that `cap sync`
    // injects between the PLUGIN GRADLE EXTENSIONS markers. The referenced files live
    // at the package root, not under an `android/` subfolder, so we must include the
    // entire package contents in the upload bundle.
    const cordovaBuildGradlePath = join(projectDir, platformDir, 'capacitor-cordova-android-plugins', 'build.gradle')
    if (existsSync(cordovaBuildGradlePath)) {
      const cordovaContent = await readFileAsync(cordovaBuildGradlePath, 'utf-8')
      // Match: apply from: "../../node_modules/<pkg>/..." (any depth of ../, single or double quotes)
      const applyFromMatches = cordovaContent.matchAll(/apply\s+from\s*:\s*["'](?:\.\.\/)+node_modules\/([^"']+)["']/g)
      for (const match of applyFromMatches) {
        let fullPath = match[1]
        // Normalize pnpm paths
        const lastNodeModulesIdx = fullPath.lastIndexOf('node_modules/')
        if (lastNodeModulesIdx !== -1)
          fullPath = fullPath.substring(lastNodeModulesIdx + 'node_modules/'.length)
        // Extract package name: scoped (@scope/pkg) takes two segments, otherwise one
        const segments = fullPath.split('/')
        const packagePath = segments[0].startsWith('@') && segments.length >= 2
          ? `${segments[0]}/${segments[1]}`
          : segments[0]
        cordovaPackages.add(packagePath)
      }
    }
  }

  return { packages, cordovaPackages, usesSPM, usesCocoaPods }
}

/**
 * Check if a file path should be included in the zip
 */
export function shouldIncludeFile(filePath: string, platform: 'ios' | 'android', nativeDeps: NativeDependencies, platformDir: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/')

  // Always include platform folder
  if (normalizedPath.startsWith(`${platformDir}/`))
    return true

  // Always include config files at root
  if (normalizedPath === 'package.json' || normalizedPath === 'package-lock.json' || normalizedPath.startsWith('capacitor.config.'))
    return true

  // Include resources folder
  if (normalizedPath.startsWith('resources/'))
    return true

  // Include @capacitor core for the platform
  if (platform === 'ios' && normalizedPath.startsWith('node_modules/@capacitor/ios/'))
    return true
  if (platform === 'android' && normalizedPath.startsWith('node_modules/@capacitor/android/'))
    return true

  // Cordova plugins: include the entire package contents EXCEPT the plugin's own
  // nested node_modules. Cordova plugins don't follow Capacitor's `<pkg>/android/`
  // convention — supporting files like `build-extras-*.gradle` live at the package
  // root, native sources may live under `src/android/`, and `plugin.xml` is at the
  // root. We include all of those, but exclude any bundled transitive dependencies
  // under `<pkg>/node_modules/...` to avoid pulling unrelated code (and arbitrary
  // size) into the upload bundle.
  if (platform === 'android') {
    for (const cordovaPkg of nativeDeps.cordovaPackages) {
      const cordovaPrefix = `node_modules/${cordovaPkg}/`
      if (normalizedPath === `node_modules/${cordovaPkg}/package.json`)
        return true
      if (normalizedPath.startsWith(cordovaPrefix)) {
        const subpath = normalizedPath.slice(cordovaPrefix.length)
        // Reject anything inside the plugin's own bundled node_modules.
        if (subpath === 'node_modules' || subpath.startsWith('node_modules/'))
          continue
        return true
      }
    }
  }

  // Check if file is in one of the native dependencies
  for (const packagePath of nativeDeps.packages) {
    const packagePrefix = `node_modules/${packagePath}/`

    // Native dependency package metadata used by some podspecs/gradle scripts.
    if (normalizedPath === `${packagePrefix}package.json`)
      return true

    if (platform === 'android') {
      // For Android, only include the android/ subfolder
      if (normalizedPath.startsWith(`${packagePrefix}android/`))
        return true
    }
    else if (platform === 'ios') {
      // For iOS, include ios/ folder and either Package.swift (SPM) or *.podspec (CocoaPods)
      if (normalizedPath.startsWith(`${packagePrefix}ios/`))
        return true

      if (nativeDeps.usesSPM) {
        // SPM: include Package.swift
        if (normalizedPath === `${packagePrefix}Package.swift`)
          return true
      }
      if (nativeDeps.usesCocoaPods || !nativeDeps.usesSPM) {
        // CocoaPods: include *.podspec files (also when neither manager is explicitly detected)
        if (normalizedPath.startsWith(packagePrefix) && normalizedPath.endsWith('.podspec'))
          return true
      }
    }
  }

  return false
}

/**
 * Recursively add directory to zip with filtering
 */
function addDirectoryToZip(
  zip: AdmZip,
  dirPath: string,
  zipPath: string,
  platform: 'ios' | 'android',
  nativeDeps: NativeDependencies,
  platformDir: string,
) {
  const items = readdirSync(dirPath)

  for (const item of items) {
    const itemPath = join(dirPath, item)
    const itemZipPath = zipPath ? `${zipPath}/${item}` : item
    const stats = statSync(itemPath)

    if (stats.isDirectory()) {
      // Skip excluded directories
      // .git: version control
      // dist, build, .angular, .vite: build output directories
      // .gradle, .idea: Android build cache and IDE settings
      // .swiftpm: Swift Package Manager cache
      if (item === '.git' || item === 'dist' || item === 'build' || item === '.angular' || item === '.vite' || item === '.gradle' || item === '.idea' || item === '.swiftpm')
        continue

      // Always recurse into node_modules (we filter inside)
      if (item === 'node_modules') {
        addDirectoryToZip(zip, itemPath, itemZipPath, platform, nativeDeps, platformDir)
        continue
      }

      // For resources folder, always recurse
      if (item === 'resources') {
        addDirectoryToZip(zip, itemPath, itemZipPath, platform, nativeDeps, platformDir)
        continue
      }

      // For other directories, check if we need to recurse into them
      // We should recurse if:
      // 1. This directory itself should be included (matches a pattern)
      // 2. This directory is a prefix of a dependency path (need to traverse to reach it)
      const normalizedItemPath = itemZipPath.replace(/\\/g, '/')
      const allPackages = [...nativeDeps.packages, ...nativeDeps.cordovaPackages]
      const shouldRecurse = shouldIncludeFile(itemZipPath, platform, nativeDeps, platformDir)
        // Ensure we can reach nested platform directories like projects/app/android.
        || platformDir === normalizedItemPath
        || platformDir.startsWith(`${normalizedItemPath}/`)
        || allPackages.some((pkg) => {
          const depPath = `node_modules/${pkg}/`
          return depPath.startsWith(`${normalizedItemPath}/`) || normalizedItemPath.startsWith(`node_modules/${pkg}`)
        })

      if (shouldRecurse) {
        addDirectoryToZip(zip, itemPath, itemZipPath, platform, nativeDeps, platformDir)
      }
    }
    else if (stats.isFile()) {
      // Skip excluded files
      if (item === '.DS_Store' || item.endsWith('.log'))
        continue

      // Check if we should include this file
      if (shouldIncludeFile(itemZipPath, platform, nativeDeps, platformDir)) {
        addFileToZip(zip, itemPath, itemZipPath)
      }
    }
  }
}

function addFileToZip(zip: AdmZip, filePath: string, zipEntryPath: string) {
  const normalizedEntryPath = zipEntryPath.replace(/\\/g, '/')
  if (zip.getEntry(normalizedEntryPath))
    return

  const lastSlashIndex = normalizedEntryPath.lastIndexOf('/')
  const zipFolder = lastSlashIndex === -1 ? undefined : normalizedEntryPath.slice(0, lastSlashIndex)
  zip.addLocalFile(filePath, zipFolder)
}

function parseNodeModulesPaths(nodeModules: string | undefined): string[] {
  if (!nodeModules)
    return []

  const paths = nodeModules
    .split(',')
    .map(nodeModulesPath => nodeModulesPath.trim())
    .filter(Boolean)
    .map(nodeModulesPath => resolve(nodeModulesPath))

  return [...new Set(paths)]
}

function getNativePackagePaths(platform: 'ios' | 'android', nativeDeps: NativeDependencies): Set<string> {
  const packages = new Set([...nativeDeps.packages, ...nativeDeps.cordovaPackages])
  packages.add(platform === 'ios' ? '@capacitor/ios' : '@capacitor/android')
  return packages
}

function findPackageInNodeModules(nodeModulesPath: string, packagePath: string): string | undefined {
  const directPackageDir = join(nodeModulesPath, ...packagePath.split('/'))
  if (existsSync(directPackageDir))
    return directPackageDir

  const pnpmStoreDir = join(nodeModulesPath, '.pnpm')
  if (!existsSync(pnpmStoreDir))
    return undefined

  const encodedPackageName = packagePath.replace('/', '+')
  const pnpmEntries = readdirSync(pnpmStoreDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => name.startsWith(`${encodedPackageName}@`))
    .sort()

  if (pnpmEntries.length > 1) {
    throw new Error(`Multiple pnpm store entries found for ${packagePath} in ${pnpmStoreDir}; provide the app-specific node_modules path so the native build archive can use the exact resolved package.`)
  }

  for (const entry of pnpmEntries) {
    const packageDir = join(pnpmStoreDir, entry, 'node_modules', ...packagePath.split('/'))
    if (existsSync(packageDir))
      return packageDir
  }

  return undefined
}

function addNativePackagesFromNodeModules(
  zip: AdmZip,
  nodeModulesPaths: string[],
  platform: 'ios' | 'android',
  nativeDeps: NativeDependencies,
  platformDir: string,
) {
  if (nodeModulesPaths.length === 0)
    return

  const missingPaths = nodeModulesPaths.filter(nodeModulesPath => !existsSync(nodeModulesPath))
  if (missingPaths.length > 0)
    throw new Error(`Missing node_modules folder at ${missingPaths.join(', ')}`)

  for (const nodeModulesPath of nodeModulesPaths) {
    for (const packagePath of getNativePackagePaths(platform, nativeDeps)) {
      const packageDir = findPackageInNodeModules(nodeModulesPath, packagePath)
      if (!packageDir)
        continue

      addDirectoryToZip(
        zip,
        packageDir,
        `node_modules/${packagePath}`,
        platform,
        nativeDeps,
        platformDir,
      )
    }
  }
}

/**
 * Zip directory for native build, including only necessary files:
 * - ios/ OR android/ folder (based on platform)
 * - node_modules with native code (from Podfile/settings.gradle)
 * - capacitor.config.*, package.json, package-lock.json
 * Zip contents are the user's responsibility, not Capgo's; Capgo packages the user-provided files as-is.
 */
export async function zipDirectory(projectDir: string, outputPath: string, platform: 'ios' | 'android', capConfig: any, options: ZipDirectoryOptions = {}): Promise<void> {
  const platformDir = getPlatformDirFromCapacitorConfig(capConfig, platform)

  // Extract which node_modules have native code for this platform
  const nativeDeps = await extractNativeDependencies(projectDir, platform, platformDir)

  const zip = new AdmZip()

  // Add files with filtering
  addDirectoryToZip(zip, projectDir, '', platform, nativeDeps, platformDir)
  addNativePackagesFromNodeModules(zip, parseNodeModulesPaths(options.nodeModules), platform, nativeDeps, platformDir)

  // Rewrite isolated-linker store paths to standard flat paths (node_modules/@scope/pkg).
  // Both pnpm (node_modules/.pnpm/…/node_modules/@scope/pkg) and bun's isolated linker
  // (node_modules/.bun/@scope+pkg@ver+hash/node_modules/@scope/pkg) leak store paths into
  // Package.swift, Podfile, Podfile.lock, Pods.xcodeproj/project.pbxproj, .xcconfig files,
  // Manifest.lock, settings.gradle, etc. The cloud builder only ships the flat plugin dirs,
  // so these store paths must be collapsed back to node_modules/@scope/pkg.
  const pnpmPathPattern = /node_modules\/\.pnpm\/[^/\n\r]+(?:\/[^/\n\r]+)*\/node_modules\//g
  const bunPathPattern = /node_modules\/\.bun\/[^/\n\r]+(?:\/[^/\n\r]+)*\/node_modules\//g
  const textExtensions = new Set([
    '',
    '.gradle',
    '.swift',
    '.json',
    '.lock',
    '.xml',
    '.properties',
    '.pbxproj',
    '.xcconfig',
    '.plist',
    '.podspec',
    '.rb',
    '.yaml',
    '.yml',
  ])
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory)
      continue
    const ext = entry.entryName.includes('.') ? `.${entry.entryName.split('.').pop()}` : ''
    const basename = entry.entryName.split('/').pop() || ''
    if (!textExtensions.has(ext) && basename !== 'Podfile')
      continue
    const original = entry.getData().toString('utf-8')
    let rewritten = normalizeNativeDependencyPathsInText(original)
    rewritten = rewritten.replace(pnpmPathPattern, 'node_modules/').replace(bunPathPattern, 'node_modules/')

    // pnpm can leave deep relative paths in iOS files like Package.swift and Pods output.
    // Collapse any excessive ../ before project-root ios/ or node_modules/ paths back to
    // the current zip entry's actual depth.
    if (platform === 'ios') {
      const rootRelativePrefix = '../'.repeat(entry.entryName.split('/').length - 1)
      rewritten = rewritten.replace(
        /(?:\.\.\/){4,}(ios\/|node_modules\/)/g,
        (_match, rootPath: string) => `${rootRelativePrefix}${rootPath}`,
      )
    }

    if (rewritten !== original) {
      zip.updateFile(entry.entryName, Buffer.from(rewritten, 'utf-8'))
    }
  }

  // Cloud builders may only parse JSON configs. Ensure a resolved JSON exists even if the project
  // uses capacitor.config.ts/js, so android.path/ios.path is visible remotely.
  const configJsonPath = join(projectDir, 'capacitor.config.json')
  if (capConfig && !existsSync(configJsonPath)) {
    const json = `${JSON.stringify(capConfig, null, 2)}\n`
    zip.addFile('capacitor.config.json', Buffer.from(json, 'utf-8'))
  }

  // Write zip to file
  await writeFile(outputPath, zip.toBuffer())
}

/**
 * Request a native build from Capgo's cloud build service
 *
 * @param appId - The app ID (e.g., com.example.app)
 * @param options - Build request options including platform and credentials
 * @param silent - Suppress console output
 *
 * @returns Build request result with job ID and status
 *
 * SECURITY NOTE:
 * Credentials provided to this function are:
 * - Transmitted securely over HTTPS to Capgo's build servers
 * - Used ONLY during the active build process
 * - Automatically deleted after build completion
 * - NEVER stored permanently on Capgo servers
 * - Build outputs may optionally be uploaded for time-limited download links
 */

/** Keys that are non-secret build options and should NOT be sent in the credentials blob. */
export const NON_CREDENTIAL_KEYS = new Set([
  'CAPGO_IOS_SCHEME',
  'CAPGO_IOS_TARGET',
  'CAPGO_IOS_DISTRIBUTION',
  'BUILD_OUTPUT_UPLOAD_ENABLED',
  'BUILD_OUTPUT_RETENTION_SECONDS',
  'SKIP_BUILD_NUMBER_BUMP',
  'SKIP_MARKETING_VERSION_BUMP',
  'CAPGO_STORE_SUBMIT_REVIEW',
  'CAPGO_STORE_RELEASE_NAME',
  'CAPGO_STORE_RELEASE_NOTES',
  'CAPGO_STORE_RELEASE_NOTES_LOCALIZED',
  'CAPGO_IOS_AUTOMATIC_RELEASE',
  'CAPGO_IOS_TESTFLIGHT_GROUPS',
  'CAPGO_IOS_SOURCE_DIR',
  'CAPGO_IOS_APP_DIR',
  'CAPGO_IOS_PROJECT_DIR',
  'IOS_PROJECT_DIR',
  'CAPGO_ANDROID_SOURCE_DIR',
  'CAPGO_ANDROID_APP_DIR',
  'CAPGO_ANDROID_PROJECT_DIR',
  'ANDROID_PROJECT_DIR',
  'CAPGO_ANDROID_FLAVOR',
])

type LocalizedReleaseNotes = Record<string, string>

export function parseStoreReleaseNotesLocaleEntries(entries?: string[]): LocalizedReleaseNotes | undefined {
  if (!entries || entries.length === 0)
    return undefined

  const localized: LocalizedReleaseNotes = {}
  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) {
      throw new Error('--store-release-notes-locale must use locale=notes format, for example: --store-release-notes-locale en-US="Bug fixes"')
    }

    const locale = entry.slice(0, separatorIndex).trim()
    const notes = entry.slice(separatorIndex + 1).trim()
    if (!locale || !notes) {
      throw new Error('--store-release-notes-locale requires both a locale and non-empty release notes')
    }

    localized[locale] = notes
  }

  return Object.keys(localized).length > 0 ? localized : undefined
}

export function parseStoreReleaseNotesLocalizedJson(value?: string): LocalizedReleaseNotes | undefined {
  const raw = value?.trim()
  if (!raw)
    return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (error) {
    throw new Error(`CAPGO_STORE_RELEASE_NOTES_LOCALIZED must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CAPGO_STORE_RELEASE_NOTES_LOCALIZED must be a JSON object like {"en-US":"Bug fixes"}')
  }

  const localized: LocalizedReleaseNotes = {}
  for (const [locale, notes] of Object.entries(parsed)) {
    const cleanLocale = locale.trim()
    if (typeof notes !== 'string' || !notes.trim()) {
      throw new Error(`CAPGO_STORE_RELEASE_NOTES_LOCALIZED.${cleanLocale || locale} must be a non-empty string`)
    }
    if (!cleanLocale) {
      throw new Error('CAPGO_STORE_RELEASE_NOTES_LOCALIZED cannot contain an empty locale key')
    }
    localized[cleanLocale] = notes.trim()
  }

  return Object.keys(localized).length > 0 ? localized : undefined
}

/**
 * Split merged credentials into a build options payload and a credentials-only payload.
 * Non-secret configuration keys (schemes, directories, output control) go into buildOptions.
 * Only actual secrets (certificates, passwords, API keys) remain in buildCredentials.
 */
export function splitPayload(
  mergedCredentials: Record<string, string | undefined>,
  platform: 'ios' | 'android',
  buildMode: string,
  cliVersion: string,
): { buildOptions: BuildOptionsPayload, buildCredentials: Record<string, string> } {
  const storeReleaseNotesLocalized = parseStoreReleaseNotesLocalizedJson(mergedCredentials.CAPGO_STORE_RELEASE_NOTES_LOCALIZED)
  const iosAutomaticRelease = mergedCredentials.CAPGO_IOS_AUTOMATIC_RELEASE === undefined
    ? undefined
    : mergedCredentials.CAPGO_IOS_AUTOMATIC_RELEASE === 'true'

  const buildOptions: BuildOptionsPayload = {
    platform,
    buildMode: buildMode as 'debug' | 'release',
    cliVersion,
    iosScheme: mergedCredentials.CAPGO_IOS_SCHEME,
    iosTarget: mergedCredentials.CAPGO_IOS_TARGET,
    iosDistribution: mergedCredentials.CAPGO_IOS_DISTRIBUTION as 'app_store' | 'ad_hoc' | undefined,
    iosSourceDir: mergedCredentials.CAPGO_IOS_SOURCE_DIR,
    iosAppDir: mergedCredentials.CAPGO_IOS_APP_DIR,
    iosProjectDir: mergedCredentials.CAPGO_IOS_PROJECT_DIR,
    androidSourceDir: mergedCredentials.CAPGO_ANDROID_SOURCE_DIR,
    androidAppDir: mergedCredentials.CAPGO_ANDROID_APP_DIR,
    androidProjectDir: mergedCredentials.CAPGO_ANDROID_PROJECT_DIR,
    androidFlavor: mergedCredentials.CAPGO_ANDROID_FLAVOR,
    outputUploadEnabled: mergedCredentials.BUILD_OUTPUT_UPLOAD_ENABLED === 'true',
    outputRetentionSeconds: mergedCredentials.BUILD_OUTPUT_RETENTION_SECONDS
      ? Number.parseInt(mergedCredentials.BUILD_OUTPUT_RETENTION_SECONDS, 10) || MIN_OUTPUT_RETENTION_SECONDS
      : MIN_OUTPUT_RETENTION_SECONDS,
    skipBuildNumberBump: mergedCredentials.SKIP_BUILD_NUMBER_BUMP === 'true',
    skipMarketingVersionBump: mergedCredentials.SKIP_MARKETING_VERSION_BUMP === 'true',
    submitToStoreReview: mergedCredentials.CAPGO_STORE_SUBMIT_REVIEW === 'true',
    storeReleaseName: mergedCredentials.CAPGO_STORE_RELEASE_NAME,
    storeReleaseNotes: mergedCredentials.CAPGO_STORE_RELEASE_NOTES,
    storeReleaseNotesLocalized,
    iosTestflightGroups: mergedCredentials.CAPGO_IOS_TESTFLIGHT_GROUPS,
    iosAutomaticRelease,
  }

  const buildCredentials: Record<string, string> = {}
  for (const [key, value] of Object.entries(mergedCredentials)) {
    if (!NON_CREDENTIAL_KEYS.has(key) && value !== undefined) {
      buildCredentials[key] = value
    }
  }

  return { buildOptions, buildCredentials }
}

export async function requestBuildInternal(appId: string, options: BuildRequestOptions, silent = false, logger?: BuildLogger): Promise<BuildRequestResult> {
  // Start the verbose internal log so API errors + the support flow's bundle have
  // content (no-op if already started by a wrapping onboarding run).
  if (!getInternalLogPath())
    startInternalLog(appId)
  appendInternalLog(`build request: started for ${appId} (platform ${options.platform ?? 'auto'})`)
  // Track build time
  const buildStartTime = Date.now()
  const verbose = options.verbose ?? false
  const baseLogger = logger || createDefaultLogger(silent)

  // Capture the artifact download URL from the qr_download_link custom message so
  // we can persist it (and a derived QR PNG) when --output-record is set. We wrap
  // the logger rather than duplicating dispatch logic so the existing print
  // behaviour stays intact.
  let capturedOutputUrl: string | null = null
  const log: BuildLogger = options.outputRecord
    ? {
        ...baseLogger,
        customMsg: async (kind, data) => {
          if (kind === 'qr_download_link' && typeof data.url === 'string')
            capturedOutputUrl = data.url
          await baseLogger.customMsg(kind, data)
        },
      }
    : baseLogger

  try {
    // --prescan-ignore-fatal + --fail-on-warnings is contradictory (the spec says the
    // CLI rejects the combination on `build request` too, not just `build prescan`).
    // Validated before any network call so nothing is ever created server-side.
    if (options.prescan === true) {
      const { validateFlags } = await import('./prescan/command')
      validateFlags({ ignoreFatal: options.prescanIgnoreFatal, failOnWarnings: options.failOnWarnings })
    }

    options.apikey = options.apikey || findSavedKey(silent)
    const projectDir = resolve(options.path || cwd())

    // @capacitor/cli loadConfig() is cwd-based; honor --path for monorepos/workspaces.
    const config = await withCwd(projectDir, () => getConfig())
    appId = appId || config?.config?.appId

    if (!appId) {
      throw new Error('Missing argument, you need to provide a appId, or be in a capacitor project')
    }

    const platform = await resolveBuildPlatform(options.platform, { silent })

    if (platform === 'ios' && options.syncIosVersion) {
      const syncResult = syncIosMarketingVersion({ path: projectDir })
      log.info(syncResult.changed
        ? `Synced iOS MARKETING_VERSION to ${syncResult.marketingVersion}`
        : `iOS MARKETING_VERSION is already ${syncResult.marketingVersion}`)
    }

    const host = options.supaHost || 'https://api.capgo.app'

    const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
    // NOTE: the build-permission assert was moved below (after the prescan gate) so prescan's
    // batched report — which includes shared/apikey-permission — is what users see first.

    // Org id is best-effort, for analytics tags only. Don't hard-abort here when the app
    // isn't visible to this key: prescan's shared/app-exists check explains *why* (and the
    // permission backstop below still enforces access for --no-prescan), so letting the gate
    // run first gives the batched report instead of a bare "Cannot get organization id".
    let orgId = ''
    try {
      orgId = await getOrganizationId(supabase, appId)
    }
    catch {
      // App not accessible / no org — surfaced by prescan (app-exists) and the permission backstop.
    }

    log.info(`Requesting native build for ${appId}`)
    log.info(`Platform: ${platform}`)
    log.info(`Project: ${projectDir}`)
    log.info(`\n🔒 Security: Credentials are never stored on Capgo servers`)
    log.info(`   They are used only during build and deleted after`)
    log.info(`   Build outputs can optionally be uploaded for time-limited download links\n`)
    if (verbose) {
      log.info(`API host: ${host}`)
    }

    // Collect credentials from CLI args (if provided)
    const cliCredentials: Partial<BuildCredentials> = {}
    const cliStoreReleaseNotesLocalized = {
      ...(options.storeReleaseNotesLocalized ?? {}),
      ...(parseStoreReleaseNotesLocaleEntries(options.storeReleaseNotesLocale) ?? {}),
    }
    const hasCliStoreReleaseNotesLocalized = Object.keys(cliStoreReleaseNotesLocalized).length > 0
    if (options.buildCertificateBase64)
      cliCredentials.BUILD_CERTIFICATE_BASE64 = options.buildCertificateBase64
    if (options.p12Password)
      cliCredentials.P12_PASSWORD = options.p12Password
    if (options.appleKeyId)
      cliCredentials.APPLE_KEY_ID = options.appleKeyId
    if (options.appleIssuerId)
      cliCredentials.APPLE_ISSUER_ID = options.appleIssuerId
    if (options.appleKeyContent)
      cliCredentials.APPLE_KEY_CONTENT = options.appleKeyContent
    if (options.appStoreConnectTeamId)
      cliCredentials.APP_STORE_CONNECT_TEAM_ID = options.appStoreConnectTeamId
    if (options.appleId)
      cliCredentials.FASTLANE_USER = options.appleId
    if (options.appleAppSpecificPassword)
      cliCredentials.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD = options.appleAppSpecificPassword
    if (options.appleAppId)
      cliCredentials.APPLE_APP_ID = options.appleAppId
    if (options.iosScheme)
      cliCredentials.CAPGO_IOS_SCHEME = options.iosScheme
    if (options.iosTarget)
      cliCredentials.CAPGO_IOS_TARGET = options.iosTarget
    if (options.iosDistribution)
      cliCredentials.CAPGO_IOS_DISTRIBUTION = options.iosDistribution
    if (options.iosProvisioningProfile && options.iosProvisioningProfile.length > 0) {
      const provMap = buildProvisioningMap(options.iosProvisioningProfile, resolve(options.path || cwd()))
      cliCredentials.CAPGO_IOS_PROVISIONING_MAP = JSON.stringify(provMap)
    }
    if (options.iosProvisioningMap)
      cliCredentials.CAPGO_IOS_PROVISIONING_MAP = options.iosProvisioningMap
    if (options.androidKeystoreFile)
      cliCredentials.ANDROID_KEYSTORE_FILE = options.androidKeystoreFile
    if (options.keystoreKeyAlias)
      cliCredentials.KEYSTORE_KEY_ALIAS = options.keystoreKeyAlias

    // For Android: if only one password is provided, use it for both key and store
    const hasKeyPassword = !!options.keystoreKeyPassword
    const hasStorePassword = !!options.keystoreStorePassword
    if (hasKeyPassword && !hasStorePassword) {
      cliCredentials.KEYSTORE_KEY_PASSWORD = options.keystoreKeyPassword
      cliCredentials.KEYSTORE_STORE_PASSWORD = options.keystoreKeyPassword
    }
    else if (!hasKeyPassword && hasStorePassword) {
      cliCredentials.KEYSTORE_KEY_PASSWORD = options.keystoreStorePassword
      cliCredentials.KEYSTORE_STORE_PASSWORD = options.keystoreStorePassword
    }
    else if (hasKeyPassword && hasStorePassword) {
      cliCredentials.KEYSTORE_KEY_PASSWORD = options.keystoreKeyPassword
      cliCredentials.KEYSTORE_STORE_PASSWORD = options.keystoreStorePassword
    }

    if (typeof options.androidFlavor === 'string') {
      const androidFlavorTrimmed = options.androidFlavor.trim()
      if (androidFlavorTrimmed)
        cliCredentials.CAPGO_ANDROID_FLAVOR = androidFlavorTrimmed
    }
    if (options.playConfigJson)
      cliCredentials.PLAY_CONFIG_JSON = options.playConfigJson
    if (options.inAppUpdatePriority !== undefined) {
      cliCredentials.PLAY_STORE_IN_APP_UPDATE_PRIORITY = String(parseInAppUpdatePriority(options.inAppUpdatePriority as number | string))
    }
    if (options.outputUpload !== undefined) {
      cliCredentials.BUILD_OUTPUT_UPLOAD_ENABLED = parseOptionalBoolean(options.outputUpload) ? 'true' : 'false'
    }
    if (options.outputRetention) {
      cliCredentials.BUILD_OUTPUT_RETENTION_SECONDS = String(parseOutputRetentionSeconds(options.outputRetention))
    }
    if (options.skipBuildNumberBump !== undefined) {
      cliCredentials.SKIP_BUILD_NUMBER_BUMP = parseOptionalBoolean(options.skipBuildNumberBump) ? 'true' : 'false'
    }
    if (options.skipMarketingVersionBump !== undefined) {
      cliCredentials.SKIP_MARKETING_VERSION_BUMP = parseOptionalBoolean(options.skipMarketingVersionBump) ? 'true' : 'false'
    }
    if (options.submitToStoreReview !== undefined) {
      cliCredentials.CAPGO_STORE_SUBMIT_REVIEW = parseOptionalBoolean(options.submitToStoreReview) ? 'true' : 'false'
    }
    if (typeof options.storeReleaseName === 'string' && options.storeReleaseName.trim()) {
      cliCredentials.CAPGO_STORE_RELEASE_NAME = options.storeReleaseName.trim()
    }
    if (typeof options.storeReleaseNotes === 'string' && options.storeReleaseNotes.trim()) {
      cliCredentials.CAPGO_STORE_RELEASE_NOTES = options.storeReleaseNotes.trim()
    }
    if (typeof options.iosTestflightGroups === 'string' && options.iosTestflightGroups.trim()) {
      cliCredentials.CAPGO_IOS_TESTFLIGHT_GROUPS = options.iosTestflightGroups.trim()
    }
    if (options.iosAutomaticRelease !== undefined) {
      cliCredentials.CAPGO_IOS_AUTOMATIC_RELEASE = parseOptionalBoolean(options.iosAutomaticRelease) ? 'true' : 'false'
    }

    // Merge credentials from all three sources:
    // 1. CLI args (highest priority)
    // 2. Environment variables (middle priority)
    // 3. Saved credentials file (lowest priority)
    const mergedCredentials = await mergeCredentials(
      appId,
      platform,
      Object.keys(cliCredentials).length > 0 ? cliCredentials : undefined,
    )

    if (mergedCredentials && hasCliStoreReleaseNotesLocalized) {
      const existingLocalized = parseStoreReleaseNotesLocalizedJson(mergedCredentials.CAPGO_STORE_RELEASE_NOTES_LOCALIZED) ?? {}
      mergedCredentials.CAPGO_STORE_RELEASE_NOTES_LOCALIZED = JSON.stringify({
        ...existingLocalized,
        ...cliStoreReleaseNotesLocalized,
      })
    }
    // --no-playstore-upload: null out PLAY_CONFIG_JSON so it never reaches the builder
    if (options.playstoreUpload === false && mergedCredentials) {
      delete mergedCredentials.PLAY_CONFIG_JSON
      log.info('ℹ️  --no-playstore-upload specified, Play Store upload disabled for this build')
    }

    const nativeProjectDir = getPlatformDirFromCapacitorConfig(config?.config, platform)
    if (mergedCredentials && nativeProjectDir) {
      if (platform === 'ios') {
        mergedCredentials.CAPGO_IOS_SOURCE_DIR = nativeProjectDir
        mergedCredentials.CAPGO_IOS_APP_DIR = nativeProjectDir
        mergedCredentials.CAPGO_IOS_PROJECT_DIR = nativeProjectDir
        mergedCredentials.IOS_PROJECT_DIR = nativeProjectDir
      }
      else {
        mergedCredentials.CAPGO_ANDROID_SOURCE_DIR = nativeProjectDir
        mergedCredentials.CAPGO_ANDROID_APP_DIR = nativeProjectDir
        mergedCredentials.CAPGO_ANDROID_PROJECT_DIR = nativeProjectDir
        mergedCredentials.ANDROID_PROJECT_DIR = nativeProjectDir
      }
    }

    // Prepare request payload for Capgo backend
    // (payload structure will be finalized after credential validation below)

    // Validate required credentials for the platform
    if (!mergedCredentials) {
      log.error('❌ No credentials found for this app and platform')
      log.error('')
      log.error('You must provide credentials via:')
      log.error('  1. CLI arguments (--apple-key-id, --p12-password, etc.)')
      log.error('  2. Environment variables (APPLE_KEY_ID, P12_PASSWORD, etc.)')
      log.error('  3. Saved credentials file:')
      log.error(`     npx @capgo/cli build credentials save --appId ${appId} --platform ${platform}`)
      log.error('')
      log.error('Documentation:')
      log.error('  https://capgo.app/docs/cli/cloud-build/credentials/')
      throw new Error('No credentials found. Please provide credentials before building.')
    }
    // Validate platform-specific required credentials
    const missingCreds: string[] = []

    if (platform === 'ios') {
      const rawDistributionMode = mergedCredentials.CAPGO_IOS_DISTRIBUTION
      const validModes = ['app_store', 'ad_hoc'] as const
      if (rawDistributionMode && !validModes.includes(rawDistributionMode as any)) {
        missingCreds.push(`Invalid CAPGO_IOS_DISTRIBUTION value: '${rawDistributionMode}'. Must be one of: ${validModes.join(', ')}`)
      }
      const distributionMode = (rawDistributionMode && validModes.includes(rawDistributionMode as any))
        ? rawDistributionMode
        : 'app_store'
      if (!rawDistributionMode) {
        log.info('ℹ️  --ios-distribution not specified, defaulting to app_store')
      }
      // Write normalized value back so splitPayload picks it up
      mergedCredentials.CAPGO_IOS_DISTRIBUTION = distributionMode
      if (mergedCredentials.CAPGO_STORE_SUBMIT_REVIEW === 'true' && distributionMode !== 'app_store') {
        missingCreds.push('--submit-to-store-review on iOS requires --ios-distribution app_store')
      }

      // iOS minimum requirements (all modes)
      if (!mergedCredentials.BUILD_CERTIFICATE_BASE64)
        missingCreds.push('BUILD_CERTIFICATE_BASE64 (or --build-certificate-base64)')
      // Note: P12_PASSWORD is optional - certificates can have no password
      // But we warn if it's missing in case the user forgot
      if (!mergedCredentials.P12_PASSWORD) {
        log.warn('⚠️  P12_PASSWORD not provided - assuming certificate has no password')
        log.warn('   If your certificate requires a password, provide it with --p12-password')
      }

      // Legacy detection: old provisioning keys without new provisioning map
      const hasLegacyProvisioning = !!(mergedCredentials.BUILD_PROVISION_PROFILE_BASE64 || mergedCredentials.APPLE_PROFILE_NAME)
      if (hasLegacyProvisioning && !mergedCredentials.CAPGO_IOS_PROVISIONING_MAP) {
        log.error('❌ Legacy provisioning profile format detected. Run:')
        log.error('     npx @capgo/cli build credentials migrate --platform ios')
        log.error('')
        log.error('   This will convert your existing provisioning profile to the new multi-target format.')
        throw new Error('Legacy provisioning profile format detected. Run: npx @capgo/cli build credentials migrate --platform ios')
      }

      if (!mergedCredentials.CAPGO_IOS_PROVISIONING_MAP)
        missingCreds.push('CAPGO_IOS_PROVISIONING_MAP (use --ios-provisioning-profile or save via "build credentials save")')

      // Upload auth: app_store mode needs either an App Store Connect API key OR
      // an Apple ID + app-specific password (e.g. migrated Ionic Appflow apps).
      if (distributionMode === 'app_store') {
        const hasAppleKeyId = !!mergedCredentials.APPLE_KEY_ID
        const hasAppleIssuerId = !!mergedCredentials.APPLE_ISSUER_ID
        const hasAppleKeyContent = !!mergedCredentials.APPLE_KEY_CONTENT
        const anyAppleApiField = hasAppleKeyId || hasAppleIssuerId || hasAppleKeyContent
        const hasCompleteAppleApiKey = hasAppleKeyId && hasAppleIssuerId && hasAppleKeyContent

        // Apple ID + app-specific password is an alternative upload path. All three
        // fields are required together: fastlane needs the numeric app id (APPLE_APP_ID)
        // and would otherwise fall back to interactive 2FA login.
        const hasFastlaneUser = !!mergedCredentials.FASTLANE_USER
        const hasAppSpecificPassword = !!mergedCredentials.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD
        const hasAppleAppId = !!mergedCredentials.APPLE_APP_ID
        const anyAppSpecificField = hasFastlaneUser || hasAppSpecificPassword || hasAppleAppId
        const hasCompleteAppSpecificPassword = hasFastlaneUser && hasAppSpecificPassword && hasAppleAppId

        if (mergedCredentials.CAPGO_STORE_SUBMIT_REVIEW === 'true' && !hasCompleteAppleApiKey) {
          missingCreds.push('App Store Connect API key (APPLE_KEY_ID/APPLE_ISSUER_ID/APPLE_KEY_CONTENT) is required for --submit-to-store-review on iOS')
        }

        // APPLE_APP_ID is the app's numeric App Store Connect id; a non-numeric
        // value would make the headless TestFlight upload fail with a cryptic
        // fastlane error, so reject it early here (covers CLI, env, and saved creds).
        if (hasAppleAppId && !/^\d+$/.test(String(mergedCredentials.APPLE_APP_ID).trim())) {
          missingCreds.push('APPLE_APP_ID must be the app\'s numeric App Store Connect id (digits only, e.g. 1234567890)')
        }

        if (hasCompleteAppleApiKey) {
          // App Store Connect API key present — default upload path, nothing to add.
        }
        else if (hasCompleteAppSpecificPassword) {
          log.info('🔑 Using Apple ID + app-specific password for TestFlight upload (no App Store Connect API key)')
          log.info('   Build number will use a timestamp-based fallback (App Store Connect is not queried)')
          // Warn on standalone `build request` only (never during the onboarding
          // wizard, which sets builderJourneyId): the app-specific password path is
          // a discouraged Appflow-migration fallback. An App Store Connect API key
          // (.p8) is the recommended, more capable, and more secure option.
          if (!options.builderJourneyId) {
            log.warn('⚠️  App-specific password authentication is not recommended; it exists as an Ionic Appflow migration fallback.')
            log.warn('   Prefer an App Store Connect API key (.p8): https://capgo.app/docs/builder/configuration/')
          }
        }
        else if (anyAppSpecificField) {
          // Partial app-specific password — tell the user exactly which fields are missing
          const missingAppSpecificFields: string[] = []
          if (!hasFastlaneUser)
            missingAppSpecificFields.push('FASTLANE_USER (or --apple-id)')
          if (!hasAppSpecificPassword)
            missingAppSpecificFields.push('FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD (or --apple-app-specific-password)')
          if (!hasAppleAppId)
            missingAppSpecificFields.push('APPLE_APP_ID (or --apple-app-id)')
          missingCreds.push(`Incomplete app-specific password credentials - missing: ${missingAppSpecificFields.join(', ')}`)
        }
        else if (anyAppleApiField) {
          // Partial API key — tell the user exactly which fields are missing
          const missingAppleFields: string[] = []
          if (!hasAppleKeyId)
            missingAppleFields.push('APPLE_KEY_ID (or --apple-key-id)')
          if (!hasAppleIssuerId)
            missingAppleFields.push('APPLE_ISSUER_ID (or --apple-issuer-id)')
          if (!hasAppleKeyContent)
            missingAppleFields.push('APPLE_KEY_CONTENT (or --apple-key-content)')
          missingCreds.push(`Incomplete App Store Connect API key - missing: ${missingAppleFields.join(', ')}`)
        }
        else if (mergedCredentials.BUILD_OUTPUT_UPLOAD_ENABLED !== 'true') {
          missingCreds.push('App Store Connect API key (APPLE_KEY_ID/APPLE_ISSUER_ID/APPLE_KEY_CONTENT) or app-specific password (FASTLANE_USER + FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD + APPLE_APP_ID) or BUILD_OUTPUT_UPLOAD_ENABLED=true (or --output-upload) (build has no output destination - enable either TestFlight upload or Capgo download link)')
        }
        else if (mergedCredentials.SKIP_BUILD_NUMBER_BUMP !== 'true' || mergedCredentials.SKIP_MARKETING_VERSION_BUMP !== 'true') {
          missingCreds.push('App Store Connect API key (APPLE_KEY_ID/APPLE_ISSUER_ID/APPLE_KEY_CONTENT) or app-specific password or --skip-build-number-bump and --skip-marketing-version-bump (iOS versions cannot be auto-incremented without App Store Connect credentials)')
        }
        else {
          log.warn('⚠️  No App Store Connect API key or app-specific password provided - build will succeed but cannot auto-upload to TestFlight')
        }
      }
      else if (distributionMode === 'ad_hoc') {
        // ad_hoc: no API key required. TestFlight upload skipped automatically.
        // Build number falls back to timestamp-based increment.
        log.info('📦 Ad-hoc distribution mode: App Store Connect API key not required')
        log.info('   Build number will use timestamp-based fallback')
      }

      if (!mergedCredentials.APP_STORE_CONNECT_TEAM_ID)
        missingCreds.push('APP_STORE_CONNECT_TEAM_ID (or --app-store-connect-team-id)')
    }
    else if (platform === 'android') {
      // Android minimum requirements
      if (!mergedCredentials.ANDROID_KEYSTORE_FILE)
        missingCreds.push('ANDROID_KEYSTORE_FILE (or --android-keystore-file)')
      if (!mergedCredentials.KEYSTORE_KEY_ALIAS)
        missingCreds.push('KEYSTORE_KEY_ALIAS (or --keystore-key-alias)')

      // For Android, we need at least one password (will be used for both if only one provided)
      // The merging logic above handles using one password for both
      if (!mergedCredentials.KEYSTORE_KEY_PASSWORD && !mergedCredentials.KEYSTORE_STORE_PASSWORD)
        missingCreds.push('KEYSTORE_KEY_PASSWORD or KEYSTORE_STORE_PASSWORD (at least one password required)')

      // PLAY_CONFIG_JSON is optional for build, but required for upload to Play Store
      if (!mergedCredentials.PLAY_CONFIG_JSON) {
        if (mergedCredentials.CAPGO_STORE_SUBMIT_REVIEW === 'true') {
          missingCreds.push('PLAY_CONFIG_JSON is required for --submit-to-store-review on Android')
        }
        else if (mergedCredentials.BUILD_OUTPUT_UPLOAD_ENABLED !== 'true') {
          missingCreds.push('PLAY_CONFIG_JSON or BUILD_OUTPUT_UPLOAD_ENABLED=true (build has no output destination - enable either Play Store upload or Capgo download link)')
        }
        else {
          log.warn('⚠️  PLAY_CONFIG_JSON not provided - build will succeed but cannot auto-upload to Play Store')
        }
      }
    }

    if (missingCreds.length > 0) {
      log.error(`❌ Missing required credentials for ${platform}:`)
      log.error('')
      for (const cred of missingCreds) {
        log.error(`  • ${cred}`)
      }
      log.error('')
      log.error('Provide credentials via:')
      log.error(`  1. CLI arguments: npx @capgo/cli build request --platform ${platform} ${platform === 'ios' ? '--apple-key-id "..." --apple-issuer-id "..." --apple-key-content "..."' : '--android-keystore-file "..." --keystore-key-alias "..."'}`)
      log.error(`  2. Environment variables: ${platform === 'ios' ? 'export APPLE_KEY_ID="..." APPLE_ISSUER_ID="..." APPLE_KEY_CONTENT="..."' : 'export ANDROID_KEYSTORE_FILE="..." KEYSTORE_KEY_ALIAS="..."'}`)
      log.error(`  3. Saved credentials: npx @capgo/cli build credentials save --platform ${platform} ...`)
      log.error('')
      log.error('Documentation:')
      log.error(`  https://capgo.app/docs/cli/cloud-build/${platform}/`)
      throw new Error(`Missing required credentials for ${platform}: ${missingCreds.join(', ')}`)
    }

    // Log defaults for output control fields when not explicitly set
    if (!options.buildMode) {
      log.info('ℹ️  --build-mode not specified, defaulting to release')
    }
    if (!mergedCredentials.BUILD_OUTPUT_UPLOAD_ENABLED) {
      log.info('ℹ️  --output-upload not specified, defaulting to false (no Capgo download link)')
    }
    if (!mergedCredentials.BUILD_OUTPUT_RETENTION_SECONDS) {
      log.info(`ℹ️  --output-retention not specified, defaulting to ${MIN_OUTPUT_RETENTION_SECONDS}s (1 hour)`)
    }
    // The generic "auto-incremented" note only applies when the build number is
    // managed via App Store Connect (needs an API key) or for Android. iOS uploads
    // using an app-specific password or ad_hoc distribution use a timestamp-based
    // fallback (already logged above), so skip the otherwise-contradictory message.
    const iosWithoutApiKey = platform === 'ios'
      && !(mergedCredentials.APPLE_KEY_ID && mergedCredentials.APPLE_ISSUER_ID && mergedCredentials.APPLE_KEY_CONTENT)
    if (!mergedCredentials.SKIP_BUILD_NUMBER_BUMP && !iosWithoutApiKey) {
      log.info('ℹ️  --skip-build-number-bump not specified, build number will be auto-incremented (default)')
    }
    if (!mergedCredentials.SKIP_MARKETING_VERSION_BUMP && platform === 'ios' && !iosWithoutApiKey) {
      log.info('ℹ️  --skip-marketing-version-bump not specified, marketing version will be auto-bumped when already released (default)')
    }

    const { buildOptions: buildOptionsPayload, buildCredentials: buildCredentialsPayload } = splitPayload(
      mergedCredentials,
      platform,
      options.buildMode || 'release',
      pack.version,
    )

    const requestPayload = {
      app_id: appId,
      platform,
      build_mode: options.buildMode || 'release',
      build_options: buildOptionsPayload,
      build_credentials: buildCredentialsPayload,
    }

    log.info('✓ Using credentials (merged from CLI args, env vars, and saved file)')
    if (verbose) {
      const credentialKeys = Object.keys(buildCredentialsPayload)
      log.info(`Credentials provided: ${credentialKeys.join(', ')}`)
      log.info(`Build options: platform=${buildOptionsPayload.platform}, mode=${buildOptionsPayload.buildMode}, cliVersion=${buildOptionsPayload.cliVersion}`)
    }

    // ---- prescan gate (see src/build/prescan/) ----
    // Opt-in: runs only when options.prescan === true, which ONLY the `build request` CLI
    // command sets (requestBuildCommand). The onboarding wizard (build init), MCP build tools,
    // and the SDK call requestBuildInternal without it, so prescan never runs on those paths.
    // Runs BEFORE the POST /build/request: a blocked prescan must not orphan a
    // created-but-never-uploaded build job server-side (stuck "pending" row in
    // the dashboard + skewed "Build requested" telemetry).
    if (options.prescan === true) {
      const { executePrescan, runPrescanGate } = await import('./prescan/command')
      const { decision: gateDecision, report: gateReport, crashed: gateCrashed } = await runPrescanGate(
        {
          enabled: true,
          ignoreFatal: options.prescanIgnoreFatal,
          failOnWarnings: options.failOnWarnings,
          silent,
          // Route output through the BuildLogger: Ink onboarding / SDK / MCP stdio
          // callers own the terminal — raw clack writes would corrupt it.
          print: msg => log.info(msg),
          warn: msg => log.warn(msg),
        },
        // The gate only needs the report; the apikey in PrescanExecution is for
        // the standalone command's telemetry (request.ts sends its own events).
        // Pass mergedCredentials so the scan validates the exact credential set the
        // build will use (CLI flags + env + saved file), not a fresh re-merge that
        // would miss flag overrides; flavor/distribution fall back to the merged
        // CAPGO_ANDROID_FLAVOR / CAPGO_IOS_DISTRIBUTION inside buildScanContext.
        async () => (await executePrescan(appId, {
          platform,
          path: projectDir,
          apikey: options.apikey,
          credentials: mergedCredentials as Record<string, string>,
          androidFlavor: options.androidFlavor,
          iosDist: options.iosDistribution,
          supaHost: options.supaHost,
          supaAnon: options.supaAnon,
        })).report,
      )
      // Telemetry: emit one `Prescan run` event for the build-request gate on EVERY
      // outcome (clean / warned / blocked / bypassed / crashed) so PostHog sees the full
      // funnel — run volume, block rate, and which checks fire — not just blocks.
      {
        const pc = gateReport?.counts
        const prescanResult = gateCrashed
          ? 'crashed'
          : !pc
              ? 'skipped'
              : pc.error > 0
                  ? (options.prescanIgnoreFatal ? 'bypassed' : 'blocked')
                  : pc.warning > 0 ? (options.failOnWarnings ? 'blocked' : 'warned') : 'clean'
        await sendEvent(options.apikey, {
          channel: 'native-builder',
          event: 'Prescan run',
          icon: '🛡️',
          org_id: orgId,
          tracking_version: 2,
          tags: {
            'source': 'build-request',
            'result': prescanResult,
            'app-id': appId,
            'platform': platform,
            'errors': String(pc?.error ?? 0),
            'warnings': String(pc?.warning ?? 0),
            'finding-ids': gateReport ? gateReport.findings.filter(finding => finding.severity !== 'info').map(finding => finding.id).join(',').slice(0, 200) : '',
            'bypassed': String(prescanResult === 'bypassed'),
          },
          notify: false,
        }).catch(() => {})
      }
      if (gateDecision === 'block') {
        // Thrown (not exit(1)) so requestBuildInternal keeps its no-exit contract for SDK
        // callers: the outer catch logs the message and returns { success: false }, and
        // requestBuildCommand turns that into exit code 1.
        throw new Error('Prescan found blocking problems — the build was not requested and nothing was uploaded. Fix the errors above or re-run with --prescan-ignore-fatal / --no-prescan.')
      }
    }

    // Permission backstop. Prescan's shared/apikey-permission check normally surfaces a
    // missing build permission first — batched with every other problem — and blocks above.
    // This hard assert still runs when prescan is skipped (--no-prescan) or bypassed
    // (--prescan-ignore-fatal), so permission is always enforced before the POST.
    await assertCliPermission(supabase, options.apikey, 'app.build_native', { appId }, {
      message: `Insufficient permissions to request a native build for app ${appId}`,
      silent,
    })

    // Request build from Capgo backend (POST /build/request)
    log.info('Requesting build from Capgo...')

    const maxRetries = 3
    const response = await fetchWithRetry(
      `${host}/build/request`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': options.apikey,
        },
        body: JSON.stringify(requestPayload),
      },
      maxRetries,
      log,
    )

    if (!response.ok) {
      const errorText = await response.text()
      await throwIfBuildPlanLimitError(response.status, errorText, 'request', log)
      throw new Error(`Failed to request build: ${response.status} - ${errorText}`)
    }

    const buildRequest = await response.json() as {
      job_id: string
      upload_url: string
      upload_expires_at: string
      status: string
    }

    log.success(`Build job created: ${buildRequest.job_id}`)
    log.info(`Status: ${buildRequest.status}`)
    if (verbose) {
      log.info(`Upload URL: ${buildRequest.upload_url}`)
      log.info(`Upload expires: ${buildRequest.upload_expires_at}`)
    }

    // --- /tmp log capture setup ---
    // Capture when interactive (so the on-failure menu has logs to send) OR when
    // --ai-analytics is set in CI (so auto-upload has logs to send). Without the
    // flag-OR, the CI auto_upload branch from decideAnalyzeBehavior would never
    // have a log file to read.
    const aiAnalysisMode: 'auto-prompt' | 'caller-handled' | 'skip' = options.aiAnalysisMode ?? 'auto-prompt'
    // Effective "upload logs to support" intent: honor both the primary
    // --send-logs-to-support flag and the deprecated --send-logs alias so the
    // original 8.16.0 flag keeps working. Use this everywhere instead of reading
    // options.sendLogs directly.
    const wantsSendLogsToSupport = options.sendLogsToSupport === true || options.sendLogs === true
    // Capture when interactive, when the CI flag is set, OR when the caller asked
    // to drive the AI flow themselves (e.g. Ink onboarding) so the captured log
    // is available for runCapgoAiAnalysis.
    const captureEnabled = (shouldCaptureLogs() || options.aiAnalytics === true || wantsSendLogsToSupport || aiAnalysisMode === 'caller-handled')
      && aiAnalysisMode !== 'skip'
    let capturedJobId: string | null = null
    let keepPromptFile = false // mutable so local-AI flow can set it true
    // Populated only in caller-handled mode on a failed build. Returned to the
    // caller so it can render its own AI prompt UI and later release the log.
    let aiAnalysisInfo: BuildRequestResult['aiAnalysis']

    if (captureEnabled && buildRequest.job_id) {
      capturedJobId = buildRequest.job_id
      await startCaptureForJob(buildRequest.job_id)
      registerCleanupHandlers(buildRequest.job_id, () => keepPromptFile)
    }

    // Wrap the logger so every buildLog line is also captured to /tmp
    const captureWrappedLogger: BuildLogger = {
      ...log,
      buildLog: (msg: string) => {
        log.buildLog(msg)
        if (captureEnabled && capturedJobId) {
          void appendCapturedLine(capturedJobId, msg)
        }
      },
    }
    // --- end Task 19 ---

    // Send analytics event for build request
    await sendEvent(options.apikey, {
      channel: 'native-builder',
      event: 'Build requested',
      icon: '🏗️',
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': appId,
        'platform': platform,
        // Present only for onboarding-initiated builds — correlates this build
        // with the rest of the journey's events.
        ...(options.builderJourneyId ? { journey_id: options.builderJourneyId } : {}),
      },
      notify: false,
    }).catch()

    // Create temporary directory for zip
    const tempDir = join(tmpdir(), `capgo-build-${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
    const zipPath = join(tempDir, `${basename(projectDir)}.zip`)

    try {
      // Zip the project directory
      log.info(`Zipping ${platform} project from ${projectDir}...`)

      await zipDirectory(projectDir, zipPath, platform, config?.config, {
        nodeModules: options.nodeModules,
      })

      const zipStats = await stat(zipPath)
      const sizeMB = (zipStats.size / 1024 / 1024).toFixed(2)

      log.success(`Created zip: ${zipPath} (${sizeMB} MB)`)

      // Upload to builder using TUS protocol
      log.info('Uploading to builder...')
      if (verbose) {
        log.info(`Upload endpoint: ${buildRequest.upload_url}`)
        log.info(`File size: ${sizeMB} MB`)
        log.info(`Job ID: ${buildRequest.job_id}`)
      }

      // Read zip file into buffer for TUS upload
      const zipBuffer = readFileSync(zipPath)

      // Upload using TUS protocol
      log.uploadProgress(0)

      const uploadStartedAt = Date.now()
      const buildModeForTelemetry = options.buildMode || 'release'
      void trackBuilderUpload({
        apikey: options.apikey,
        appId,
        orgId,
        platform,
        buildMode: buildModeForTelemetry,
        jobId: buildRequest.job_id,
        sizeBytes: zipStats.size,
        phase: 'started',
      })

      await new Promise<void>((resolve, reject) => {
        const upload = new tus.Upload(zipBuffer as any, {
          endpoint: buildRequest.upload_url,
          chunkSize: 5 * 1024 * 1024, // 5MB chunks
          retryDelays: [...TUS_UPLOAD_RETRY_DELAYS],
          metadata: {
            filename: basename(zipPath),
            filetype: 'application/zip',
          },
          headers: {
            authorization: options.apikey,
          },
          // Callback before request is sent
          onBeforeRequest(req) {
            if (verbose) {
              log.info(`[TUS] ${req.getMethod()} ${req.getURL()}`)
              const authHeader = req.getHeader('authorization')
              log.info(`[TUS] Authorization header present: ${!!authHeader}`)
            }
          },
          // Callback after response is received
          onAfterResponse(_req, res) {
            if (verbose) {
              log.info(`[TUS] Response status: ${res.getStatus()}`)
              const uploadOffset = res.getHeader('upload-offset')
              const tusResumable = res.getHeader('tus-resumable')
              log.info(`[TUS] Upload-Offset: ${uploadOffset}, Tus-Resumable: ${tusResumable}`)
            }
          },
          // Callback for errors which cannot be fixed using retries
          async onError(error) {
            await trackBuilderUpload({
              apikey: options.apikey,
              appId,
              orgId,
              platform,
              buildMode: buildModeForTelemetry,
              jobId: buildRequest.job_id,
              sizeBytes: zipStats.size,
              phase: 'failed',
              durationSeconds: (Date.now() - uploadStartedAt) / 1000,
              error,
            })
            log.error(`Upload error: ${error.message}`)
            if (error instanceof tus.DetailedError) {
              const body = error.originalResponse?.getBody()
              const status = error.originalResponse?.getStatus()
              const url = error.originalRequest?.getURL()

              if (verbose) {
                log.error(`[TUS] Request URL: ${url}`)
                log.error(`[TUS] Response status: ${status}`)
                log.error(`[TUS] Response body: ${body}`)
              }

              const errorMsg = (() => {
                try {
                  const jsonBody = JSON.parse(body || '{"error": "unknown error"}')
                  return jsonBody.status || jsonBody.error || jsonBody.message || 'unknown error'
                }
                catch {
                  return body || error.message
                }
              })()
              reject(new Error(`TUS upload failed: ${errorMsg}`))
            }
            else {
              reject(new Error(`TUS upload failed: ${error.message || error.toString()}`))
            }
          },
          // Callback for reporting upload progress
          onProgress(bytesUploaded, bytesTotal) {
            const percentage = Number.parseFloat(((bytesUploaded / bytesTotal) * 100).toFixed(2))
            log.uploadProgress(percentage)
          },
          // Callback for once the upload is completed
          onSuccess() {
            void trackBuilderUpload({
              apikey: options.apikey,
              appId,
              orgId,
              platform,
              buildMode: buildModeForTelemetry,
              jobId: buildRequest.job_id,
              sizeBytes: zipStats.size,
              phase: 'succeeded',
              durationSeconds: (Date.now() - uploadStartedAt) / 1000,
            })
            log.uploadProgress(100)
            if (verbose) {
              log.success('TUS upload completed successfully')
            }
            resolve()
          },
        })

        // Start the upload
        if (verbose)
          log.info('[TUS] Starting upload...')
        upload.start()
      })

      // Start the build job via Capgo backend
      log.info('Starting build job...')

      const startResponse = await fetch(`${host}/build/start/${buildRequest.job_id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': options.apikey,
        },
        body: JSON.stringify({ app_id: appId }),
      })

      if (!startResponse.ok) {
        const errorText = await startResponse.text()
        await throwIfBuildPlanLimitError(startResponse.status, errorText, 'start', log)
        throw new Error(`Failed to start build: ${startResponse.status} - ${errorText}`)
      }

      const startResult = await startResponse.json() as { status?: string, logs_url?: string, logs_token?: string }

      log.success('Build started!')
      log.info('Streaming build logs...')

      const abortController = new AbortController()
      let cancelRequested = false
      const cancelBuild = async () => {
        if (cancelRequested)
          return
        cancelRequested = true
        const cancelAbort = new AbortController()
        const timeout = setTimeout(() => cancelAbort.abort(), 4000)
        try {
          await fetch(`${host}/build/cancel/${buildRequest.job_id}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'authorization': options.apikey,
            },
            body: JSON.stringify({ app_id: appId }),
            signal: cancelAbort.signal,
          })
        }
        catch (err) {
          appendInternalLog(`build cancel request errored (ignored): ${err instanceof Error ? err.message : String(err)}`)
          // ignore cancellation errors
        }
        finally {
          clearTimeout(timeout)
        }
      }

      const onSigint = async () => {
        try {
          if (cancelRequested) {
            process.exit(1)
          }
          log.warn('Canceling build... (press Ctrl+C again to force quit)')
          await cancelBuild()
          abortController.abort()
        }
        catch {
          // Prevent unhandled rejection from crashing the process
        }
      }

      process.on('SIGINT', onSigint)

      let finalStatus: string
      // Stream logs from the build - returns final status if detected from stream
      let showStatusChecks = false
      const statusCheck = async (): Promise<string | null> => {
        try {
          const response = await fetch(`${host}/build/status?job_id=${encodeURIComponent(buildRequest.job_id)}&app_id=${encodeURIComponent(appId)}&platform=${platform}`, {
            headers: {
              authorization: options.apikey,
            },
          })
          if (!response.ok) {
            return null
          }
          const status = await response.json() as { status: string }
          const normalized = status.status?.toLowerCase?.() ?? ''
          if (showStatusChecks)
            log.info(`Build status: ${normalized || status.status}`)
          if (TERMINAL_STATUS_SET.has(normalized)) {
            return normalized
          }
          return null
        }
        catch {
          return null
        }
      }

      let streamStatus: string | null = null
      try {
        streamStatus = await streamBuildLogs(
          silent,
          verbose,
          startResult.logs_url,
          startResult.logs_token,
          statusCheck,
          abortController.signal,
          () => {
            showStatusChecks = true
          },
          // Force pass a logger whenever --output-record is set so the customMsg
          // wrapper that captures the artifact URL fires even in silent mode
          // without a user-supplied logger. Use captureWrappedLogger so AI log
          // capture still flows through.
          silent && !logger && !options.outputRecord ? undefined : captureWrappedLogger,
        )
      }
      finally {
        process.removeListener('SIGINT', onSigint)
      }

      // Only poll if we didn't get the final status from the stream
      if (streamStatus) {
        finalStatus = streamStatus
        // Persist terminal status to the database via /build/status.
        // The WebSocket only delivers status to the CLI — calling the API
        // endpoint triggers the backend to write status + last_error into build_requests.
        if (TERMINAL_STATUS_SET.has(streamStatus))
          await statusCheck().catch(() => {})
      }
      else {
        // Fall back to polling if stream ended without final status
        finalStatus = await pollBuildStatus(host, buildRequest.job_id, appId, platform, options.apikey, silent, showStatusChecks, abortController.signal, log)
      }

      if (finalStatus === 'succeeded') {
        log.success(`Build completed successfully!`)
      }
      else if (finalStatus === 'failed') {
        log.error(`Build failed`)
        // Non-interactive (CI/CD) failure with neither --ai-analytics nor
        // --send-logs: surface the discoverability tip here, INDEPENDENT of log
        // capture. The in-handler AI/decideCiFailureActions block below is gated
        // behind captureEnabled, which is false in exactly this case, so the tip
        // would otherwise never print. Interactive terminals use the clack menu;
        // if either flag is set the corresponding action runs and no tip is wanted.
        if (shouldPrintCiTip({
          isTTY: process.stdout.isTTY === true,
          aiAnalytics: options.aiAnalytics === true,
          sendLogs: wantsSendLogsToSupport,
        })) {
          process.stderr.write(`${CI_FAILURE_TIP}\n`)
        }
      }
      else {
        log.warn(`Build finished with status: ${finalStatus}`)
      }

      // On success, write the optional build-output record (added by main).
      if (options.outputRecord && finalStatus === 'succeeded') {
        try {
          const record = await writeBuildOutputRecord(
            options.outputRecord,
            {
              jobId: buildRequest.job_id,
              appId,
              platform,
              buildMode: (options.buildMode ?? 'release') as 'debug' | 'release',
              status: finalStatus,
              outputUrl: capturedOutputUrl,
            },
            (msg: string) => log.warn(msg),
          )
          log.success(`Build output record written to ${options.outputRecord}`)
          if (!record.outputUrl)
            log.info('ℹ️  Record contains no download URL — pass --output-upload to publish one.')
          if (record.qrCodePngPath)
            log.info(`ℹ️  QR code PNG written to ${record.qrCodePngPath}`)
        }
        catch (error) {
          log.warn(`Failed to write build output record to ${options.outputRecord}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // On failure, offer the AI analysis flow.
      //
      // - 'skip'           → no-op (caller wants nothing to do with AI here).
      // - 'caller-handled' → leave the captured log on disk and surface it via
      //                      `result.aiAnalysis` so the caller (e.g. the Ink
      //                      onboarding wizard) can run `runCapgoAiAnalysis`
      //                      and render its own UI without clack corrupting
      //                      its terminal renderer.
      // - 'auto-prompt'    → existing interactive / CI matrix via
      //                      decideAnalyzeBehavior + clack prompts.
      if (finalStatus === 'failed' && captureEnabled && capturedJobId && aiAnalysisMode === 'caller-handled') {
        // Preserve the captured log until the caller calls
        // releaseCapturedLogs(jobId) explicitly. Without this, the cleanup
        // handlers registered above would remove it on process exit before
        // the caller had a chance to read it.
        keepPromptFile = true
        const logsPath = `${process.env.CAPGO_AI_LOG_BASE_DIR || '/tmp/capgo-builds'}/${capturedJobId}.log`
        aiAnalysisInfo = {
          jobId: capturedJobId,
          capturedLogPath: logsPath,
          ready: true,
        }
      }
      else if (finalStatus === 'failed' && captureEnabled && capturedJobId && aiAnalysisMode === 'auto-prompt') {
        const behavior = decideAnalyzeBehavior({
          isTTY: process.stdout.isTTY === true,
          aiAnalyticsFlag: options.aiAnalytics === true,
          sendLogsFlag: wantsSendLogsToSupport,
        })

        const AI_WARNING = '⚠ AI can make mistakes. Always verify the diagnosis against the full log before applying the suggested fix.'


        const runCapgoAi = async (choice: 'capgo_ai' | 'auto_upload', triggeredBy: 'menu' | 'ci_flag'): Promise<void> => {
          await trackAiAnalysisChoice({
            apikey: options.apikey,
            orgId,
            appId,
            platform,
            jobId: capturedJobId!,
            choice,
            triggeredBy,
          })

          // Additive support-log upload: when the user opts into Capgo AI from
          // the interactive menu, ALSO offer to upload their logs so support can
          // follow up by email. This is UPLOAD-ONLY (no mailto) and runs BEFORE
          // the analysis; it's best-effort and never blocks the AI step. CI /
          // auto_upload paths skip it (no human to ask).
          if (triggeredBy === 'menu') {
            await offerSupportUploadBeforeAi({
              confirm: async (message) => {
                const answer = await confirm({ message, initialValue: true })
                return answer === true
              },
              buildFiles: () => {
                const s = spinnerC()
                s.start('Preparing your logs to send to Capgo support…')
                try {
                  let internalLines: string[] = []
                  const internalLogPath = getInternalLogPath()
                  if (internalLogPath) {
                    try { internalLines = readFileSync(internalLogPath, 'utf8').split('\n') }
                    catch { /* best-effort */ }
                  }
                  let buildLogLines: string[] = []
                  try {
                    const logsPath = `${process.env.CAPGO_AI_LOG_BASE_DIR || '/tmp/capgo-builds'}/${capturedJobId}.log`
                    buildLogLines = readFileSync(logsPath, 'utf8').split('\n')
                  }
                  catch { /* best-effort */ }
                  const built = writeSupportBundleFiles({
                    kind: 'build-request',
                    appId,
                    error: `Cloud build ${capturedJobId} failed`,
                    logs: buildLogLines,
                    sections: internalLines.length > 0 ? [{ title: 'Internal log', lines: internalLines }] : [],
                  })
                  s.stop(built ? 'Logs ready.' : 'Couldn\'t prepare logs.')
                  return built
                }
                catch {
                  s.stop('Couldn\'t prepare logs.')
                  return null
                }
              },
              upload: async (gzPath) => {
                const s = spinnerC()
                s.start('Uploading your logs to Capgo support…')
                const r = await uploadSupportLogs({ apiHost: host, apikey: options.apikey, appId, jobId: capturedJobId ?? undefined, gzPath })
                s.stop(r ? 'Logs uploaded.' : 'Logs upload unavailable.')
                return r
              },
              print: msg => clackLog.info(msg),
            })
          }

          const logsPath = `${process.env.CAPGO_AI_LOG_BASE_DIR || '/tmp/capgo-builds'}/${capturedJobId}.log`
          let logs = ''
          try {
            const { readFile } = await import('node:fs/promises')
            logs = await readFile(logsPath, 'utf8')
          }
          catch (err) {
            // Don't crash the CLI on a missing/unreadable log file, but DO tell
            // the user why we're bailing — otherwise the auto_upload path
            // silently no-ops and it looks like nothing happened.
            const msg = err instanceof Error ? err.message : String(err)
            process.stderr.write(`AI analysis skipped: could not read captured log at ${logsPath}: ${msg}\n`)
            return
          }

          // Spinner only when interactive — in CI it'd just dump noise.
          const isInteractive = process.stdout.isTTY === true
          const stream = isInteractive ? process.stdout : process.stderr
          const aiSpinner = isInteractive ? spinnerC() : null
          // @clack/prompts spinner appends its own animated dots — don't add an
          // ellipsis here or the user sees "…..." (6 dots: our 1-char ellipsis
          // plus the spinner's cycling 3-dot animation).
          aiSpinner?.start('Analyzing build log with Capgo AI')

          let printedHeader = false
          // Progressive TTY rendering goes through the streaming markdown
          // renderer so headers/lists/code bars appear styled as lines
          // complete — output is byte-identical to the buffered
          // renderMarkdown of the full text (see stream-markdown.ts).
          const mdStream = isInteractive ? createStreamingMarkdownRenderer(t => stream.write(t), true) : null
          const onChunk = isInteractive
            ? (text: string) => {
                if (!printedHeader) {
                  aiSpinner?.stop('Capgo AI streaming')
                  stream.write('\n--- AI analysis ---\n')
                  printedHeader = true
                }
                mdStream!.feed(text)
              }
            : undefined

          let result: PostAnalyzeResult
          try {
            result = await postAnalyzeStreamRequest({
              apiHost: host,
              apikey: options.apikey,
              jobId: capturedJobId!,
              appId,
              logs,
              onChunk,
            })
          }
          finally {
            if (!printedHeader)
              aiSpinner?.stop('Capgo AI finished')
          }

          // Telemetry — closed-enum result only, never the analysis text.
          const resultTag = aiAnalysisResultFromPostAnalyze(result)
          await trackAiAnalysisResult({
            apikey: options.apikey,
            orgId,
            appId,
            platform,
            jobId: capturedJobId!,
            result: resultTag,
            errorStatus: result.kind === 'error' ? result.status : undefined,
          })

          if (result.kind === 'ok') {
            if (printedHeader) {
              // TTY already rendered the text progressively — render the
              // trailing line, then close out.
              mdStream?.flush()
              stream.write(`\n\n${AI_WARNING}\n`)
            }
            else {
              // CI: buffered output, identical format to the pre-streaming CLI.
              stream.write(`\n--- AI analysis ---\n${renderMarkdown(result.analysis, isInteractive)}\n\n${AI_WARNING}\n`)
            }
          }
          else if (result.kind === 'already_analyzed') {
            stream.write('\nAI analysis already requested for this job (only one per job).\n')
          }
          else if (result.kind === 'too_big') {
            stream.write('\nLog too big for AI analysis.\n')
          }
          else if (result.kind === 'upgrade_required') {
            stream.write(`\n${result.message ?? 'AI build analysis requires a newer CLI. Please upgrade: npx @capgo/cli@latest'}\n`)
          }
          else {
            if (printedHeader)
              mdStream?.flush() // show whatever partial lines completed before the interruption
            else if (result.partial)
              stream.write(`\n--- AI analysis (partial) ---\n${renderMarkdown(result.partial, isInteractive)}\n`)
            stream.write(`\nAI analysis was interrupted${result.message ? ` (${result.message})` : ''}; this job's analysis slot is used. The full log is saved at ${logsPath} for local AI.\n`)
          }
        }

        const runLocalAi = async (): Promise<void> => {
          await trackAiAnalysisChoice({
            apikey: options.apikey,
            orgId,
            appId,
            platform,
            jobId: capturedJobId!,
            choice: 'local_ai',
            triggeredBy: 'menu',
          })
          const promptPath = await writeLocalAiFile(capturedJobId!)
          keepPromptFile = true
          process.stdout.write(`\nSaved prompt to ${promptPath}\nPoint your local AI (Claude, Codex, aider, etc.) at this file.\n${AI_WARNING}\n`)
        }

        const emitSkipChoice = async (): Promise<void> => {
          await trackAiAnalysisChoice({
            apikey: options.apikey,
            orgId,
            appId,
            platform,
            jobId: capturedJobId!,
            choice: 'skip',
            triggeredBy: (behavior === 'auto_upload' || behavior === 'skip') ? 'ci_flag' : 'menu',
          })
        }

        // Spec: at a build failure, "Email Capgo support" comes first — the same
        // contact-support flow as the onboarding wizard, with clack-flavored deps.
        // Shared bundle prep for both the interactive email flow and the CI/CD
        // --send-logs flow: read the internal log + the full persisted build log
        // (both best-effort) and render/gzip them into a support bundle. The
        // bundle is gzipped + uploaded/attached, so size isn't a concern here —
        // support needs the full build log, not a tail.
        const prepareSupportLogBundle = ({
          capturedJobId,
          appId,
        }: {
          capturedJobId: string | null
          appId: string
        }): SupportBundleFiles | null => {
          const internalLogPath = getInternalLogPath()
          let internalLines: string[] = []
          if (internalLogPath) {
            try {
              internalLines = readFileSync(internalLogPath, 'utf8').split('\n')
            }
            catch { /* best-effort */ }
          }
          let buildLogLines: string[] = []
          try {
            const logsPath = `${process.env.CAPGO_AI_LOG_BASE_DIR || '/tmp/capgo-builds'}/${capturedJobId}.log`
            buildLogLines = readFileSync(logsPath, 'utf8').split('\n')
          }
          catch { /* best-effort */ }
          return writeSupportBundleFiles({
            kind: 'build-request',
            appId,
            error: `Cloud build ${capturedJobId} failed`,
            logs: buildLogLines,
            sections: internalLines.length > 0 ? [{ title: 'Internal log', lines: internalLines }] : [],
          })
        }

        const runEmailSupport = async (): Promise<void> => {
          await contactSupport({
            subject: `Capgo Builder support — ${appId} (${platform})`,
            body: `Hi Capgo team,\n\nMy cloud build failed and I'd like help.\n\nApp: ${appId}\nPlatform: ${platform}\nJob: ${capturedJobId}`,
            confirm: async (msg, logPath) => {
              for (;;) {
                const choice = await select({
                  message: msg,
                  options: [
                    { value: 'yes', label: '📨  Yes, send to support' },
                    { value: 'view', label: '👀  View logs first (opens the file)' },
                    { value: 'no', label: '✖  Cancel' },
                  ],
                })
                if (clackIsCancel(choice) || choice === 'no')
                  return false
                if (choice === 'view') {
                  clackLog.info(`Logs to be sent: ${logPath}`)
                  try { (await import('open')).default(logPath) }
                  catch { /* best-effort: just the path above */ }
                  continue
                }
                return true
              }
            },
            buildFiles: () => {
              // The build log can be large; show a spinner while we render + gzip
              // (and trim to fit the 10 MB cap) so it doesn't look frozen.
              const s = spinnerC()
              s.start('Preparing your logs to send…')
              try {
                const built = prepareSupportLogBundle({ capturedJobId, appId })
                s.stop(built ? 'Logs ready.' : 'Couldn\'t prepare logs.')
                return built
              }
              catch {
                s.stop('Couldn\'t prepare logs.')
                return null
              }
            },
            copyPath: p => copyToClipboard(p).ok,
            reveal: p => revealInFinder(p),
            openUrl: async u => (await import('open')).default(u),
            print: msg => clackLog.info(msg),
            upload: async (gzPath) => {
              const s = spinnerC()
              s.start('Uploading your logs to Capgo support…')
              const r = await uploadSupportLogs({ apiHost: host, apikey: options.apikey, appId, jobId: capturedJobId ?? undefined, gzPath })
              s.stop(r ? 'Logs uploaded.' : 'Logs upload unavailable — falling back to attaching the file.')
              return r
            },
          })
        }

        // CI/CD --send-logs: build the SAME support bundle the interactive email
        // flow uses (writeSupportBundleFiles → gz under the 10 MB cap), then
        // upload it to Capgo support via uploadSupportLogs. We can't send email
        // from CI — only upload — so there's no mailto here. Never crashes the
        // process or changes the exit code: any failure prints a graceful note
        // pointing at support@capgo.app.
        const runSendLogs = async (): Promise<void> => {
          const files = prepareSupportLogBundle({ capturedJobId, appId })
          if (!files) {
            process.stderr.write(`Could not prepare your build logs to upload. Please email support@capgo.app and describe the issue (job ${capturedJobId}).\n`)
            return
          }

          const uploaded = await uploadSupportLogs({
            apiHost: host,
            apikey: options.apikey,
            appId,
            jobId: capturedJobId ?? undefined,
            gzPath: files.gzPath,
          })
          if (uploaded) {
            process.stderr.write(`Build logs uploaded to Capgo support automatically. Our team has been notified and will contact you by email soon.\nReference: ${uploaded.url}\n`)
          }
          else {
            process.stderr.write(`Could not upload your build logs automatically. Please email support@capgo.app and describe the issue (job ${capturedJobId}).\n`)
          }
        }

        async function showMenu(): Promise<void> {
          if (await isLogTooBig(capturedJobId!)) {
            process.stdout.write('Log too big for AI analysis (>10 MB). Offering local AI instead.\n')
            await runLocalAi()
            return
          }
          const choice = await select({
            message: 'Build failed — get help or analyze the log',
            options: [
              { value: 'support', label: '📨  Email Capgo support' },
              { value: 'capgo', label: '🤖  Capgo AI' },
              { value: 'local', label: 'Local AI (write prompt to file)' },
              { value: 'skip', label: 'Skip' },
            ],
          })
          if (choice === 'support')
            await runEmailSupport()
          else if (choice === 'capgo')
            await runCapgoAi('capgo_ai', 'menu')
          else if (choice === 'local')
            await runLocalAi()
          else
            await emitSkipChoice()
        }

        try {
          if (behavior === 'skip' || behavior === 'auto_upload') {
            // Direct-action path: 'auto_upload' (an explicit --ai-analytics
            // and/or --send-logs opt-in, in ANY terminal) or 'skip' (no flags,
            // non-interactive). --ai-analytics and --send-logs are independent
            // and additive: run whichever the user opted into, never prompt.
            // The neither-flag discoverability tip is NOT emitted here - it is
            // printed at the build-failure point (see shouldPrintCiTip above),
            // because reaching this block requires captureEnabled, which is
            // false in the exact non-interactive + neither-flag case the tip is
            // for. decideCiFailureActions is the pure, unit-tested seam.
            const actions = decideCiFailureActions({
              aiAnalyticsFlag: options.aiAnalytics === true,
              sendLogsFlag: wantsSendLogsToSupport,
            })
            if (actions.sendLogs)
              await runSendLogs()
            if (actions.runAiAnalysis) {
              if (await isLogTooBig(capturedJobId)) {
                process.stderr.write('Log too big for AI analysis (>10 MB), skipping\n')
                await emitSkipChoice()
              }
              else {
                await runCapgoAi('auto_upload', 'ci_flag')
              }
            }
          }
          else {
            // No flags + interactive terminal: ask_then_menu. (auto_upload and
            // skip are handled above; show_menu no longer exists - an explicit
            // --ai-analytics/--send-logs opt-in now resolves to auto_upload and
            // runs directly without prompting, in any terminal.)
            const wants = await confirm({ message: 'Build failed. See help options (email Capgo support / AI analysis)?' })
            if (!wants || typeof wants === 'symbol') {
              // user cancelled or declined: skip
              await emitSkipChoice()
            }
            else {
              await showMenu()
            }
          }
        }
        catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          appendInternalLog(`AI analysis flow errored: ${msg}`)
          process.stderr.write(`AI analysis flow errored: ${msg}\n`)
        }
      }

      // Calculate build time (in seconds with 2 decimal places, matching upload behavior)
      const buildTime = ((Date.now() - buildStartTime) / 1000).toFixed(2)

      // Send analytics event for build result (includes build time)
      await sendEvent(options.apikey, {
        channel: 'native-builder',
        event: finalStatus === 'succeeded' ? 'Build succeeded' : 'Build failed',
        icon: finalStatus === 'succeeded' ? '✅' : '❌',
        org_id: orgId,
        tracking_version: 2,
        tags: {
          'app-id': appId,
          'platform': platform,
          'status': finalStatus || 'unknown',
          'time': buildTime,
          // Present only for onboarding-initiated builds — correlates the build
          // outcome with the rest of the journey's events.
          ...(options.builderJourneyId ? { journey_id: options.builderJourneyId } : {}),
        },
        notify: false,
      }).catch()

      return {
        success: finalStatus === 'succeeded',
        jobId: buildRequest.job_id,
        uploadUrl: buildRequest.upload_url,
        status: finalStatus || startResult.status || buildRequest.status,
        aiAnalysis: aiAnalysisInfo,
      }
    }
    finally {
      // Clean up temp directory
      await rm(tempDir, { recursive: true, force: true })
    }
  }
  catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log.error(errorMessage)

    return {
      success: false,
      error: errorMessage,
    }
  }
}

export async function requestBuildCommand(appId: string, options: BuildRequestOptions): Promise<void> {
  // `build request` is the ONLY entrypoint that opts into prescan (default on; --no-prescan
  // turns it off). requestBuildInternal keeps the gate opt-in (options.prescan === true) so the
  // onboarding wizard (build init), MCP build tools, and the SDK never trigger it.
  const result = await requestBuildInternal(appId, { ...options, prescan: options.prescan !== false }, false)

  if (!result.success) {
    exit(1)
  }
}
