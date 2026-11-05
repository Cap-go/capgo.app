import type { OnboardingCheckOptions } from './onboarding/background'
import type { PreparedOnboardingCheck } from './onboarding/background-check'
import type { LocalOnboardingStep } from './onboarding/setup-notices'
import { randomUUID } from 'node:crypto'
import { exit } from 'node:process'
import { parentPort, Worker, workerData } from 'node:worker_threads'
import { setCurrentCliCommand } from './analytics/cli-headers'
import { prepareOnboardingCheck } from './onboarding/background-preparation'
import { relaySetupDebug, setupDebug, setupError } from './onboarding/setup-diagnostics'
import { readSetupProgress } from './onboarding/setup-notice-evaluation'
import { shouldRefreshSetupProgress } from './onboarding/setup-notice-policy'
import { getSetupNotice, getTrialNotice, reconcileSetupProgress } from './onboarding/setup-notices'
import { sendEvent } from './utils'

function runScanWorker(workerUrl: URL, data: PreparedOnboardingCheck, scan: string): Promise<LocalOnboardingStep | undefined> {
  return new Promise((resolve) => {
    try {
      setupDebug('scan worker starting', { scan })
      const worker = new Worker(workerUrl, { workerData: data, stdout: true, stderr: true })
      worker.stdout?.destroy()
      worker.stderr?.destroy()
      let reported: LocalOnboardingStep | undefined
      const analytics: Promise<void>[] = []
      worker.on('message', (message) => {
        relaySetupDebug(message)
        if (message?.type === 'onboarding-analytics') {
          const started = Date.now()
          setupDebug('scan telemetry started', { scan, event: message.payload.event, budget_ms: 2_000 })
          analytics.push(sendEvent(data.apikey, message.payload, false, AbortSignal.timeout(2_000), data.apiHost, 'error')
            .catch(error => setupDebug('scan telemetry failed', { scan, error: setupError(error) }))
            .finally(() => setupDebug('scan telemetry finished', { scan, event: message.payload.event, duration_ms: Date.now() - started })))
        }
        if (message?.type === 'onboarding-step' && (message.step === 'add_code' || message.step === 'add_updater'))
          reported = message.step
      })
      worker.on('error', error => setupDebug('scan worker failed', { scan, error: setupError(error) }))
      worker.once('exit', async (code) => {
        setupDebug('scan worker exited', { scan, exit_code: code, reported: reported ?? 'none' })
        await Promise.allSettled(analytics)
        resolve(reported)
      })
    }
    catch (error) {
      setupDebug('scan worker start failed', { scan, error: setupError(error) })
      resolve(undefined)
    }
  })
}

async function runOnboardingChecks(options: OnboardingCheckOptions): Promise<void> {
  setCurrentCliCommand(options.command)
  // Register before discovery: a fast command may finish while config is loading.
  const refresh = options.setupNotice && shouldRefreshSetupProgress(options.command)
  const foregroundFinished = refresh
    ? new Promise<void>((resolve) => {
        parentPort?.on('message', (message) => {
          if (message?.type === 'command-succeeded')
            resolve()
        })
      })
    : Promise.resolve()
  const started = Date.now()
  setupDebug('preparation started', { notice_enabled: options.setupNotice, refresh })
  const prepared = await prepareOnboardingCheck(options)
  setupDebug('preparation finished', { duration_ms: Date.now() - started, prepared: !!prepared })
  if (!prepared)
    return

  const attemptIds = options.attemptIds ?? [options.attemptId ?? randomUUID(), randomUUID()]
  const earlyController = new AbortController()
  const earlyProgress = options.setupNotice ? readSetupProgress(prepared, earlyController.signal) : Promise.resolve(undefined)
  // Start the fresh read immediately after a mutation succeeds, even if the
  // startup request or local scans are slow. Never queue two request budgets.
  const progressRead = refresh
    ? foregroundFinished.then(() => {
        setupDebug('progress refresh after foreground success')
        earlyController.abort()
        return readSetupProgress(prepared)
      })
    : earlyProgress
  const [progress, ...reports] = await Promise.all([
    progressRead,
    runScanWorker(new URL('./notify-app-ready-worker.js', import.meta.url), { ...prepared, attemptId: attemptIds[0] }, 'app_ready'),
    runScanWorker(new URL('./updater-installed-worker.js', import.meta.url), { ...prepared, attemptId: attemptIds[1] }, 'updater'),
  ])
  setupDebug('parallel checks finished', { has_progress: !!progress, accepted_reports: reports.filter(Boolean).length })
  if (progress) {
    const updated = reports.filter((step): step is LocalOnboardingStep => step !== undefined)
    const notice = getSetupNotice(prepared.project.appId, reconcileSetupProgress(progress, updated), prepared.webHost)
      ?? getTrialNotice(prepared.project.appId, progress, prepared.webHost)
    if (notice) {
      setupDebug('notice ready', { kind: notice.kind })
      parentPort?.postMessage({ type: 'setup-notice', notice })
    }
  }
}

void runOnboardingChecks(workerData as OnboardingCheckOptions).catch((error) => {
  setupDebug('evaluation failed', { error: setupError(error) })
  // Optional onboarding checks must never affect the requested command.
}).finally(() => exit(0))
