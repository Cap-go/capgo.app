import { platform, version } from 'node:os'
import { version as nodeVersion } from 'node:process'
import { log, spinner } from '@clack/prompts'
import pack from '../../package.json'
import { trackEvent } from '../analytics/track'
import { getAllPackagesDependencies, getAppId, getBundleVersion, getConfig } from '../utils'
import { getLatestVersion } from '../utils/latest-version'

async function getLatestDependencies(installedDependencies: Record<string, string>) {
  const latestDependencies: Record<string, string> = {}
  const keys = Object.keys(installedDependencies)
  const versions = await Promise.all(keys.map(dependency => getLatestVersion(dependency)))

  versions.forEach((v, index) => {
    if (v)
      latestDependencies[keys[index]] = v
  })

  return latestDependencies
}

async function getInstalledDependencies() {
  const dependencies = await getAllPackagesDependencies()
  const installedDependencies: Record<string, string> = {
    '@capgo/cli': pack.version,
  }

  for (const [dependency, depVersion] of dependencies) {
    if (dependency.startsWith('@capgo/') || dependency.startsWith('@capawesome/') || dependency.startsWith('capacitor'))
      installedDependencies[dependency] = depVersion
  }

  return installedDependencies
}

interface DoctorInfoOptions {
  packageJson?: string
}

export function computeDoctorAnalyticsTags(
  installed: Record<string, string>,
  latest: Record<string, string>,
): { is_outdated: boolean, dependency_count: number, outdated_count: number } {
  const keys = Object.keys(installed)
  let outdatedCount = 0
  for (const key of keys) {
    const have = installed[key]
    const want = latest[key]
    if (have && want && have !== want)
      outdatedCount += 1
  }
  return {
    is_outdated: outdatedCount > 0,
    dependency_count: keys.length,
    outdated_count: outdatedCount,
  }
}

export async function getInfoInternal(options: DoctorInfoOptions, silent = false) {
  if (!silent)
    log.warn(' 💊   Capgo Doctor  💊')

  const extConfig = await getConfig()
  const pkgVersion = getBundleVersion('', options.packageJson)
  const appVersion = extConfig?.config?.plugins?.CapacitorUpdater?.version || pkgVersion
  const appName = extConfig?.config?.appName || ''
  const appId = getAppId('', extConfig?.config)
  const webDir = extConfig?.config?.webDir || ''

  if (!silent) {
    log.info(` App Name: ${appName}`)
    log.info(` App ID: ${appId}`)
    log.info(` App Version: ${appVersion}`)
    log.info(` Web Dir: ${webDir}`)
    log.info(` OS: ${platform()} ${version()}`)
    log.info(` Node: ${nodeVersion}`)
    log.info(' Installed Dependencies:')
  }

  const installedDependencies = await getInstalledDependencies()

  if (Object.keys(installedDependencies).length === 0) {
    if (!silent)
      log.warning('\x1B[31m%s\x1B[0m 🚨 No dependencies found')
    throw new Error('No dependencies found')
  }

  if (!silent) {
    for (const dependency of Object.keys(installedDependencies))
      log.info(`   ${dependency}: ${installedDependencies[dependency]}`)
  }

  let latestDependencies: Record<string, string> = {}

  if (!silent) {
    const s = spinner()
    s.start('Running: Loading latest dependencies')
    latestDependencies = await getLatestDependencies(installedDependencies)
    s.stop('Latest Dependencies:')

    for (const dependency of Object.keys(latestDependencies))
      log.info(`   ${dependency}: ${latestDependencies[dependency]}`)
  }
  else {
    latestDependencies = await getLatestDependencies(installedDependencies)
  }

  void trackEvent({
    channel: 'cli-usage',
    event: 'Doctor Ran',
    tags: computeDoctorAnalyticsTags(installedDependencies, latestDependencies),
  })

  if (JSON.stringify(installedDependencies) !== JSON.stringify(latestDependencies)) {
    if (!silent)
      log.warn('\x1B[31m🚨 Some dependencies are not up to date\x1B[0m')
    throw new Error('Some dependencies are not up to date')
  }

  if (!silent)
    log.success('\x1B[32m✅ All dependencies are up to date\x1B[0m')

  return {
    appName,
    appId,
    appVersion,
    webDir,
    installedDependencies,
    latestDependencies,
  }
}

export async function getInfo(options: DoctorInfoOptions) {
  return getInfoInternal(options)
}
