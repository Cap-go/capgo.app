import { log } from '@clack/prompts'
import pack from '../../package.json'
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

export async function checkVersionStatus(): Promise<VersionCheckResult> {
  const latest = await getLatestVersion('@capgo/cli') ?? ''
  const major = latest?.split('.')[0] ?? ''
  return {
    currentVersion: pack.version,
    latestVersion: latest,
    isOutdated: !!latest && latest !== pack.version,
    majorVersion: major,
  }
}

export async function checkAlerts(reporter: AlertsReporter = { warn: message => log.warning(message) }) {
  const { isOutdated, currentVersion, latestVersion, majorVersion } = await checkVersionStatus()
  if (isOutdated) {
    reporter.warn(`🚨 You are using @capgo/cli@${currentVersion} it's not the latest version.
Please use @capgo/cli@${latestVersion}" or @capgo/cli@${majorVersion} to keep up to date with the latest features and bug fixes.`,
    )
  }
}
