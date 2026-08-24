import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { cwd, version as nodeVersion } from 'node:process'
import { platform, version } from 'node:os'
import { findInstallCommand, findPackageManagerRunner, findPackageManagerType } from '@capgo/find-package-manager'
import { confirm, isCancel, log, select, spinner } from '@clack/prompts'
import pack from '../../package.json'
import { trackEvent } from '../analytics/track'
import { canPromptInteractively, findRoot, getAllPackagesDependencies, getAppId, getBundleVersion, getConfig, getPMAndCommand } from '../utils'
import { getLatestVersion } from '../utils/latest-version'

export const OUTDATED_DEPENDENCIES_ERROR = 'Some dependencies are not up to date'

export interface OutdatedDependency {
  name: string
  installed: string
  latest: string
}

export type DoctorUpdateChoice = 'capgo-only' | 'all' | 'skip'

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

async function getInstalledDependencies(packageJson?: string) {
  const projectRoot = resolveDoctorProjectRoot(packageJson)
  const dependencies = await getAllPackagesDependencies(projectRoot, packageJson)
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

export function resolveDoctorProjectRoot(packageJson?: string): string {
  if (!packageJson)
    return findRoot(cwd())

  const firstPackageJson = packageJson.split(',')[0]?.trim()
  if (!firstPackageJson)
    return findRoot(cwd())

  return dirname(firstPackageJson)
}

export function getPMAndCommandForDir(projectRoot: string) {
  const pm = findPackageManagerType(projectRoot, 'npm')
  const command = findInstallCommand(pm)
  const runner = findPackageManagerRunner(projectRoot)
  return { pm, command, installCommand: `${pm} ${command}`, runner }
}

export interface DoctorRecoveryResult {
  recovered: boolean
  remainingOutdated: OutdatedDependency[]
}

export function listOutdatedDependencies(
  installed: Record<string, string>,
  latest: Record<string, string>,
): OutdatedDependency[] {
  const outdated: OutdatedDependency[] = []
  for (const name of Object.keys(installed)) {
    const have = installed[name]
    const want = latest[name]
    if (have && want && have !== want)
      outdated.push({ name, installed: have, latest: want })
  }
  return outdated
}

export function partitionOutdatedDependencies(outdated: OutdatedDependency[]): {
  capgo: OutdatedDependency[]
  other: OutdatedDependency[]
} {
  const capgo: OutdatedDependency[] = []
  const other: OutdatedDependency[] = []
  for (const dep of outdated) {
    if (dep.name.startsWith('@capgo/'))
      capgo.push(dep)
    else
      other.push(dep)
  }
  return { capgo, other }
}

export function packagesForDoctorUpdateChoice(
  choice: DoctorUpdateChoice,
  capgo: OutdatedDependency[],
  other: OutdatedDependency[],
): OutdatedDependency[] {
  if (choice === 'skip')
    return []
  if (choice === 'all')
    return [...capgo, ...other]
  return capgo
}

export function buildOutdatedInstallCommand(
  pm: ReturnType<typeof getPMAndCommand>,
  packages: OutdatedDependency[],
): string {
  const specs = packages.map(dep => `${dep.name}@latest`).join(' ')
  return `${pm.installCommand} ${specs}`.trim()
}

function formatSpawnOutput(output: string | Buffer | null | undefined): string {
  if (!output)
    return ''
  return typeof output === 'string' ? output : output.toString('utf8')
}

export function runOutdatedDependencyUpdates(
  pm: ReturnType<typeof getPMAndCommand>,
  packages: OutdatedDependency[],
  projectRoot: string,
): void {
  if (packages.length === 0)
    return

  const [command, ...baseArgs] = pm.installCommand.split(/\s+/).filter(Boolean)
  if (!command)
    throw new Error('Cannot determine package manager install command')

  const specs = packages.map(dep => `${dep.name}@latest`)
  const result = spawnSync(command, [...baseArgs, ...specs], {
    stdio: 'pipe',
    cwd: projectRoot,
  })

  if (result.error || result.status !== 0) {
    const output = [formatSpawnOutput(result.stdout), formatSpawnOutput(result.stderr)]
      .map(text => text.trim())
      .filter(Boolean)
      .join('\n')
    const outputDetails = output ? `\n${output}` : ''
    const message = `Dependency update failed with code ${result.status ?? 'unknown'}${outputDetails}`
    throw result.error ?? new Error(message)
  }
}

export function computeDoctorAnalyticsTags(
  installed: Record<string, string>,
  latest: Record<string, string>,
): { is_outdated: boolean, dependency_count: number, outdated_count: number } {
  const outdated = listOutdatedDependencies(installed, latest)
  return {
    is_outdated: outdated.length > 0,
    dependency_count: Object.keys(installed).length,
    outdated_count: outdated.length,
  }
}

function logOutdatedDependencyTable(outdated: OutdatedDependency[]) {
  log.warn('\x1B[31m🚨 Some dependencies are not up to date\x1B[0m')
  for (const dep of outdated)
    log.warn(`   ${dep.name}: ${dep.installed} → ${dep.latest}`)
}

function throwOutdatedDependenciesError(pm: ReturnType<typeof getPMAndCommand>, outdated: OutdatedDependency[], silent: boolean) {
  if (!silent && outdated.length > 0)
    log.info(`Run: ${buildOutdatedInstallCommand(pm, outdated)}`)
  throw new Error(OUTDATED_DEPENDENCIES_ERROR)
}

async function promptDoctorUpdateChoice(capgo: OutdatedDependency[], other: OutdatedDependency[]): Promise<DoctorUpdateChoice> {
  if (capgo.length > 0 && other.length === 0) {
    const shouldUpdate = await confirm({
      message: 'Update outdated @capgo/* packages now?',
      initialValue: true,
    })
    if (isCancel(shouldUpdate))
      return 'skip'
    return shouldUpdate ? 'capgo-only' : 'skip'
  }

  if (capgo.length === 0 && other.length > 0) {
    const choice = await select({
      message: 'Outdated Capacitor-related packages detected. How do you want to proceed?',
      options: [
        { value: 'all', label: 'Update all listed packages now' },
        { value: 'skip', label: 'Skip (doctor will fail)' },
      ],
    })
    if (isCancel(choice))
      return 'skip'
    return choice as DoctorUpdateChoice
  }

  const choice = await select({
    message: 'Outdated dependencies detected. How do you want to proceed?',
    options: [
      { value: 'capgo-only', label: 'Update @capgo/* packages only (recommended)' },
      { value: 'all', label: 'Update all listed packages' },
      { value: 'skip', label: 'Skip (doctor will fail)' },
    ],
  })
  if (isCancel(choice))
    return 'skip'
  return choice as DoctorUpdateChoice
}

async function maybeRecoverOutdatedDependencies(
  outdated: OutdatedDependency[],
  options: DoctorInfoOptions,
  silent: boolean,
): Promise<DoctorRecoveryResult> {
  if (!canPromptInteractively({ silent }))
    return { recovered: false, remainingOutdated: outdated }

  const projectRoot = resolveDoctorProjectRoot(options.packageJson)
  const pm = getPMAndCommandForDir(projectRoot)
  const { capgo, other } = partitionOutdatedDependencies(outdated)
  const choice = await promptDoctorUpdateChoice(capgo, other)
  const packagesToUpdate = packagesForDoctorUpdateChoice(choice, capgo, other)

  if (packagesToUpdate.length === 0)
    return { recovered: false, remainingOutdated: outdated }

  const installCommand = buildOutdatedInstallCommand(pm, packagesToUpdate)
  const s = spinner()
  s.start(`Running: ${installCommand}`)

  try {
    runOutdatedDependencyUpdates(pm, packagesToUpdate, projectRoot)
    s.stop('Dependencies updated')
  }
  catch (error) {
    s.stop('Dependency update failed')
    log.error(error instanceof Error ? error.message : String(error))
    log.info(`Run manually: ${installCommand}`)
    return { recovered: false, remainingOutdated: outdated }
  }

  const installedAfterUpdate = await getInstalledDependencies(options.packageJson)
  const latestAfterUpdate = await getLatestDependencies(installedAfterUpdate)
  const stillOutdated = listOutdatedDependencies(installedAfterUpdate, latestAfterUpdate)

  if (stillOutdated.length === 0) {
    void trackEvent({
      channel: 'cli-usage',
      event: 'CLI Recovered Outdated Dependencies',
      tags: { recovery: 'update', outdated_count: outdated.length },
    })
    log.success('\x1B[32m✅ All dependencies are up to date after update\x1B[0m')
    return { recovered: true, remainingOutdated: [] }
  }

  logOutdatedDependencyTable(stillOutdated)
  return { recovered: false, remainingOutdated: stillOutdated }
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

  const projectRoot = resolveDoctorProjectRoot(options.packageJson)
  let installedDependencies = await getInstalledDependencies(options.packageJson)

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

  const outdated = listOutdatedDependencies(installedDependencies, latestDependencies)

  if (outdated.length > 0) {
    if (!silent)
      logOutdatedDependencyTable(outdated)

    const recovery = await maybeRecoverOutdatedDependencies(outdated, options, silent)
    if (!recovery.recovered)
      throwOutdatedDependenciesError(getPMAndCommandForDir(projectRoot), recovery.remainingOutdated, silent)

    installedDependencies = await getInstalledDependencies(options.packageJson)
    latestDependencies = await getLatestDependencies(installedDependencies)
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
