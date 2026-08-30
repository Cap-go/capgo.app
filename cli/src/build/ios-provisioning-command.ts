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
import { decodeCredentialBase64 } from './credentials-base64'
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

function safeCause(error: unknown, secrets: string[]): string {
  let message = formatError(error)
  for (const secret of secrets.filter(value => value.length >= 4))
    message = message.replaceAll(secret, '[REDACTED]')
  return message
}

async function prepareAppleCredentials(credentials: NonNullable<SavedCredentials['ios']>, deps: IosProvisioningCommandDeps) {
  requireP8Credentials(credentials)
  const encodedKey = credentials.APPLE_KEY_CONTENT!
  let p8Content: string
  try {
    p8Content = decodeCredentialBase64(encodedKey).toString('utf8')
  }
  catch {
    throw new Error('The saved App Store Connect .p8 key is invalid')
  }
  const secrets = [encodedKey, p8Content, credentials.BUILD_CERTIFICATE_BASE64!, credentials.P12_PASSWORD ?? '']
  const freshToken = () => {
    try {
      return deps.generateJwt(credentials.APPLE_KEY_ID!, credentials.APPLE_ISSUER_ID!, p8Content)
    }
    catch {
      throw new Error('The saved App Store Connect .p8 key is invalid')
    }
  }

  try {
    await deps.verifyApiKey(freshToken())
  }
  catch (error) {
    throw new Error(`The saved App Store Connect .p8 key is invalid or does not have access: ${safeCause(error, secrets)}`)
  }

  let certificateSha1: string
  try {
    certificateSha1 = deps.openP12(credentials.BUILD_CERTIFICATE_BASE64!, credentials.P12_PASSWORD ?? '').sha1
  }
  catch {
    throw new Error('The saved iOS signing certificate or P12 password is invalid')
  }

  let certificate
  try {
    certificate = await deps.findCertBySha1(freshToken(), certificateSha1)
  }
  catch (error) {
    throw new Error(`Cannot verify the saved signing certificate in App Store Connect: ${safeCause(error, secrets)}`)
  }
  if (!certificate)
    throw new Error('The saved iOS signing certificate is not available to this App Store Connect .p8 key')
  return { certificateId: certificate.id, freshToken, secrets }
}

async function createTargetProfile(
  target: ProvisioningTargetGroup,
  certificateId: string,
  freshToken: () => string,
  secrets: string[],
  deps: IosProvisioningCommandDeps,
) {
  let bundleResource
  try {
    bundleResource = await deps.ensureBundleId(freshToken(), target.bundleId)
  }
  catch (error) {
    throw new Error(`Could not prepare the Apple bundle id for ${formatTargets([target])}: ${safeCause(error, secrets)}`)
  }

  const create = () => deps.createProfile(freshToken(), bundleResource.bundleIdResourceId, certificateId, target.bundleId)
  try {
    return await create()
  }
  catch (error) {
    if (!(error instanceof DuplicateProfileError))
      throw new Error(`Could not create a provisioning profile for ${formatTargets([target])}: ${safeCause(error, secrets)}`)

    const replace = await confirmRequired(
      deps,
      `Replace these existing Capgo provisioning profiles for ${formatTargets([target])}? ${error.profiles.map(profile => profile.name).join(', ')}`,
    )
    if (!replace)
      throw new Error(`Provisioning profile replacement was declined for ${formatTargets([target])}`)

    for (const profile of error.profiles) {
      try {
        await deps.deleteProfile(freshToken(), profile.id)
      }
      catch {
        throw new Error(`Could not delete all existing Capgo provisioning profiles for ${formatTargets([target])}. The saved map was not changed for this target.`)
      }
    }
    try {
      return await create()
    }
    catch {
      throw new Error(`Existing Capgo provisioning profiles were deleted, but the replacement for ${formatTargets([target])} could not be created. Retry the command.`)
    }
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

  const apple = await prepareAppleCredentials(credentials, deps)
  const generate = await confirmRequired(
    deps,
    `Generate App Store provisioning profiles for these targets? ${formatTargets(generationTargets)}`,
  )
  if (!generate)
    throw new Error('Provisioning profile generation was declined; no Apple resources were changed')

  for (const target of generationTargets) {
    const profile = await createTargetProfile(target, apple.certificateId, apple.freshToken, apple.secrets, deps)
    const updated = {
      ...map,
      [target.bundleId]: { profile: profile.profileContent, name: profile.profileName },
    }
    await deps.persistMap(project.appId, source, updated)
    map = updated
    deps.logInfo(`Saved a provisioning profile for ${formatTargets([target])}.`)
  }
  deps.logInfo('All iOS targets have provisioning profiles saved in Capgo.')
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
