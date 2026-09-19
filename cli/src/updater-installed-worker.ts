import type { OnboardingCheckOptions } from './onboarding/background'
import { exit } from 'node:process'
import { workerData } from 'node:worker_threads'
import { runOnboardingCheck, type PreparedOnboardingCheck } from './onboarding/background-check'
import { scanUpdaterInstalled } from './onboarding/updater-installed'

void runOnboardingCheck(workerData as OnboardingCheckOptions | PreparedOnboardingCheck, {
  channel: 'updater-installed',
  step: 'add_updater',
  scan: scanUpdaterInstalled,
}).catch(() => {
  // Missing projects, config failures, and rejected reports are optional.
}).finally(() => exit(0))
