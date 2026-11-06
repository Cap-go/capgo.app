import type { Worker } from 'node:worker_threads'
import type { SetupNotice } from './setup-notices'
import { relaySetupDebug, setupDebug } from './setup-diagnostics'

interface PendingOnboardingCheck {
  completion: Promise<void>
  attemptId: string
  attemptIds: string[]
}

const pendingChecks = new Map<Worker, PendingOnboardingCheck>()
const completedNotices: SetupNotice[] = []

export function registerOnboardingCheck(worker: Worker, attemptIds: string[]): void {
  worker.on('message', (message) => {
    relaySetupDebug(message)
    if (message?.type === 'setup-notice' && message.notice)
      completedNotices.push(message.notice)
  })
  const completion = new Promise<void>((resolve) => {
    worker.once('exit', (code) => {
      setupDebug('worker exited', { exit_code: code })
      pendingChecks.delete(worker)
      resolve()
    })
  })
  pendingChecks.set(worker, { completion, attemptId: attemptIds[0], attemptIds })
}

export function takeSetupNotices(): SetupNotice[] {
  return completedNotices.splice(0)
}

export function finishOnboardingCommand(): void {
  setupDebug('foreground succeeded', { pending_workers: pendingChecks.size })
  for (const worker of pendingChecks.keys()) {
    try {
      worker.postMessage({ type: 'command-succeeded' })
    }
    catch {
      // A worker exiting concurrently cannot affect the foreground command.
    }
  }
}

export function getPendingOnboardingChecks(): ReadonlyMap<Worker, PendingOnboardingCheck> {
  return pendingChecks
}
