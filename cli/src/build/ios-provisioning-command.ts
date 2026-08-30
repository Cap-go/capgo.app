import type { SavedCredentials } from '../schemas/build'
import type { CredentialsStoreName, CredentialsStores } from './credentials-store-selection'
import type { ProvisioningMap, ProvisioningTargetGroup } from './ios-provisioning-map'
import type { PbxTarget } from './pbxproj-parser'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd, exit } from 'node:process'
import { confirm, isCancel, log } from '@clack/prompts'
import { canPromptInteractively, formatError, getAppId, getConfig } from '../utils'
import { loadSavedCredentials, updateSavedCredentials } from './credentials'
import { resolveCredentialsStore } from './credentials-store-selection'
import { analyzeProvisioningCoverage, parseProvisioningMap } from './ios-provisioning-map'
import { DuplicateProfileError, createProfile, deleteProfile, ensureBundleId, findCertBySha1, generateJwt, verifyApiKey } from './onboarding/apple-api'
import { findSignableTargets, findXcodeProject } from './pbxproj-parser'
import { getPlatformDirFromCapacitorConfig } from './platform-paths'
import { openP12 } from './prescan/checks/ios-certs'

export interface IosProvisioningOptions {
  local?: boolean
  global?: boolean
}

export interface IosProvisioningProject {
  appId: string
  targets: PbxTarget[]
}

export interface IosProvisioningCommandDeps {
  loadProject: () => Promise<IosProvisioningProject>
  loadStores: (appId: string, options: IosProvisioningOptions) => Promise<CredentialsStores>
  persistMap: (appId: string, source: CredentialsStoreName, map: ProvisioningMap) => Promise<void>
  canPrompt: () => boolean
  confirm: (message: string) => Promise<boolean>
  logInfo: (message: string) => void
  generateJwt: typeof generateJwt
  verifyApiKey: typeof verifyApiKey
  openP12: typeof openP12
  findCertBySha1: typeof findCertBySha1
  ensureBundleId: typeof ensureBundleId
  createProfile: typeof createProfile
  deleteProfile: typeof deleteProfile
}

function formatTargets(targets: ProvisioningTargetGroup[]): string {
  return targets.map(target => `${target.targetNames.join('/')} (${target.bundleId})`).join(', ')
}

async function confirmRequired(deps: IosProvisioningCommandDeps, message: string): Promise<boolean> {
  if (!deps.canPrompt())
    throw new Error('This change requires confirmation in an interactive terminal. Run the command locally and retry.')
  return deps.confirm(message)
}

function requireP8Credentials(credentials: NonNullable<SavedCredentials['ios']>): void {
  const required = ['APPLE_KEY_ID', 'APPLE_ISSUER_ID', 'APPLE_KEY_CONTENT', 'BUILD_CERTIFICATE_BASE64'] as const
  const missing = required.filter(key => !credentials[key])
  if (missing.length > 0) {
    throw new Error(`App-specific password credentials are not supported for provisioning profile generation. Save a complete App Store Connect .p8 key and signing certificate first. Missing: ${missing.join(', ')}`)
  }
}

export async function runIosProvisioningCommand(options: IosProvisioningOptions, deps: IosProvisioningCommandDeps): Promise<void> {
  const project = await deps.loadProject()
  if (!project.appId)
    throw new Error('The Capacitor project does not define an app id')
  if (project.targets.length === 0)
    throw new Error('The iOS Xcode project has no signable targets')

  const unresolved = project.targets.filter(target => !target.bundleId || target.bundleId.includes('$(') || target.bundleId.includes('${') || target.bundleId.includes('*'))
  if (unresolved.length > 0)
    throw new Error(`Cannot resolve the bundle id for: ${unresolved.map(target => target.name).join(', ')}`)

  const stores = await deps.loadStores(project.appId, options)
  const { source, saved } = resolveCredentialsStore({ ...options, appId: project.appId }, stores)
  const credentials = saved.ios
  if (!credentials)
    throw new Error(`No saved iOS Builder credentials for ${project.appId} in the ${source} store`)
  if (credentials.CAPGO_IOS_DISTRIBUTION === 'ad_hoc')
    throw new Error('Ad Hoc provisioning is not supported by this command')

  let map = parseProvisioningMap(credentials.CAPGO_IOS_PROVISIONING_MAP)
  let coverage = analyzeProvisioningCoverage(project.targets, map)
  if (coverage.missing.length === 0) {
    deps.logInfo('All iOS targets have provisioning profiles saved in Capgo.')
    return
  }
  if (coverage.wildcardConflict.length > 0)
    throw new Error('Sorry, multiple matching wildcard provisioning profiles are not supported')

  let declinedWildcard = false
  if (coverage.wildcardReuse) {
    const accepted = await confirmRequired(
      deps,
      `Update the provisioning profile map so these targets reuse "${coverage.wildcardReuse.entry.name}"? ${formatTargets(coverage.wildcardReuse.targets)}`,
    )
    if (accepted) {
      const repaired = { ...map }
      for (const target of coverage.wildcardReuse.targets)
        repaired[target.bundleId] = { ...coverage.wildcardReuse.entry }
      await deps.persistMap(project.appId, source, repaired)
      map = repaired
      coverage = analyzeProvisioningCoverage(project.targets, map)
    }
    else {
      declinedWildcard = true
    }
  }

  const generationTargets = declinedWildcard ? coverage.missing : coverage.generation
  if (generationTargets.length === 0) {
    deps.logInfo('All iOS targets have provisioning profiles saved in Capgo.')
    return
  }

  requireP8Credentials(credentials)
  throw new Error(`Dedicated provisioning profile generation is required for: ${formatTargets(generationTargets)}`)
}

async function loadDefaultProject(): Promise<IosProvisioningProject> {
  const { config } = await getConfig(true)
  const appId = getAppId(undefined, config)
  if (!appId)
    throw new Error('The Capacitor project does not define an app id')

  const projectDir = cwd()
  const iosDir = resolve(projectDir, getPlatformDirFromCapacitorConfig(config, 'ios'))
  if (!existsSync(iosDir))
    throw new Error('iOS is not configured in this Capacitor project. Run `npx cap add ios` first.')
  const pbxprojPath = findXcodeProject(iosDir)
  if (!pbxprojPath)
    throw new Error(`No Xcode project was found in ${iosDir}`)
  let pbxproj: string
  try {
    pbxproj = readFileSync(pbxprojPath, 'utf8')
  }
  catch {
    throw new Error(`Cannot read the Xcode project at ${pbxprojPath}`)
  }
  const targets = findSignableTargets(pbxproj)
  if (targets.length === 0)
    throw new Error('The iOS Xcode project has no signable targets')
  return { appId, targets }
}

async function loadDefaultStores(appId: string, options: IosProvisioningOptions): Promise<CredentialsStores> {
  if (options.local)
    return { local: await loadSavedCredentials(appId, true, true), global: null }
  if (options.global)
    return { local: null, global: await loadSavedCredentials(appId, false, true) }
  return {
    local: await loadSavedCredentials(appId, true, true),
    global: await loadSavedCredentials(appId, false, true),
  }
}

export function defaultIosProvisioningCommandDeps(): IosProvisioningCommandDeps {
  return {
    loadProject: loadDefaultProject,
    loadStores: loadDefaultStores,
    persistMap: (appId, source, map) => updateSavedCredentials(appId, 'ios', { CAPGO_IOS_PROVISIONING_MAP: JSON.stringify(map) }, source === 'local'),
    canPrompt: canPromptInteractively,
    confirm: async message => {
      const answer = await confirm({ message })
      return !isCancel(answer) && answer
    },
    logInfo: message => log.info(message),
    generateJwt,
    verifyApiKey,
    openP12,
    findCertBySha1,
    ensureBundleId,
    createProfile,
    deleteProfile,
  }
}

export async function iosProvisioningCommand(options: IosProvisioningOptions): Promise<void> {
  try {
    await runIosProvisioningCommand(options, defaultIosProvisioningCommandDeps())
  }
  catch (error) {
    log.error(formatError(error))
    exit(1)
  }
}

export { DuplicateProfileError }
