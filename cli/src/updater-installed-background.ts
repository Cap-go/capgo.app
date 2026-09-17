import type { Command } from 'commander'
import { startOnboardingCheck } from './onboarding/background'

export function startUpdaterInstalledCheck(command: Command, commandPath: string): void {
  startOnboardingCheck(command, commandPath, new URL('./updater-installed-worker.js', import.meta.url))
}
