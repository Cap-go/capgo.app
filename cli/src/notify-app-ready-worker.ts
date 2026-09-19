import type { OnboardingCheckOptions } from './onboarding/background'
import { exit } from 'node:process'
import { workerData } from 'node:worker_threads'
import { runOnboardingCheck, type PreparedOnboardingCheck } from './onboarding/background-check'
import { scanNotifyAppReadySource } from './onboarding/notify-app-ready-source'

void runOnboardingCheck(workerData as OnboardingCheckOptions | PreparedOnboardingCheck, {
  channel: 'notify-app-ready',
  step: 'add_code',
  scan: scanNotifyAppReadySource,
}).catch(() => {
  // Missing projects, parser/config failures, and rejected reports are optional.
}).finally(() => exit(0))
