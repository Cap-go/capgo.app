import type { OnboardingCheckOptions } from './onboarding/background'
import { randomUUID } from 'node:crypto'
import { exit } from 'node:process'
import { Worker, workerData } from 'node:worker_threads'
import { prepareOnboardingCheck } from './onboarding/background-check'

async function runOnboardingChecks(options: OnboardingCheckOptions): Promise<void> {
  const prepared = await prepareOnboardingCheck(options)
  if (!prepared)
    return

  const attemptIds = options.attemptIds ?? [options.attemptId ?? randomUUID(), randomUUID()]
  await Promise.allSettled([
    new URL('./notify-app-ready-worker.js', import.meta.url),
    new URL('./updater-installed-worker.js', import.meta.url),
  ].map((workerUrl, index) => new Promise<void>((resolve) => {
    const worker = new Worker(workerUrl, {
      workerData: { ...prepared, attemptId: attemptIds[index] },
      stdout: true,
      stderr: true,
    })
    worker.stdout?.destroy()
    worker.stderr?.destroy()
    worker.on('error', () => {})
    worker.once('exit', () => resolve())
  })))
}

void runOnboardingChecks(workerData as OnboardingCheckOptions).catch(() => {
  // Optional onboarding checks must never affect the requested command.
}).finally(() => exit(0))
