import type { OnboardingCheckOptions } from './onboarding/background'
import { randomUUID } from 'node:crypto'
import { exit } from 'node:process'
import { Worker, workerData } from 'node:worker_threads'
import { prepareOnboardingCheck } from './onboarding/background-preparation'
import { readCompletedOnboardingChecks } from './onboarding/background-status'

interface ScanWorker {
  completion: Promise<void>
  terminate: () => void
}

function runScanWorker(workerUrl: URL, data: object): ScanWorker | undefined {
  try {
    const worker = new Worker(workerUrl, { workerData: data, stdout: true, stderr: true })
    worker.stdout?.destroy()
    worker.stderr?.destroy()
    worker.on('error', () => {})
    let exited = false
    const completion = new Promise<void>((resolve) => {
      worker.once('exit', () => {
        exited = true
        resolve()
      })
    })
    return {
      completion,
      terminate: () => {
        if (!exited)
          void worker.terminate().catch(() => {})
      },
    }
  }
  catch {
    // Optional checks must not affect the requested command.
  }
}

async function runOnboardingChecks(options: OnboardingCheckOptions): Promise<void> {
  const prepared = await prepareOnboardingCheck(options)
  if (!prepared)
    return

  const statusRead = readCompletedOnboardingChecks(prepared)
  let timer: ReturnType<typeof setTimeout> | undefined
  const completed = await Promise.race([
    statusRead,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 250)
    }),
  ])
  if (timer)
    clearTimeout(timer)

  const attemptIds = options.attemptIds ?? [options.attemptId ?? randomUUID(), randomUUID()]
  const notifyWorker = completed?.add_code
    ? undefined
    : runScanWorker(new URL('./notify-app-ready-worker.js', import.meta.url), { ...prepared, attemptId: attemptIds[0] })
  const updaterWorker = completed?.add_updater
    ? undefined
    : runScanWorker(new URL('./updater-installed-worker.js', import.meta.url), { ...prepared, attemptId: attemptIds[1] })

  if (!completed) {
    void statusRead.then((lateCompleted) => {
      if (lateCompleted?.add_code)
        notifyWorker?.terminate()
      if (lateCompleted?.add_updater)
        updaterWorker?.terminate()
    })
  }
  await Promise.allSettled([
    ...(notifyWorker ? [notifyWorker.completion] : []),
    ...(updaterWorker ? [updaterWorker.completion] : []),
  ])
}

void runOnboardingChecks(workerData as OnboardingCheckOptions).catch(() => {
  // Optional onboarding checks must never affect the requested command.
}).finally(() => exit(0))
