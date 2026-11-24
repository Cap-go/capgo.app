import { log } from '@clack/prompts'
import { canParse, lessThan, parse } from '@std/semver'
import pack from '../../package.json'
import { getPMAndCommand } from '../utils'
import { getLatestVersion } from '../utils/latest-version'

export interface VersionCheckResult {
  currentVersion: string
  latestVersion: string
  isOutdated: boolean
  majorVersion: string
}

interface AlertsReporter {
  warn: (message: string) => void
}

/**
 * True only when `current` is a valid semver strictly older than `latest`,
 * so local or prerelease builds newer than npm never get an update nag.
 */
export function isCliOutdated(current: string, latest: string): boolean {
  return canParse(current) && canParse(latest) && lessThan(parse(current), parse(latest))
}

export async function checkVersionStatus(): Promise<VersionCheckResult> {
  const latest = await getLatestVersion('@capgo/cli') ?? ''
  const major = latest?.split('.')[0] ?? ''
  return {
    currentVersion: pack.version,
    latestVersion: latest,
    isOutdated: isCliOutdated(pack.version, latest),
    majorVersion: major,
  }
}

/**
 * Builds the update notice with a copy-paste command for the project's package manager.
 */
export function formatCliUpdateMessage(currentVersion: string, latestVersion: string, installCommand: string): string {
  return `Update available for @capgo/cli: ${currentVersion} → ${latestVersion}
Run: ${installCommand} -D @capgo/cli@latest
Pinned in CI? Commit the updated lockfile. Using npx? Run npx @capgo/cli@latest.`
}

export async function checkAlerts(reporter: AlertsReporter = { warn: message => log.warning(message) }) {
  const { isOutdated, currentVersion, latestVersion } = await checkVersionStatus()
  if (isOutdated)
    reporter.warn(formatCliUpdateMessage(currentVersion, latestVersion, getPMAndCommand().installCommand))
}
