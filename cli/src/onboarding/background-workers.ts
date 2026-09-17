import type { Worker } from 'node:worker_threads'

const pendingChecks = new Map<Worker, Promise<void>>()

export function registerOnboardingCheck(worker: Worker): void {
  const completion = new Promise<void>((resolve) => {
    worker.once('exit', () => {
      pendingChecks.delete(worker)
      resolve()
    })
  })
  pendingChecks.set(worker, completion)
}

export function getPendingOnboardingChecks(): ReadonlyMap<Worker, Promise<void>> {
  return pendingChecks
}
