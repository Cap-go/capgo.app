import type { OnboardingCheckOptions } from './onboarding/background'
import { randomUUID } from 'node:crypto'
import { exit } from 'node:process'
import { workerData } from 'node:worker_threads'
import { prepareOnboardingCheck, runOnboardingCheck } from './onboarding/background-check'
import { scanNotifyAppReadySource } from './onboarding/notify-app-ready-source'
import { scanUpdaterInstalled } from './onboarding/updater-installed'

async function runOnboardingChecks(options: OnboardingCheckOptions): Promise<void> {
  const prepared = await prepareOnboardingCheck(options)
  if (!prepared)
    return

  const attemptIds = options.attemptIds ?? [options.attemptId ?? randomUUID(), randomUUID()]
  await Promise.allSettled([
    runOnboardingCheck({ ...prepared, attemptId: attemptIds[0] }, {
      channel: 'notify-app-ready',
      step: 'add_code',
      scan: scanNotifyAppReadySource,
    }),
    runOnboardingCheck({ ...prepared, attemptId: attemptIds[1] }, {
      channel: 'updater-installed',
      step: 'add_updater',
      scan: scanUpdaterInstalled,
    }),
  ])
}

void runOnboardingChecks(workerData as OnboardingCheckOptions).catch(() => {
  // Optional onboarding checks must never affect the requested command.
}).finally(() => exit(0))
