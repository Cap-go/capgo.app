import type { Command } from 'commander'
import { startOnboardingCheck } from './onboarding/background'

export type { OnboardingCheckOptions as NotifyAppReadyCheckOptions } from './onboarding/background'

export function startNotifyAppReadyCheck(command: Command, commandPath: string): void {
  startOnboardingCheck(command, commandPath, new URL('./notify-app-ready-worker.js', import.meta.url))
}
