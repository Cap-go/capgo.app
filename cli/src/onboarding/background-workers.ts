import type { Worker } from 'node:worker_threads'

interface PendingOnboardingCheck {
  completion: Promise<void>
  attemptId: string
  attemptIds: string[]
}

const pendingChecks = new Map<Worker, PendingOnboardingCheck>()

export function registerOnboardingCheck(worker: Worker, attemptIds: string[]): void {
  const completion = new Promise<void>((resolve) => {
    worker.once('exit', () => {
      pendingChecks.delete(worker)
      resolve()
    })
  })
  pendingChecks.set(worker, { completion, attemptId: attemptIds[0], attemptIds })
}

export function getPendingOnboardingChecks(): ReadonlyMap<Worker, PendingOnboardingCheck> {
  return pendingChecks
}
