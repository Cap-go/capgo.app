import type { OnboardingCheckOptions } from './onboarding/background'
import { randomUUID } from 'node:crypto'
import { exit } from 'node:process'
import { Worker, workerData } from 'node:worker_threads'
import { prepareOnboardingCheck } from './onboarding/background-check'

function runScanWorker(workerUrl: URL, data: object): Promise<void> {
  return new Promise((resolve) => {
    try {
      const worker = new Worker(workerUrl, { workerData: data, stdout: true, stderr: true })
      worker.stdout?.destroy()
      worker.stderr?.destroy()
      worker.on('error', () => {})
      worker.once('exit', () => resolve())
    }
    catch {
      resolve()
    }
  })
}

async function runOnboardingChecks(options: OnboardingCheckOptions): Promise<void> {
  const prepared = await prepareOnboardingCheck(options)
  if (!prepared)
    return

  const attemptIds = options.attemptIds ?? [options.attemptId ?? randomUUID(), randomUUID()]
  await Promise.allSettled([
    runScanWorker(new URL('./notify-app-ready-worker.js', import.meta.url), { ...prepared, attemptId: attemptIds[0] }),
    runScanWorker(new URL('./updater-installed-worker.js', import.meta.url), { ...prepared, attemptId: attemptIds[1] }),
  ])
}

void runOnboardingChecks(workerData as OnboardingCheckOptions).catch(() => {
  // Optional onboarding checks must never affect the requested command.
}).finally(() => exit(0))
