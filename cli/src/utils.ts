import type { InstallCommand, PackageManagerRunner, PackageManagerType } from '@capgo/find-package-manager'
import type {
  SemVer,
} from '@std/semver'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Buffer } from 'node:buffer'
import type { CapacitorConfig, ExtConfigPairs } from './config'
import type { Compatibility, CompatibilityDetails, IncompatibilityReason, NativePackage } from './schemas/common'
import type { Database } from './types/supabase.types'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import path, { dirname, join, relative, resolve, sep } from 'node:path'
import { cwd, env, stdin, stdout } from 'node:process'
import { findInstallCommand, findPackageManagerRunner, findPackageManagerType } from '@capgo/find-package-manager'
import { confirm as confirmC, isCancel, log, select, spinner as spinnerC } from '@clack/prompts'
import { canParse, format, lessThan, parse, parseRange, rangeIntersects } from '@std/semver'
import { createClient, FunctionsHttpError } from '@supabase/supabase-js'
import AdmZip from 'adm-zip'
import { isCI } from 'ci-info'
// Native fetch is available in Node.js >= 18
import prettyjson from 'prettyjson'
import * as tus from 'tus-js-client'
import { getGlobalAnalyticsProps } from './analytics/global-props'
import { createTimedFetch, isSupabaseInstrumentationEnabled } from './analytics/supabase-perf'
import { markSnag } from './app/debug'
import { findMonorepoRoot, findNXMonorepoRoot, isMonorepo, isNXMonorepo } from './capacitor-cli'
import { getChecksum } from './checksum'
import { loadConfig, loadConfigForWrite, writeConfig } from './config'
import { isTruthyEnvValue } from './posthog'
import { safeParseSchema } from './schemas/schema_validation'
import { nativePackageSchema } from './schemas/common'
import { formatApiErrorForCli, parseSecurityPolicyError } from './utils/security_policy_errors'

export const baseKey = '.capgo_key'
export const baseKeyV2 = '.capgo_key_v2'
export const baseKeyPub = `${baseKey}.pub`
export const baseKeyPubV2 = `${baseKeyV2}.pub`
export const defaultHost = 'https://capgo.app'
export const defaultFileHost = 'https://files.capgo.app'
export const defaultApiHost = 'https://api.capgo.app'
export const defaultHostWeb = 'https://console.capgo.app'

/** Build a console web-app URL (settings, builds, connect, etc.). */
export function consoleWebUrl(path = ''): string {
  if (!path)
    return defaultHostWeb
  return `${defaultHostWeb}${path.startsWith('/') ? path : `/${path}`}`
}
export const UPLOAD_TIMEOUT = 120000
export const ALERT_UPLOAD_SIZE_BYTES = 1024 * 1024 * 20 // 20MB
export const MAX_UPLOAD_LENGTH_BYTES = 1024 * 1024 * 1024 // 1GB
export const MAX_CHUNK_SIZE_BYTES = 1024 * 1024 * 99 // 99MB
export const TUS_UPLOAD_RETRY_DELAYS = [0, 1000, 3000, 5000, 10000]

export const PACKNAME = 'package.json'

export type ArrayElement<ArrayType extends readonly unknown[]>
  = ArrayType extends readonly (infer ElementType)[] ? ElementType : never
export type Organization = ArrayElement<Database['public']['Functions']['get_orgs_v7']['Returns']>

export const regexSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*))?(?:\+([0-9a-z-]+(?:\.[0-9a-z-]+)*))?$/i

/**
 * Format an error for display. If it's a security policy error,
 * returns a human-readable message with actionable steps.
 */
export function formatError(error: any): string {
  if (!error)
    return 'Unknown error'

  // Check if this is a security policy error first
  const parsed = parseSecurityPolicyError(error)
  if (parsed.isSecurityPolicyError) {
    return formatApiErrorForCli(error)
  }

  const asError = error as {
    message?: string
    stack?: string
    cause?: { message?: string, name?: string }
    code?: string | number
    status?: number
    statusCode?: number
    details?: string
    hint?: string
    error?: string | { message?: string }
  }

  if (typeof error === 'string')
    return error

  if (error instanceof Error) {
    const reason = asError.message || asError.cause?.message || asError.stack || error.name
    const causeName = asError.cause?.name
    const reasonLower = reason.toLowerCase()
    if (reasonLower.includes('fetch failed') || reasonLower.includes('failed to fetch') || reasonLower.includes('connect timeout')
      || reasonLower.includes('network') || causeName?.startsWith('UND_ERR')) {
      return `Network error: ${reason}${asError.code ? ` (code ${asError.code})` : ''}. Check your network connection and API endpoint availability.`
    }

    const status = asError.status || asError.statusCode
    const details = [reason, asError.code ? `Code: ${asError.code}` : undefined, status ? `Status: ${status}` : undefined]
      .filter(Boolean)
      .join(' | ')
    return details || error.name
  }

  if (asError.message) {
    const details = [asError.message, asError.code ? `Code: ${asError.code}` : undefined, asError.status || asError.statusCode ? `Status: ${asError.status || asError.statusCode}` : undefined]
      .filter(Boolean)
      .join(' | ')
    const normalized = asError.message.toLowerCase()
    if (normalized.includes('fetch failed') || normalized.includes('failed to fetch') || asError.error === 'Failed to fetch') {
      return `Network error: ${details}. Check your network connection and API endpoint availability.`
    }
    if (asError.details || asError.hint || asError.error)
      return `${details}${details ? ' | ' : ''}${asError.error ? (typeof asError.error === 'string' ? asError.error : asError.error.message ?? '') : ''}${asError.details ? `Details: ${asError.details}` : ''}${asError.hint ? `Hint: ${asError.hint}` : ''}`.trim()
    return details
  }

  if (typeof asError.error === 'string' && asError.error.length > 0)
    return asError.error
  if (asError.error && typeof asError.error === 'object' && typeof asError.error.message === 'string' && asError.error.message.length > 0)
    return asError.error.message

  // Fall back to prettyjson for other errors
  return `\n${prettyjson.render(error)}`
}

export async function check2FAAccessForOrg(supabase: SupabaseClient<Database>, orgId: string, silent = false): Promise<void> {
  const { data: reject2fa, error } = await supabase.rpc('reject_access_due_to_2fa_for_org', { org_id: orgId })
  if (error) {
    if (!silent)
      log.error(`Cannot check 2FA compliance: ${error.message}`)
    throw new Error(`Cannot check 2FA compliance: ${error.message}`)
  }
  if (reject2fa) {
    if (!silent)
      log.error(`🔐 Access Denied: 2FA Required. Enable 2FA at ${consoleWebUrl('/settings/account')}`)
    throw new Error('2FA required for this organization')
  }
}

type TagKey = Lowercase<string>
/** Tag Type */
type Tags = Record<TagKey, string | number | boolean>
type Parser = 'markdown' | 'text'
/**
 * Options for publishing LogSnag events
 */
interface TrackOptions {
  /**
   * Channel name
   * example: "waitlist"
   */
  channel: string
  /**
   * Event name
   * example: "User Joined"
   */
  event: string
  /**
   * Event description
   * example: "joe@example.com joined waitlist"
   */
  description?: string
  /**
   * User ID
   * example: "user-123"
   */
  user_id?: string
  /**
   * Organization ID for actor-scoped tracking.
   */
  org_id?: string
  /**
   * Tracking payload contract version.
   */
  tracking_version?: number
  /**
   * Event icon (emoji)
   * must be a single emoji
   * example: "🎉"
   */
  icon?: string
  /**
   * Event tags
   * example: { username: "mattie" }
   */
  tags?: Tags
  /**
   * Send push notification
   */
  notify?: boolean
  /**
   * Parser for description
   */
  parser?: Parser
  /**
   * Event timestamp
   */
  timestamp?: number | Date
}

export function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

interface PromptInteractivityOptions {
  silent?: boolean
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  ci?: boolean
}

export function canPromptInteractively({
  silent = false,
  stdinIsTTY = !!stdin.isTTY,
  stdoutIsTTY = !!stdout.isTTY,
  ci = isCI,
}: PromptInteractivityOptions = {}) {
  return !silent && stdinIsTTY && stdoutIsTTY && !ci
}

export function projectIsMonorepo(dir: string) {
  return isMonorepo(dir) || isNXMonorepo(dir)
}

export function findRoot(dir: string) {
  if (isMonorepo(dir)) {
    return findMonorepoRoot(dir)
  }
  else if (isNXMonorepo(dir)) {
    return findNXMonorepoRoot(dir)
  }
  return dir
}

// do not expose this function this prevent missuses
function readPackageJson(f: string = findRoot(cwd()), file: string | undefined = undefined) {
  const fileSplit = file?.split(',')[0]
  if (fileSplit) {
    if (!existsSync(fileSplit)) {
      const message = `Package.json at ${fileSplit} does not exist`
      log.error(message)
      throw new Error(message)
    }
  }
  const packageJson = readFileSync(fileSplit ?? join(f, PACKNAME))
  return JSON.parse(packageJson as any)
}

export function getPackageScripts(f: string = findRoot(cwd()), file: string | undefined = undefined): Record<string, string> {
  const packageJson = readPackageJson(f, file)
  return packageJson.scripts
}
export function getBundleVersion(f: string = findRoot(cwd()), file: string | undefined = undefined): string {
  const packageJson = readPackageJson(f, file)
  return packageJson.version ?? ''
}

function returnVersion(version: string) {
  const tmpVersion = version.replace('^', '').replace('~', '')
  if (canParse(tmpVersion)) {
    try {
      const parsed = parse(tmpVersion)
      return format(parsed)
    }
    catch {
      return tmpVersion
    }
  }
  return tmpVersion
}

/**
 * Get the actual installed version of a package from node_modules (not from package.json)
 * Uses multiple resolution strategies to find the installed version:
 * 1. require.resolve - Works with all package managers
 * 2. Walk up node_modules - Handles hoisted dependencies in monorepos
 * 3. Native config files (iOS/Android) - For @capgo/capacitor-updater only
 * 4. Fallback to declared version in package.json
 *
 * @param packageName - The package name to check
 * @param rootDir - The root directory of the project
 * @param packageJsonPath - Optional custom package.json path provided by user (takes priority if provided)
 */
export async function getInstalledVersion(packageName: string, rootDir: string = cwd(), packageJsonPath?: string): Promise<string | null> {
  const providedPackageJsonFiles = packageJsonPath
    ? packageJsonPath
        .split(',')
        .map(packageJsonPathItem => packageJsonPathItem.trim())
        .filter(Boolean)
    : []

  const candidateBaseDirs: string[] = []
  const addCandidateDir = (dir: string) => {
    const normalized = resolve(dir)
    if (!candidateBaseDirs.includes(normalized))
      candidateBaseDirs.push(normalized)
  }

  for (const packageJsonFile of providedPackageJsonFiles) {
    const resolvedPackageJson = resolve(rootDir, packageJsonFile)
    if (existsSync(resolvedPackageJson))
      addCandidateDir(dirname(resolvedPackageJson))
  }

  addCandidateDir(resolve(rootDir))
  addCandidateDir(cwd())

  // Priority 1: Use require.resolve to find the actual installed package
  // This works with all package managers (npm, yarn, pnpm, bun) and monorepos
  for (const baseDir of candidateBaseDirs) {
    try {
      const packageJsonFile = `${packageName}/package.json`
      // Create require from baseDir context to resolve from the right location
      const { createRequire } = await import('node:module')
      const requireFromBase = createRequire(join(baseDir, 'package.json'))
      const resolvedPath = requireFromBase.resolve(packageJsonFile)
      const pkg = JSON.parse(readFileSync(resolvedPath, 'utf-8'))
      if (pkg.version)
        return pkg.version
    }
    catch {
      // try next candidate directory
    }
  }

  // Priority 2: Walk up directories looking for node_modules (handles monorepos with hoisting)
  for (const baseDir of candidateBaseDirs) {
    let currentDir = baseDir
    const currentRoot = path.parse(currentDir).root
    while (currentDir !== currentRoot) {
      const nodeModulesPath = join(currentDir, 'node_modules', packageName, PACKNAME)
      if (existsSync(nodeModulesPath)) {
        try {
          const pkg = JSON.parse(readFileSync(nodeModulesPath, 'utf-8'))
          if (pkg.version)
            return pkg.version
        }
        catch {
          // Continue walking up
        }
      }
      const parentDir = dirname(currentDir)
      if (parentDir === currentDir)
        break
      currentDir = parentDir
    }
  }

  // Priority 3: Check native config files (iOS Podfile or Android gradle) - only for @capgo/capacitor-updater
  if (packageName === '@capgo/capacitor-updater') {
    let packagePath: string | null = null

    // Try iOS Podfile
    const podfilePath = join(rootDir, 'ios', 'App', 'Podfile')
    if (existsSync(podfilePath)) {
      try {
        const podfileContent = readFileSync(podfilePath, 'utf-8')
        // Look for: pod 'CapgoCapacitorUpdater', :path => '../../node_modules/@capgo/capacitor-updater'
        const match = podfileContent.match(/pod\s+['"]CapgoCapacitorUpdater['"],\s*:path\s*=>\s*['"]([^'"]+)['"]/)
        if (match?.[1]) {
          // Resolve relative path from ios/App directory
          packagePath = resolve(join(rootDir, 'ios', 'App', match[1]))
        }
      }
      catch {
        // Continue to try Android
      }
    }

    // Try Android capacitor.settings.gradle if iOS didn't work
    if (!packagePath) {
      const gradlePath = join(rootDir, 'android', 'capacitor.settings.gradle')
      if (existsSync(gradlePath)) {
        try {
          const gradleContent = readFileSync(gradlePath, 'utf-8')
          // Look for: project(':capgo-capacitor-updater').projectDir = new File('../node_modules/@capgo/capacitor-updater/android')
          const match = gradleContent.match(/project\(':capgo-capacitor-updater'\)\.projectDir\s*=\s*new\s+File\(['"]([^'"]+)['"]/)
          if (match?.[1]) {
            // Resolve relative path from android directory, remove /android suffix
            const fullPath = resolve(join(rootDir, 'android', match[1]))
            packagePath = fullPath.replace(/\/android$/, '')
          }
        }
        catch {
          // Both failed
        }
      }
    }

    // Read package.json from the resolved path
    if (packagePath) {
      const pkgJsonPath = join(packagePath, PACKNAME)
      if (existsSync(pkgJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
          if (pkg.version)
            return pkg.version
        }
        catch {
          // Fall through to final fallback
        }
      }
    }
  }

  // Priority 5: Final fallback - use default package.json location (declared version)
  try {
    const normalizedPackageJsonPath = packageJsonPath
      ? packageJsonPath
          .split(',')
          .map(path => path.trim())
          .filter(Boolean)
          .join(',')
      : packageJsonPath
    const dependencies = await getAllPackagesDependencies(rootDir, normalizedPackageJsonPath)
    const version = dependencies.get(packageName)
    if (version)
      return version
  }
  catch {
    // All methods failed
  }

  return null
}

export async function getAllPackagesDependencies(f: string = findRoot(cwd()), file: string | undefined = undefined) {
  // if file contain , split by comma and return the array
  let files = file?.split(',').map(file => file.trim()).filter(Boolean)
  files ??= [join(f, PACKNAME)]
  if (files) {
    for (const file of files) {
      if (!existsSync(file)) {
        const message = `Package.json at ${file} does not exist`
        log.error(message)
        throw new Error(message)
      }
    }
  }
  const dependencies = new Map<string, string>()

  // Import createRequire once for use in version resolution
  const { createRequire } = await import('node:module')

  for (const file of files) {
    const packageJson = readFileSync(file)
    const pkg = JSON.parse(packageJson as any)
    const packageDir = dirname(file)

    // Helper function to resolve actual installed version from node_modules
    const resolveInstalledVersion = (depName: string, declaredVersion: string): string => {
      // Try to find the actual installed version from node_modules
      try {
        // Use require.resolve to find the package
        const requireFromBase = createRequire(join(packageDir, 'package.json'))
        const resolvedPath = requireFromBase.resolve(`${depName}/package.json`)
        const depPkg = JSON.parse(readFileSync(resolvedPath, 'utf-8'))
        if (depPkg.version) {
          return depPkg.version
        }
      }
      catch {
        // require.resolve failed, try direct node_modules lookup
      }

      // Walk up directories looking for node_modules (handles monorepos with hoisting)
      let currentDir = packageDir
      const root = path.parse(currentDir).root
      while (currentDir !== root) {
        const nodeModulesPath = join(currentDir, 'node_modules', depName, PACKNAME)
        if (existsSync(nodeModulesPath)) {
          try {
            const depPkg = JSON.parse(readFileSync(nodeModulesPath, 'utf-8'))
            if (depPkg.version) {
              return depPkg.version
            }
          }
          catch {
            // Continue walking up
          }
        }
        const parentDir = dirname(currentDir)
        if (parentDir === currentDir)
          break
        currentDir = parentDir
      }

      // Fall back to declared version (stripped of ^ and ~)
      return returnVersion(declaredVersion)
    }

    for (const dependency in pkg.dependencies) {
      dependencies.set(dependency, resolveInstalledVersion(dependency, pkg.dependencies[dependency]))
    }
    for (const dependency in pkg.devDependencies) {
      dependencies.set(dependency, resolveInstalledVersion(dependency, pkg.devDependencies[dependency]))
    }
  }
  return dependencies
}

export async function getDeclaredPackageVersionMap(f: string = findRoot(cwd()), file: string | undefined = undefined) {
  // if file contain , split by comma and return the array
  let files = file?.split(',').map(file => file.trim()).filter(Boolean)
  files ??= [join(f, PACKNAME)]
  if (files) {
    for (const file of files) {
      if (!existsSync(file)) {
        const message = `Package.json at ${file} does not exist`
        log.error(message)
        throw new Error(message)
      }
    }
  }

  const dependencies = new Map<string, string>()

  for (const file of files) {
    const packageJson = readFileSync(file)
    const pkg = JSON.parse(packageJson as any)

    for (const dependency in (pkg.dependencies ?? {})) {
      if (typeof pkg.dependencies[dependency] === 'string')
        dependencies.set(dependency, pkg.dependencies[dependency])
    }
    for (const dependency in (pkg.devDependencies ?? {})) {
      if (typeof pkg.devDependencies[dependency] === 'string')
        dependencies.set(dependency, pkg.devDependencies[dependency])
    }
  }

  return dependencies
}

async function getConfigFrom(loader: () => Promise<ExtConfigPairs | undefined>, silent = false): Promise<ExtConfigPairs> {
  try {
    const extConfig = await loader()
    if (!extConfig) {
      const message = 'No capacitor config file found, run `cap init` first'
      if (!silent)
        log.error(message)
      throw new Error(message)
    }
    return extConfig
  }
  catch (err) {
    const message = `No capacitor config file found, run \`cap init\` first ${formatError(err)}`
    if (!silent)
      log.error(message)
    throw new Error(message)
  }
}

export function getConfig(silent = false) {
  return getConfigFrom(loadConfig, silent)
}

/** Loads the source config that a subsequent mutation will write. */
export function getConfigForWrite(silent = false) {
  return getConfigFrom(loadConfigForWrite, silent)
}

export async function updateConfigbyKey(key: string, newConfig: any): Promise<ExtConfigPairs> {
  const extConfig = await getConfigForWrite()

  if (extConfig?.config) {
    extConfig.config.plugins ??= {}
    extConfig.config.plugins.extConfig ??= {}
    extConfig.config.plugins[key] ??= {}

    extConfig.config.plugins[key] = {
      ...extConfig.config.plugins[key],
      ...newConfig,
    }
    // console.log('extConfig', extConfig)
    await writeConfig(key, extConfig)
  }
  return extConfig
}

export async function updateConfigUpdater(newConfig: any): Promise<ExtConfigPairs> {
  return updateConfigbyKey('CapacitorUpdater', newConfig)
}

export async function getLocalConfig(silent = false) {
  try {
    const extConfig = await getConfig(silent)
    const capConfig: CapgoConfig = {
      host: (extConfig?.config?.plugins?.CapacitorUpdater?.localHost || defaultHost) as string,
      hostWeb: (extConfig?.config?.plugins?.CapacitorUpdater?.localWebHost || defaultHostWeb) as string,
      hostFilesApi: (extConfig?.config?.plugins?.CapacitorUpdater?.localApiFiles || defaultFileHost) as string,
      hostApi: (extConfig?.config?.plugins?.CapacitorUpdater?.localApi || defaultApiHost) as string,
    }

    if (extConfig?.config?.plugins?.CapacitorUpdater?.localSupa && extConfig?.config?.plugins?.CapacitorUpdater?.localSupaAnon) {
      if (!silent)
        log.info('Using custom supabase instance from capacitor.config.json')
      capConfig.supaKey = extConfig?.config?.plugins?.CapacitorUpdater?.localSupaAnon
      capConfig.supaHost = extConfig?.config?.plugins?.CapacitorUpdater?.localSupa
    }
    return capConfig
  }
  catch {
    return {
      host: defaultHost,
      hostWeb: defaultHostWeb,
      hostFilesApi: defaultFileHost,
      hostApi: defaultApiHost,
    }
  }
}
// eslint-disable-next-line regexp/no-unused-capturing-group
const nativeFileRegex = /([A-Za-z0-9]+)\.(java|swift|kt|scala)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function packageDeclaresNativePlugin(packageJson: unknown): boolean {
  if (!isRecord(packageJson))
    return false

  const capacitor = packageJson.capacitor
  if (isRecord(capacitor) && (capacitor.ios !== undefined || capacitor.android !== undefined))
    return true

  return false
}

function dependencyDeclaresNativePlugin(dependencyFolderPath: string): boolean {
  if (existsSync(join(dependencyFolderPath, 'plugin.xml')))
    return true

  const packageJsonPath = join(dependencyFolderPath, PACKNAME)
  if (!existsSync(packageJsonPath))
    return false

  try {
    return packageDeclaresNativePlugin(JSON.parse(readFileSync(packageJsonPath, 'utf-8')))
  }
  catch {
    return false
  }
}

interface CapgoConfig {
  supaHost?: string
  supaKey?: string
  host: string
  hostWeb: string
  hostFilesApi: string
  hostApi: string
}
export async function getRemoteConfig(silent = false, signal?: AbortSignal) {
  // call host + /api/get_config and parse the result as json using fetch
  const localConfig = await getLocalConfig(silent)
  try {
    const response = await fetch(`${localConfig.hostApi}/private/config`, signal ? { signal } : {})
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    const data = await response.json() as CapgoConfig
    return { ...data, ...localConfig } as CapgoConfig
  }
  catch {
    if (!silent)
      log.info(`Local config ${formatError(localConfig)}`)
    return localConfig
  }
}

interface CapgoFilesConfig {
  partialUpload: boolean
  partialUploadForced: boolean
  TUSUpload: boolean
  TUSUploadForced: boolean
  maxUploadLength: number
  maxChunkSize: number
  alertUploadSize: number
}

export async function getRemoteFileConfig() {
  const localConfig = await getLocalConfig()
  // call host + /api/get_config and parse the result as json using fetch
  try {
    const response = await fetch(`${localConfig.hostFilesApi}/files/config`)
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    return await response.json() as CapgoFilesConfig
  }
  catch {
    return {
      partialUpload: false,
      TUSUpload: false,
      partialUploadForced: false,
      TUSUploadForced: false,
      maxUploadLength: MAX_UPLOAD_LENGTH_BYTES,
      maxChunkSize: MAX_CHUNK_SIZE_BYTES,
      alertUploadSize: ALERT_UPLOAD_SIZE_BYTES,
    }
  }
}

export function normalizeSupabaseHost(host: string): string {
  const parsed = new URL(host)
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('Invalid Supabase host protocol')
  if (parsed.username || parsed.password)
    throw new Error('Supabase host must not include credentials')
  if (parsed.search || parsed.hash)
    throw new Error('Supabase host must not include query parameters or fragments')

  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${normalizedPath}`
}

export function formatCapgoApiErrorBody(body: unknown): string {
  if (!body || typeof body !== 'object')
    return ''
  const record = body as { error?: string, message?: string, status?: string }
  return [record.error, record.message, record.status].filter(Boolean).join(' | ')
}

/** Resolve Capgo public API base URL for CLI mutations (app create/update, etc.). */
export function resolveConfiguredCapgoPublicApiHost(config: {
  hostApi: string
  supaHost?: string
  supaKey?: string
}): string {
  if (config.supaHost && config.supaKey && config.hostApi === defaultApiHost)
    return `${normalizeSupabaseHost(config.supaHost)}/functions/v1`

  return config.hostApi
}

export async function resolveCapgoPublicApiHost(
  options?: { supaHost?: string, supaAnon?: string },
  silent = true,
): Promise<string> {
  if (options?.supaHost && options?.supaAnon)
    return `${normalizeSupabaseHost(options.supaHost)}/functions/v1`

  const localConfig = await getLocalConfig(silent)
  if (localConfig.supaHost && localConfig.supaKey)
    return resolveConfiguredCapgoPublicApiHost(localConfig)

  const config = await getRemoteConfig(silent)
  return config.hostApi
}

export async function createSupabaseClient(apikey: string, supaHost?: string, supaKey?: string, silent = false, instrument = true, signal?: AbortSignal) {
  const config = await getRemoteConfig(silent, signal)
  if (supaHost && supaKey) {
    if (!silent)
      log.info('Using custom supabase instance from provided options')
    config.supaHost = supaHost
    config.supaKey = supaKey
  }
  if (!config.supaHost || !config.supaKey) {
    if (!silent)
      log.error('Cannot connect to server please try again later')
    throw new Error('Cannot connect to server please try again later')
  }
  const normalizedSupaHost = normalizeSupabaseHost(config.supaHost)
  // Custom Supabase hosts are an explicit CLI feature; normalizeSupabaseHost constrains the accepted URL shape first.
  return createClient<Database>(normalizedSupaHost, config.supaKey, { // NOSONAR
    auth: {
      persistSession: false,
    },
    global: {
      headers: {
        capgkey: apikey,
      },
      ...(isSupabaseInstrumentationEnabled() && instrument ? { fetch: createTimedFetch() } : {}),
    },
  })
}

export async function isPayingOrg(supabase: SupabaseClient<Database>, orgId: string): Promise<boolean> {
  const { data } = await supabase
    .rpc('is_paying_org', { orgid: orgId })
    .single()
  return data || false
}

export async function isTrialOrg(supabase: SupabaseClient<Database>, orgId: string): Promise<number> {
  const { data } = await supabase
    .rpc('is_trial_org', { orgid: orgId })
    .single()
  return data || 0
}

export async function isAllowedActionOrg(supabase: SupabaseClient<Database>, orgId: string): Promise<boolean> {
  const { data } = await supabase
    .rpc('is_allowed_action_org', { orgid: orgId })
    .single()
  return !!data
}

export async function isAllowedActionAppIdApiKey(supabase: SupabaseClient<Database>, appId: string, apikey: string): Promise<boolean> {
  const { data } = await supabase
    .rpc('is_allowed_action', { apikey, appid: appId })
    .single()

  return !!data
}

export async function checkRemoteCliMessages(supabase: SupabaseClient<Database>, orgId: string, cliVersion: string) {
  const { data: messages, error } = await supabase.rpc('get_organization_cli_warnings', { orgid: orgId, cli_version: cliVersion })
  if (error) {
    log.error(`Cannot get cli warnings: ${formatError(error)}`)
    return
  }
  if (messages.length > 0) {
    log.warn(`Found ${messages.length} cli warnings for your organization.`)
    let fatalError: Error | null = null
    for (const message of messages) {
      if (typeof message !== 'object' || typeof (message as any).message !== 'string' || typeof (message as any).fatal !== 'boolean') {
        log.error(`Invalid cli warning: ${message}`)
        continue
      }
      const msg = (message as any) as { message: string, fatal: boolean }
      if (msg.fatal) {
        log.error(`${msg.message.replaceAll('\\n', '\n')}`)
        fatalError = new Error(msg.message)
      }
      else {
        log.warn(`${msg.message.replaceAll('\\n', '\n')}`)
      }
    }
    if (fatalError) {
      log.error('Please fix the warnings and try again.')
      throw fatalError
    }
    log.info('End of cli warnings.')
  }
}

export async function checkPlanValid(supabase: SupabaseClient<Database>, orgId: string, apikey: string, appId?: string, warning = true) {
  const config = await getRemoteConfig()

  // isAllowedActionAppIdApiKey was updated in the orgs_v3 migration to work with the new system
  const validPlan = await (appId ? isAllowedActionAppIdApiKey(supabase, appId, apikey) : isAllowedActionOrg(supabase, orgId))
  if (!validPlan) {
    log.error(`You need to upgrade your plan to continue to use capgo.\n Upgrade here: ${config.hostWeb}/settings/organization/plans\n`)
    wait(100)
    import('open')
      .then((module) => {
        module.default(`${config.hostWeb}/settings/organization/plans`)
      })
    wait(500)
    throw new Error('Plan upgrade required')
  }
  const [trialDays, ispaying] = await Promise.all([
    isTrialOrg(supabase, orgId),
    isPayingOrg(supabase, orgId),
  ])
  if (trialDays > 0 && warning && !ispaying)
    log.warn(`WARNING !!\nTrial expires in ${trialDays} days, upgrade here: ${config.hostWeb}/settings/organization/plans\n`)
}

export async function checkPlanValidUpload(supabase: SupabaseClient<Database>, orgId: string, apikey: string, appId?: string, warning = true) {
  const config = await getRemoteConfig()

  // Pass appid so RBAC evaluates the app scope. Without it,
  // API keys with app-scoped bindings can be rejected and the org-scope
  // plan check returns false even when the plan is healthy. PostgREST
  // routes to the 3-arg overload at runtime; the `as never` cast bypasses
  // a `supabase gen types` quirk that collapses overloads sharing the
  // same name (the 3-arg signature exists in the DB but is not emitted
  // by the generator).
  const args = { orgid: orgId, actions: ['storage'], appid: appId } as never
  const { data: validPlan, error: validPlanError } = await supabase.rpc('is_allowed_action_org_action', args)
  if (validPlanError) {
    const message = `Cannot validate upload plan: ${formatError(validPlanError)}`
    log.error(message)
    throw new Error(message)
  }
  if (!validPlan) {
    log.error(`You need to upgrade your plan to continue to use capgo.\n Upgrade here: ${config.hostWeb}/settings/organization/plans\n`)
    wait(100)
    import('open')
      .then((module) => {
        module.default(`${config.hostWeb}/settings/organization/plans`)
      })
    wait(500)
    throw new Error('Plan upgrade required for upload')
  }
  const [trialDays, ispaying] = await Promise.all([
    isTrialOrg(supabase, orgId),
    isPayingOrg(supabase, orgId),
  ])
  if (trialDays > 0 && warning && !ispaying)
    log.warn(`WARNING !!\nTrial expires in ${trialDays} days, upgrade here: ${config.hostWeb}/settings/organization/plans\n`)
}

function tryReadKey(path: string): string | undefined {
  try {
    if (!existsSync(path))
      return undefined
    return readFileSync(path, 'utf8').trim() || undefined
  }
  catch {
    // Swallow permission errors, TOCTOU races, transient fs issues —
    // the contract is silent best-effort resolution.
    return undefined
  }
}

export function findSavedKeySilent(): string | undefined {
  const envKey = env.CAPGO_TOKEN?.trim()
  if (envKey)
    return envKey
  const globalKey = tryReadKey(`${homedir()}/.capgo`)
  if (globalKey)
    return globalKey
  return tryReadKey(`.capgo`)
}

export function findSavedKey(quiet = false) {
  const envKey = env.CAPGO_TOKEN?.trim()
  if (envKey) {
    if (!quiet)
      log.info('Use CAPGO_TOKEN environment variable')
    return envKey
  }
  // search for key in home dir
  const userHomeDir = homedir()
  let key
  let keyPath = `${userHomeDir}/.capgo`
  if (existsSync(keyPath)) {
    if (!quiet)
      log.info(`Use global API key ${keyPath}`)
    key = readFileSync(keyPath, 'utf8').trim()
  }
  keyPath = `.capgo`
  if (!key && existsSync(keyPath)) {
    if (!quiet)
      log.info(`Use local API key ${keyPath}`)
    key = readFileSync(keyPath, 'utf8').trim()
  }
  if (!key) {
    const message = `Cannot find API key in local folder or global, please login first with ${getPMAndCommand().runner} @capgo/cli login`
    log.error(message)
    throw new Error(message)
  }
  return key
}

async function* getFiles(dir: string): AsyncGenerator<string> {
  const dirents = await readdirSync(dir, { withFileTypes: true })
  for (const dirent of dirents) {
    const res = resolve(dir, dirent.name)
    if (
      dirent.isDirectory()
      && !dirent.name.startsWith('.')
      && !dirent.name.startsWith('node_modules')
      && !dirent.name.startsWith('dist')
    ) {
      yield* getFiles(res)
    }
    else {
      yield res
    }
  }
}

export function getContentType(filename: string): string {
  // Remove .br extension if present to get the actual file type
  const cleanFilename = filename.endsWith('.br') ? filename.slice(0, -3) : filename
  const ext = cleanFilename.split('.').pop()?.toLowerCase() || ''

  // MIME type mapping for web bundle files
  const mimeTypes: Record<string, string> = {
    // HTML
    html: 'text/html',
    htm: 'text/html',
    // JavaScript
    js: 'application/javascript',
    mjs: 'application/javascript',
    cjs: 'application/javascript',
    // CSS
    css: 'text/css',
    // JSON
    json: 'application/json',
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    avif: 'image/avif',
    // Fonts
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
    // Media
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    mp4: 'video/mp4',
    webm: 'video/webm',
    // Other web assets
    xml: 'application/xml',
    txt: 'text/plain',
    md: 'text/markdown',
    pdf: 'application/pdf',
    wasm: 'application/wasm',
    map: 'application/json',
  }

  return mimeTypes[ext] || 'application/octet-stream'
}

type ProjectFramework = 'angular' | 'nuxtjs' | 'nextjs' | 'sveltekit' | 'svelte' | 'vue' | 'react'

function getProjectTypeWithLanguage(framework: ProjectFramework, isTypeScript: boolean) {
  return `${framework}-${isTypeScript ? 'ts' : 'js'}`
}

function logFoundProject(framework: ProjectFramework, quiet: boolean) {
  if (!quiet)
    log.info(`Found ${framework} project`)
}

function detectProjectFrameworkFromConfig(projectDir: string): ProjectFramework | undefined {
  if (existsSync(resolve(projectDir, 'angular.json')))
    return 'angular'
  if (existsSync(resolve(projectDir, 'nuxt.config.js')) || existsSync(resolve(projectDir, 'nuxt.config.ts')))
    return 'nuxtjs'
  if (existsSync(resolve(projectDir, 'next.config.js')) || existsSync(resolve(projectDir, 'next.config.mjs')) || existsSync(resolve(projectDir, 'next.config.ts')))
    return 'nextjs'
  if (existsSync(resolve(projectDir, 'svelte.config.js')) || existsSync(resolve(projectDir, 'svelte.config.ts')))
    return 'sveltekit'
  if (existsSync(resolve(projectDir, 'vue.config.js')) || existsSync(resolve(projectDir, 'vue.config.ts')))
    return 'vue'
}

function detectProjectFrameworkFromDependencies(dependencies: Map<string, string>): ProjectFramework | undefined {
  if (dependencies.get('@angular/core'))
    return 'angular'
  if (dependencies.get('nuxt'))
    return 'nuxtjs'
  if (dependencies.get('next'))
    return 'nextjs'
  if (dependencies.get('@sveltejs/kit'))
    return 'sveltekit'
  if (dependencies.get('svelte'))
    return 'svelte'
  if (dependencies.get('vue'))
    return 'vue'
  if (dependencies.get('react'))
    return 'react'
}

async function detectProjectTypeInDir(projectDir: string, quiet: boolean): Promise<string | undefined> {
  const isTypeScript = existsSync(resolve(projectDir, 'tsconfig.json'))
  const frameworkFromConfig = detectProjectFrameworkFromConfig(projectDir)
  if (frameworkFromConfig) {
    logFoundProject(frameworkFromConfig, quiet)
    return getProjectTypeWithLanguage(frameworkFromConfig, isTypeScript)
  }

  const packageJsonPath = resolve(projectDir, PACKNAME)
  if (!existsSync(packageJsonPath))
    return undefined

  const dependencies = await getAllPackagesDependencies(undefined, packageJsonPath)
  const frameworkFromDependencies = detectProjectFrameworkFromDependencies(dependencies)
  if (!frameworkFromDependencies)
    return undefined

  logFoundProject(frameworkFromDependencies, quiet)
  return getProjectTypeWithLanguage(frameworkFromDependencies, isTypeScript)
}

function addProjectTypeCandidateDir(dirs: string[], dir: string | undefined) {
  if (!dir)
    return
  const normalized = resolve(dir)
  if (!dirs.includes(normalized))
    dirs.push(normalized)
}

function getNearestPackageDir(startDir: string) {
  let currentDir = startDir
  const rootDir = path.parse(currentDir).root

  while (true) {
    if (existsSync(resolve(currentDir, PACKNAME)))
      return currentDir
    if (currentDir === rootDir)
      return undefined
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir)
      return undefined
    currentDir = parentDir
  }
}

function getProjectTypeCandidateDirs(packageJsonPath?: string) {
  const dirs: string[] = []
  const firstPackageJsonPath = packageJsonPath
    ?.split(',')
    .map(path => path.trim())
    .filter(Boolean)[0]

  if (firstPackageJsonPath)
    addProjectTypeCandidateDir(dirs, dirname(resolve(firstPackageJsonPath)))

  addProjectTypeCandidateDir(dirs, getNearestPackageDir(cwd()))
  addProjectTypeCandidateDir(dirs, findRoot(cwd()))
  return dirs
}

export async function findProjectType(options?: { quiet?: boolean, packageJsonPath?: string }) {
  const pwd = cwd()
  let isTypeScript = false
  const quiet = options?.quiet ?? false

  for (const candidateDir of getProjectTypeCandidateDirs(options?.packageJsonPath)) {
    const detected = await detectProjectTypeInDir(candidateDir, quiet)
    if (detected)
      return detected
  }

  const tsConfigPath = resolve(pwd, 'tsconfig.json')
  if (existsSync(tsConfigPath))
    isTypeScript = true

  for await (const f of getFiles(pwd)) {
    if (f.includes('angular.json')) {
      logFoundProject('angular', quiet)
      return getProjectTypeWithLanguage('angular', isTypeScript)
    }
    if (f.includes('nuxt.config.js') || f.includes('nuxt.config.ts')) {
      logFoundProject('nuxtjs', quiet)
      return getProjectTypeWithLanguage('nuxtjs', isTypeScript)
    }
    if (f.includes('next.config.js') || f.includes('next.config.mjs') || f.includes('next.config.ts')) {
      logFoundProject('nextjs', quiet)
      return getProjectTypeWithLanguage('nextjs', isTypeScript)
    }
    if (f.includes('svelte.config.js') || f.includes('svelte.config.ts')) {
      logFoundProject('sveltekit', quiet)
      return getProjectTypeWithLanguage('sveltekit', isTypeScript)
    }
    if (f.includes('vue.config.js') || f.includes('vue.config.ts')) {
      logFoundProject('vue', quiet)
      return getProjectTypeWithLanguage('vue', isTypeScript)
    }
    if (f.includes(PACKNAME)) {
      const folder = dirname(f)
      const dependencies = await getAllPackagesDependencies(folder)
      const frameworkFromDependencies = detectProjectFrameworkFromDependencies(dependencies)
      if (frameworkFromDependencies) {
        logFoundProject(frameworkFromDependencies, quiet)
        return getProjectTypeWithLanguage(frameworkFromDependencies, isTypeScript)
      }
    }
  }

  return 'unknown'
}

export function findMainFileForProjectType(projectType: string, isTypeScript: boolean, rootDir: string = cwd()): string | null {
  if (projectType === 'angular-js' || projectType === 'angular-ts') {
    return isTypeScript ? 'src/main.ts' : 'src/main.js'
  }
  if (projectType === 'nextjs-js' || projectType === 'nextjs-ts') {
    return isTypeScript ? 'src/app/layout.tsx' : 'src/app/layout.js'
  }
  if (projectType === 'svelte-js' || projectType === 'svelte-ts') {
    return isTypeScript ? 'src/main.ts' : 'src/main.js'
  }
  if (projectType === 'vue-js' || projectType === 'vue-ts') {
    return isTypeScript ? 'src/main.ts' : 'src/main.js'
  }
  if (projectType === 'react-js' || projectType === 'react-ts') {
    // Vite React projects commonly use src/main.tsx, while CRA uses src/index.tsx
    // Check for main first, then fall back to index
    const mainExt = isTypeScript ? 'src/main.tsx' : 'src/main.js'
    const indexExt = isTypeScript ? 'src/index.tsx' : 'src/index.js'
    if (existsSync(resolve(rootDir, mainExt))) {
      return mainExt
    }
    return indexExt
  }
  return null
}
// create a function to find the right command to build the project in static mode depending on the project type

export async function findBuildCommandForProjectType(projectType: string) {
  const framework = projectType.replace(/-(?:ts|js)$/, '')
  if (framework === 'angular') {
    log.info('Angular project detected')
    return 'build'
  }

  if (framework === 'nuxtjs') {
    log.info('Nuxtjs project detected')
    return 'generate'
  }

  if (framework === 'nextjs') {
    log.info('Nextjs project detected')
    log.warn('Please make sure you have configured static export in your next.config.js: https://nextjs.org/docs/pages/building-your-application/deploying/static-exports')
    log.warn('Please make sure you have the output: \'export\' and distDir: \'dist\' in your next.config.js')
    const doContinue = await confirmC({ message: 'Do you want to continue?' })
    if (!doContinue) {
      const message = 'Build command selection aborted by user'
      log.error(message)
      throw new Error(message)
    }
    return 'build'
  }

  if (framework === 'sveltekit') {
    log.info('Sveltekit project detected')
    log.warn('Please make sure you have the adapter-static installed: https://kit.svelte.dev/docs/adapter-static')
    log.warn('Please make sure you have the pages: \'dist\' and assets: \'dest\', in your svelte.config.js adapter')
    const doContinue = await confirmC({ message: 'Do you want to continue?' })
    if (!doContinue) {
      const message = 'Build command selection aborted by user'
      log.error(message)
      throw new Error(message)
    }
    return 'build'
  }

  return 'build'
}

export async function findMainFile(silent = false, rootDir: string = cwd()) {
  // eslint-disable-next-line regexp/no-unused-capturing-group
  const mainRegex = /(main|index)\.(ts|tsx|js|jsx)$/
  // search for main.ts or main.js in local dir and subdirs
  let mainFile = ''
  const pwd = resolve(rootDir)
  const pwdL = pwd.split('/').length
  for await (const f of getFiles(pwd)) {
    // find number of folder in path after pwd
    const folders = f.split('/').length - pwdL
    if (folders <= 2 && mainRegex.test(f)) {
      mainFile = f
      if (!silent)
        log.info(`Found main file here ${f}`)
      break
    }
  }
  return mainFile
}

export async function updateOrCreateVersion(supabase: SupabaseClient<Database>, update: Database['public']['Tables']['app_versions']['Insert']) {
  return supabase.from('app_versions')
    .upsert(update, { onConflict: 'name,app_id' })
    .eq('app_id', update.app_id)
    .eq('name', update.name)
}

export async function uploadUrl(supabase: SupabaseClient<Database>, appId: string, name: string): Promise<string> {
  const data = {
    app_id: appId,
    name,
    version: 0,
  }
  try {
    const pathUploadLink = 'files/upload_link'
    const res = await supabase.functions.invoke(pathUploadLink, { body: JSON.stringify(data) })

    if (res.error) {
      // Handle error case
      if (res.error instanceof FunctionsHttpError) {
        const errorBody = await res.error.context.json()
        log.error(`Upload URL error: ${errorBody.status || JSON.stringify(errorBody)}`)
      }
      else {
        log.error(`Cannot get upload url: ${res.error.message}`)
      }
      return ''
    }

    return res.data.url
  }
  catch (error) {
    log.error(`Cannot get upload url ${formatError(error)}`)
  }
  return ''
}

async function* walkDirectory(dir: string): AsyncGenerator<string> {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkDirectory(fullPath)
    }
    else {
      yield fullPath
    }
  }
}

// Version required for Brotli support with .br extension
export const BROTLI_MIN_UPDATER_VERSION_V5 = '5.10.0'
export const BROTLI_MIN_UPDATER_VERSION_V6 = '6.25.0'
export const BROTLI_MIN_UPDATER_VERSION_V7 = '7.0.30'

export function isDeprecatedPluginVersion(parsedPluginVersion: SemVer, minFive = '5.10.0', minSix = '6.25.0', minSeven = '7.25.0'): boolean {
  // v5 is deprecated if < 5.10.0, v6 is deprecated if < 6.25.0, v7 is deprecated if < 7.25.0
  if (parsedPluginVersion.major === 5 && lessThan(parsedPluginVersion, parse(minFive))) {
    return true
  }
  if (parsedPluginVersion.major === 6 && lessThan(parsedPluginVersion, parse(minSix))) {
    return true
  }
  if (parsedPluginVersion.major === 7 && lessThan(parsedPluginVersion, parse(minSeven))) {
    return true
  }
  return false
}

export async function generateManifest(path: string): Promise<{ file: string, hash: string }[]> {
  const allFiles: { file: string, hash: string }[] = []
  const ignoredFiles = ['.DS_Store', '.git', '.gitignore', 'node_modules', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.spec.json', 'tsconfig.app.json', 'tsconfig.spec.json', 'tsconfig.app.json', 'tsconfig.spec.json']

  for await (const file of walkDirectory(path)) {
    if (ignoredFiles.some(ignoredFile => file.includes(ignoredFile))) {
      log.info(`Ignoring file ${file}, please ensure you have only required files in your dist folder`)
      continue
    }
    const buffer = readFileSync(file)
    // ignore files with size 0
    if (buffer.length === 0) {
      log.info(`Ignoring empty file ${file}, please ensure you have only required files in your dist folder`)
      continue
    }
    const hash = await getChecksum(buffer, 'sha256')
    let filePath = relative(path, file)
    if (filePath.startsWith('/'))
      filePath = filePath.substring(1)
    allFiles.push({ file: filePath, hash })
  }

  return allFiles
}

export type manifestType = Awaited<ReturnType<typeof generateManifest>>

// Zip contents are the user's responsibility, not Capgo's; Capgo packages the user-provided files as-is.
export async function zipFile(filePath: string): Promise<Buffer> {
  if (osPlatform() === 'win32') {
    return zipFileWindows(filePath)
  }
  else {
    return zipFileUnix(filePath)
  }
}

export function zipFileUnix(filePath: string) {
  const zip = new AdmZip()
  zip.addLocalFolder(filePath)
  return zip.toBuffer()
}

export async function zipFileWindows(filePath: string): Promise<Buffer> {
  log.info('Zipping file windows mode')
  const zip = new AdmZip()

  const addToZip = (folderPath: string, zipPath: string) => {
    const items = readdirSync(folderPath)

    for (const item of items) {
      const itemPath = join(folderPath, item)
      const stats = statSync(itemPath)

      if (stats.isFile()) {
        const fileContent = readFileSync(itemPath)
        zip.addFile(join(zipPath, item).split(sep).join('/'), fileContent)
      }
      else if (stats.isDirectory()) {
        addToZip(itemPath, join(zipPath, item))
      }
    }
  }

  addToZip(filePath, '')

  return zip.toBuffer()
}

export async function uploadTUS(apikey: string, data: Buffer, orgId: string, appId: string, name: string, spinner: ReturnType<typeof spinnerC>, localConfig: CapgoConfig, chunkSize: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    sendEvent(apikey, {
      channel: 'app',
      event: 'App TUS upload',
      icon: '⏫',
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': appId,
      },
      notify: false,
    })
    const upload = new tus.Upload(data as any, {
      endpoint: `${localConfig.hostFilesApi}/files/upload/attachments/`,
      // parallelUploads: multipart,
      chunkSize,
      retryDelays: [...TUS_UPLOAD_RETRY_DELAYS],
      metadataForPartialUploads: {
        filename: `orgs/${orgId}/apps/${appId}/${name}.zip`,
        filetype: 'application/gzip',
      },
      metadata: {
        filename: `orgs/${orgId}/apps/${appId}/${name}.zip`,
        filetype: 'application/zip',
      },
      headers: {
        Authorization: apikey,
      },
      // Callback for errors which cannot be fixed using retries
      onError(error) {
        log.error(`Error uploading bundle: ${error.message}`)
        if (error instanceof tus.DetailedError) {
          const body = error.originalResponse?.getBody()
          const jsonBody = JSON.parse(body || '{"error": "unknown error"}')
          reject(jsonBody.status || jsonBody.error || jsonBody.message || 'unknown error')
        }
        else {
          reject(error.message || error.toString() || 'unknown error')
        }
      },
      // Callback for reporting upload progress
      onProgress(bytesUploaded, bytesTotal) {
        const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2)
        spinner.message(`Uploaded ${percentage}%`)
      },
      // Callback for once the upload is completed
      async onSuccess() {
        await sendEvent(apikey, {
          channel: 'app',
          event: 'App TUS done',
          icon: '⏫',
          org_id: orgId,
          tracking_version: 2,
          tags: {
            'app-id': appId,
          },
          notify: false,
        }).catch()
        resolve(true)
      },
    })

    // Start the upload
    upload.start()
  })
}

export async function deletedFailedVersion(supabase: SupabaseClient<Database>, appId: string, name: string): Promise<void> {
  const data = {
    app_id: appId,
    name,
  }
  try {
    const pathFailed = 'private/delete_failed_version'
    const res = await supabase.functions.invoke(pathFailed, { body: JSON.stringify(data), method: 'DELETE' })

    if (res.error) {
      if (res.error instanceof FunctionsHttpError) {
        const errorBody = await res.error.context.json()
        log.error(`Cannot delete failed version: ${errorBody.status || JSON.stringify(errorBody)}`)
      }
      else {
        log.error(`Cannot delete failed version: ${res.error.message}`)
      }
      return
    }

    return res.data?.status
  }
  catch (error) {
    if (error instanceof FunctionsHttpError) {
      const errorBody = await error.context.json()
      log.error(`Cannot delete failed version: ${errorBody.message || JSON.stringify(errorBody)}`)
    }
    else {
      log.error(`Cannot delete failed version: ${formatError(error)}`)
    }
  }
}

export async function updateOrCreateChannel(supabase: SupabaseClient<Database>, update: Database['public']['Tables']['channels']['Insert']) {
  // console.log('updateOrCreateChannel', update)
  if (!update.app_id || !update.name || !update.created_by) {
    log.error('missing app_id, name, or created_by')
    return Promise.reject(new Error('missing app_id, name, or created_by'))
  }

  const { data, error } = await supabase
    .from('channels')
    .select()
    .eq('app_id', update.app_id)
    .eq('name', update.name)
    .single()
  if (data && !error) {
    return supabase
      .from('channels')
      .update(update)
      .eq('app_id', update.app_id)
      .eq('name', update.name)
      .select()
      .single()
  }

  return supabase
    .from('channels')
    .insert(update)
    .select()
    .single()
}

export async function sendEvent(capgkey: string, payload: TrackOptions & { notifyConsole?: boolean, nonPersonTags?: Record<string, string | number | boolean> }, verbose?: boolean, signal?: AbortSignal): Promise<void> {
  if (isTruthyEnvValue(env.CAPGO_DISABLE_TELEMETRY) || isTruthyEnvValue(env.CAPGO_DISABLE_POSTHOG))
    return

  try {
    // Attach the global analytics props as nonPersonTags — event properties the
    // backend never writes as PostHog person properties ($set) — built
    // DEFENSIVELY: a fault while reading them degrades to the caller's tags and
    // must never drop the event. sendEvent is the single send path that
    // trackEvent() and every direct caller funnel through, so OS/version
    // segmentation stays complete. Caller-supplied nonPersonTags win on conflict.
    let globalProps = {}
    try {
      globalProps = getGlobalAnalyticsProps()
    }
    catch (enrichError) {
      if (verbose)
        log.error(`Failed to enrich event tags, sending caller tags only: ${formatError(enrichError)}`)
    }
    const enrichedPayload = {
      ...payload,
      nonPersonTags: { ...globalProps, ...(payload.nonPersonTags ?? {}) },
    }
    if (verbose) {
      log.info(`Get remove config: for ${payload.event}`)
    }
    // Always fetch remote config silently — sendEvent is telemetry and must
    // not bypass an Ink-controlled stdout (e.g. during `capgo init`).
    const config = await getRemoteConfig(true, signal)
    if (verbose) {
      log.info(`Sending LogSnag event: ${JSON.stringify(enrichedPayload)}`)
    }
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 seconds timeout
    // Combine the internal timeout with any caller-supplied signal (e.g. the
    // analytics flush) so in-flight telemetry can be released promptly.
    const eventSignal = signal
      ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([controller.signal, signal]) : signal)
      : controller.signal

    try {
      const fetchResponse = await fetch(`${config.hostApi}/private/events`, {
        method: 'POST',
        body: JSON.stringify(enrichedPayload),
        headers: {
          'Content-Type': 'application/json',
          'capgkey': capgkey,
        },
        signal: eventSignal,
      })

      clearTimeout(timeoutId)

      if (!fetchResponse.ok) {
        throw new Error(`HTTP error! status: ${fetchResponse.status}`)
      }

      const response = await fetchResponse.json() as { error?: string }

      if (response.error && verbose) {
        log.error(`Failed to send LogSnag event: ${response.error}`)
      }
    }
    finally {
      clearTimeout(timeoutId)
    }
  }
  catch (error) {
    if (verbose) {
      log.error('Failed to send Stats event details:')
      log.error(formatError(error))
    }
  }
}

export function show2FADeniedError(organizationName?: string): never {
  log.error(`\n🔐 Access Denied: Two-Factor Authentication Required`)
  log.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  if (organizationName) {
    log.error(`\nThe organization "${organizationName}" requires all members to have 2FA enabled.`)
  }
  else {
    log.error(`\nThis organization requires all members to have 2FA enabled.`)
  }
  log.error(`\nTo regain access:`)
  log.error(`  1. Go to ${consoleWebUrl('/settings/account')}`)
  log.error(`  2. Enable Two-Factor Authentication on your account`)
  log.error(`  3. Try your command again`)
  log.error(`\nFor more information, visit: https://capgo.app/docs/webapp/2fa-enforcement/\n`)
  throw new Error('2FA required for this organization')
}

export async function filterOrgsByPermission(
  supabase: SupabaseClient<Database>,
  apikey: string,
  orgs: Organization[],
  permissionKey: string,
): Promise<Organization[]> {
  const checks = await Promise.all(
    orgs.map(async (org) => {
      const allowed = await hasCliPermission(supabase, apikey, permissionKey, { orgId: org.gid })
      return allowed ? org : null
    }),
  )
  return checks.filter((org): org is Organization => org !== null)
}

export async function getOrganizationListWithPermission(
  supabase: SupabaseClient<Database>,
  apikey: string,
  permissionKey: string,
): Promise<{ allOrganizations: Organization[], allowedOrganizations: Organization[] }> {
  const { error: orgError, data: allOrganizations } = await supabase.rpc('get_orgs_v7')

  if (orgError) {
    log.error('Cannot get the list of organizations - exiting')
    log.error(formatError(orgError))
    throw new Error('Cannot get the list of organizations')
  }

  if (allOrganizations.length === 0) {
    log.error('Could not get organization please create an organization first')
    throw new Error('No organizations available')
  }

  const allowedOrganizations = await filterOrgsByPermission(supabase, apikey, allOrganizations, permissionKey)

  if (allowedOrganizations.length === 0) {
    log.error(`Could not find organization with permission: ${permissionKey}`)
    throw new Error('Could not find organization with required permission')
  }

  return { allOrganizations, allowedOrganizations }
}

export async function getOrganizationWithPermission(
  supabase: SupabaseClient<Database>,
  apikey: string,
  permissionKey: string,
): Promise<Organization> {
  const { allOrganizations, allowedOrganizations } = await getOrganizationListWithPermission(supabase, apikey, permissionKey)

  const organizationUidRaw = (allowedOrganizations.length > 1)
    ? await select({
        message: 'Please pick the organization that you want to insert to',
        options: allowedOrganizations.map((org) => {
          const twoFaWarning = (org.enforcing_2fa && !org['2fa_has_access']) ? ' ⚠️ (2FA required)' : ''
          return { value: org.gid, label: `${org.name}${twoFaWarning}` }
        }),
      })
    : allowedOrganizations[0].gid

  if (isCancel(organizationUidRaw)) {
    log.error('Canceled organization selection, exiting')
    throw new Error('Organization selection cancelled')
  }

  const organizationUid = organizationUidRaw as string
  const organization = allOrganizations.find(org => org.gid === organizationUid)!

  if (organization.enforcing_2fa && !organization['2fa_has_access']) {
    show2FADeniedError(organization.name)
  }

  log.info(`Using the organization "${organization.name}" as the app owner`)
  return organization
}

export async function resolveUserIdFromApiKey(supabase: SupabaseClient<Database>, apikey: string, silent = false) {
  const { data: dataUser, error: userIdError } = await supabase
    .rpc('get_user_id', { apikey })
    .single()

  const userId = (dataUser || '').toString()

  if (!userId || userIdError) {
    if (!silent)
      log.error(`Invalid API key or insufficient permissions.`)
    throw new Error('Invalid API key or insufficient permissions.')
  }
  return userId
}

interface CliPermissionScope {
  orgId?: string | null
  appId?: string | null
  channelId?: number | null
}

export async function hasCliPermission(
  supabase: SupabaseClient<Database>,
  apikey: string,
  permissionKey: string,
  scope: CliPermissionScope = {},
): Promise<boolean> {
  const { data, error } = await supabase.rpc('cli_check_permission' as any, {
    apikey,
    permission_key: permissionKey,
    org_id: scope.orgId ?? null,
    app_id: scope.appId ?? null,
    channel_id: scope.channelId ?? null,
  })

  if (error) {
    log.error(`Cannot check permission ${permissionKey}`)
    log.error(formatError(error))
    throw new Error(`Cannot check permission ${permissionKey}`)
  }

  return !!data
}

export async function assertCliPermission(
  supabase: SupabaseClient<Database>,
  apikey: string,
  permissionKey: string,
  scope: CliPermissionScope = {},
  options: {
    message?: string
    silent?: boolean
  } = {},
): Promise<void> {
  const allowed = await hasCliPermission(supabase, apikey, permissionKey, scope)
  if (allowed)
    return

  const message = options.message || `Insufficient permissions for ${permissionKey}`
  if (!options.silent)
    log.error(message)
  throw new Error(message)
}

export async function assertOrgPermission(
  supabase: SupabaseClient<Database>,
  apikey: string,
  permissionKey: string,
  orgId: string,
  message: string,
  silent: boolean,
): Promise<void> {
  await resolveUserIdFromApiKey(supabase, apikey, silent)
  await assertCliPermission(supabase, apikey, permissionKey, { orgId }, { message, silent })
}

export async function getOrganizationId(supabase: SupabaseClient<Database>, appId: string) {
  const { data, error } = await supabase.from('apps')
    .select('owner_org')
    .eq('app_id', appId)
    .single()

  if (!data || error) {
    log.error(`Cannot get organization id for app id ${appId}`)
    formatError(error)
    throw new Error(`Cannot get organization id for app id ${appId}`)
  }
  return data.owner_org
}

export function getHumanDate(createdA: string | null) {
  const date = new Date(createdA || '')
  return date.toLocaleString()
}

let pmFetched = false
let pm: PackageManagerType = 'npm'
let pmCommand: InstallCommand = 'install'
let pmRunner: PackageManagerRunner = 'npx'
export function getPMAndCommand() {
  if (pmFetched)
    return { pm, command: pmCommand, installCommand: `${pm} ${pmCommand}`, runner: pmRunner }
  const dir = findRoot(cwd())
  pm = findPackageManagerType(dir, 'npm')
  pmCommand = findInstallCommand(pm)
  pmFetched = true
  pmRunner = findPackageManagerRunner(dir)
  return { pm, command: pmCommand, installCommand: `${pm} ${pmCommand}`, runner: pmRunner }
}

export function getNativeProjectResetAdvice(platformRunner: string, nativePlatform: 'ios' | 'android') {
  const nativeLabel = nativePlatform === 'ios' ? 'iOS' : 'Android'
  return {
    summary: `Best fix: recreate and sync ${nativeLabel} with this one-line command.`,
    command: `rm -rf ${nativePlatform} && ${platformRunner} cap add ${nativePlatform} && ${platformRunner} cap sync ${nativePlatform}`,
  }
}

function readDirRecursively(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      return readDirRecursively(fullPath)
    }
    else {
      // Use relative path to avoid issues with long paths on Windows
      return fullPath.split(`node_modules${sep}`)[1] || fullPath
    }
  })
  return files
}

/**
 * Read directory recursively and return full paths for all files
 */
function readDirRecursivelyFullPaths(dir: string): string[] {
  if (!existsSync(dir))
    return []

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    const files = entries.flatMap((entry) => {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        return readDirRecursivelyFullPaths(fullPath)
      }
      else {
        return fullPath
      }
    })
    return files
  }
  catch {
    return []
  }
}

/**
 * Get additional platform-specific files that should be included in checksum.
 * These files contain platform dependency versions and configurations.
 */
function getPlatformConfigFiles(dependencyFolderPath: string, platform: 'ios' | 'android'): string[] {
  const files: string[] = []

  if (platform === 'ios') {
    // Include .podspec files (CocoaPods dependency versions)
    try {
      const rootFiles = readdirSync(dependencyFolderPath)
      for (const file of rootFiles) {
        if (file.endsWith('.podspec')) {
          files.push(join(dependencyFolderPath, file))
        }
      }
    }
    catch {
      // Ignore errors reading directory
    }

    // Include Package.swift (SPM dependency versions) - can be at root or in ios folder
    const packageSwiftRoot = join(dependencyFolderPath, 'Package.swift')
    const packageSwiftIos = join(dependencyFolderPath, 'ios', 'Package.swift')
    if (existsSync(packageSwiftRoot))
      files.push(packageSwiftRoot)
    if (existsSync(packageSwiftIos))
      files.push(packageSwiftIos)
  }
  else if (platform === 'android') {
    // Include build.gradle files (Android dependency versions)
    const androidDir = join(dependencyFolderPath, 'android')
    const buildGradle = join(androidDir, 'build.gradle')
    const buildGradleKts = join(androidDir, 'build.gradle.kts')

    if (existsSync(buildGradle))
      files.push(buildGradle)
    if (existsSync(buildGradleKts))
      files.push(buildGradleKts)
  }

  return files
}

/**
 * Calculate checksums for iOS and Android native code in a dependency folder.
 * Includes both native source files and platform configuration files
 * (podspec, Package.swift, build.gradle) that define platform dependencies.
 */
async function calculatePlatformChecksums(dependencyFolderPath: string): Promise<{ ios_checksum?: string, android_checksum?: string }> {
  const iosDir = join(dependencyFolderPath, 'ios')
  const androidDir = join(dependencyFolderPath, 'android')

  const calculatePlatformChecksum = async (platformDir: string, platform: 'ios' | 'android'): Promise<string | undefined> => {
    // Get native code files
    const nativeFiles = existsSync(platformDir)
      ? readDirRecursivelyFullPaths(platformDir).filter(f => nativeFileRegex.test(f))
      : []

    // Get platform config files (podspec, Package.swift, build.gradle)
    const configFiles = getPlatformConfigFiles(dependencyFolderPath, platform)

    // Combine and sort all files for consistent checksumming
    const allFiles = [...nativeFiles, ...configFiles].sort((a, b) => a.localeCompare(b))

    if (allFiles.length === 0)
      return undefined

    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256')

    for (const file of allFiles) {
      try {
        // Include relative path in hash to detect file renames/moves
        const relativePath = relative(dependencyFolderPath, file)
        hash.update(relativePath)
        // Include file content
        const content = readFileSync(file)
        hash.update(content)
      }
      catch {
        // Skip files that can't be read
      }
    }

    return hash.digest('hex')
  }

  const [ios_checksum, android_checksum] = await Promise.all([
    calculatePlatformChecksum(iosDir, 'ios'),
    calculatePlatformChecksum(androidDir, 'android'),
  ])

  return { ios_checksum, android_checksum }
}

export async function getLocalDependencies(packageJsonPath: string | undefined, nodeModulesString: string | undefined) {
  const nodeModules = nodeModulesString
    ? nodeModulesString
        .split(',')
        .map(nodeModulesPath => nodeModulesPath.trim())
        .filter(Boolean)
    : []
  let dependencies
  try {
    dependencies = await getAllPackagesDependencies('', packageJsonPath)
  }
  catch (err) {
    log.error('Invalid package.json, JSON parsing failed')
    log.error(`json parse error: ${formatError(err)}`)
    throw err instanceof Error ? err : new Error('Invalid package.json')
  }
  const firstPackageJson = packageJsonPath
    ? packageJsonPath.split(',')[0].trim()
    : undefined
  const dir = !firstPackageJson ? findRoot(cwd()) : path.resolve(firstPackageJson).replace(PACKNAME, '')
  if (!dependencies) {
    log.error('Missing dependencies section in package.json')
    throw new Error('Missing dependencies section in package.json')
  }

  for (const [key, value] of Object.entries(dependencies)) {
    if (typeof value !== 'string') {
      log.error(`Invalid dependency ${key}: ${value}, expected string, got ${typeof value}`)
      throw new Error(`Invalid dependency ${key}: expected string version`)
    }
  }

  const nodeModulesPaths = nodeModules.length === 0
    ? [join(cwd(), 'node_modules')]
    : nodeModules

  const anyValidPath = nodeModulesPaths.some(path => existsSync(path))
  if (!anyValidPath) {
    const pm = findPackageManagerType(dir, 'npm')
    const installCmd = findInstallCommand(pm)
    log.error(`Missing node_modules folder at ${nodeModulesPaths.join(', ')}, please run ${pm} ${installCmd}`)
    throw new Error('Missing node_modules folder')
  }

  let anyInvalid = false
  const declaredDependencies = await getDeclaredPackageVersionMap(findRoot(cwd()), packageJsonPath)
  const dependenciesObject = await Promise.all(Array.from(dependencies.entries())
    .map(async ([key, value]) => {
      let dependencyFound = false
      let hasNativeFiles = false
      let actualVersion = value
      const requestedVersion = declaredDependencies.get(key) ?? value
      let foundDependencyPath: string | undefined

      for (const modulePath of nodeModulesPaths) {
        const dependencyFolderPath = join(modulePath, key)
        if (existsSync(dependencyFolderPath)) {
          dependencyFound = true
          foundDependencyPath = dependencyFolderPath
          // Read actual version from node_modules package.json
          // This handles catalog:, workspace:, link:, and other special specifiers
          try {
            const pkgJsonPath = join(dependencyFolderPath, PACKNAME)
            if (existsSync(pkgJsonPath)) {
              const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
              if (pkgJson.version) {
                actualVersion = pkgJson.version
              }
            }
          }
          catch {
            // If we can't read the package.json, fall back to declared version
          }
          if (!dependencyDeclaresNativePlugin(dependencyFolderPath))
            continue

          try {
            const files = readDirRecursively(dependencyFolderPath)
            if (files.some(fileName => nativeFileRegex.test(fileName))) {
              hasNativeFiles = true
              break
            }
          }
          catch (error) {
            log.error(`Error reading node_modules files for ${key} package in ${modulePath}`)
            log.error(formatError(error))
            throw error instanceof Error ? error : new Error(`Error reading node_modules files for ${key}`)
          }
        }
      }

      if (!dependencyFound) {
        anyInvalid = true
        const pm = findPackageManagerType(dir, 'npm')
        const installCmd = findInstallCommand(pm)
        log.error(`Missing dependency ${key}, please run ${pm} ${installCmd}`)
        return { name: key, version: actualVersion, requested_version: requestedVersion }
      }

      // Calculate platform checksums for native packages
      let ios_checksum: string | undefined
      let android_checksum: string | undefined
      if (hasNativeFiles && foundDependencyPath) {
        const checksums = await calculatePlatformChecksums(foundDependencyPath)
        ios_checksum = checksums.ios_checksum
        android_checksum = checksums.android_checksum
      }

      return {
        name: key,
        version: actualVersion,
        requested_version: requestedVersion,
        native: hasNativeFiles,
        ios_checksum,
        android_checksum,
      }
    })).catch(() => [])

  if (anyInvalid || dependenciesObject.some(a => a.native === undefined)) {
    log.error('Missing dependencies or invalid dependencies')
    log.error('If you use monorepo, workspace or any special package manager you can use the --package-json [path,] and --node-modules [path,] options to make the command work properly')
    throw new Error('Missing dependencies or invalid dependencies')
  }

  return dependenciesObject as { name: string, version: string, requested_version?: string, native: boolean, ios_checksum?: string, android_checksum?: string }[]
}

interface ChannelChecksum {
  version: {
    checksum: string
  }
}

export async function getRemoteChecksums(supabase: SupabaseClient<Database>, appId: string, channel: string) {
  const { data, error } = await supabase
    .from('channels')
    .select(`version:app_versions!channels_version_fkey(checksum)`)
    .eq('name', channel)
    .eq('app_id', appId)
    .single()
  const channelData = data as any as ChannelChecksum

  if (error
    || channelData === null
    || !channelData.version
    || !channelData.version.checksum) {
    return null
  }

  return channelData.version.checksum
}

export type { NativePackage } from './schemas/common'

export function convertNativePackages(nativePackages: NativePackage[]): Map<string, NativePackage> {
  if (!nativePackages) {
    log.error(`Error parsing native packages, perhaps the metadata does not exist in Capgo?`)
    throw new Error('Error parsing native packages')
  }

  // Validate each package using Zod schema
  for (const data of nativePackages) {
    const result = safeParseSchema(nativePackageSchema, data)
    if (!result.success) {
      const errorMsg = result.error.issues.map(i => `${(i.path ?? []).join('.')}: ${i.message}`).join(', ')
      log.error(`Invalid remote native package data: ${errorMsg}`)
      throw new Error(`Invalid remote native package data: ${errorMsg}`)
    }
  }

  const mappedRemoteNativePackages = new Map((nativePackages)
    .map(a => [a.name, a]))

  return mappedRemoteNativePackages
}

export async function getRemoteDependencies(supabase: SupabaseClient<Database>, appId: string, channel: string) {
  const { data: remoteNativePackages, error } = await supabase
    .from('channels')
    .select(`version:app_versions!channels_version_fkey(
            native_packages 
        )`)
    .eq('name', channel)
    .eq('app_id', appId)
    .single()

  if (error) {
    log.error(`Error fetching native packages: ${error.message}`)
    throw new Error(`Error fetching native packages: ${error.message}`)
  }
  return convertNativePackages(((remoteNativePackages.version as any)?.native_packages as any) ?? [])
}

export type { Compatibility, CompatibilityDetails } from './schemas/common'

export function getAppId(appId: string | undefined, config: CapacitorConfig | undefined) {
  const finalAppId = appId || config?.plugins?.CapacitorUpdater?.appId || config?.appId
  return finalAppId
}

/**
 * Check if a package is compatible and return detailed reasons if not
 */
export function getCompatibilityDetails(pkg: Compatibility): CompatibilityDetails {
  const reasons: IncompatibilityReason[] = []

  // If no local version, it's compatible (remote-only package - being removed is ok for OTA)
  if (!pkg.localVersion) {
    return {
      compatible: true,
      reasons: [],
      message: 'Package only exists on remote (will be removed)',
    }
  }

  // If local version but no remote version, it's a new plugin
  if (!pkg.remoteVersion) {
    reasons.push('new_plugin')
    return {
      compatible: false,
      reasons,
      message: `New native plugin added (requires app store update)`,
    }
  }

  // Check version compatibility
  let versionsCompatible = false
  try {
    const localRange = parseRange(pkg.localVersion)
    const remoteRange = parseRange(pkg.remoteVersion)
    versionsCompatible = rangeIntersects(localRange, remoteRange)
  }
  catch {
    versionsCompatible = false
  }

  if (!versionsCompatible) {
    reasons.push('version_mismatch')
  }

  if (pkg.localRequestedVersion && pkg.remoteRequestedVersion && pkg.localRequestedVersion.trim() !== pkg.remoteRequestedVersion.trim()) {
    reasons.push('requested_version_changed')
  }

  // Check checksum changes (even if versions match, native code could have changed)
  const iosChanged = pkg.localIosChecksum && pkg.remoteIosChecksum && pkg.localIosChecksum !== pkg.remoteIosChecksum
  const androidChanged = pkg.localAndroidChecksum && pkg.remoteAndroidChecksum && pkg.localAndroidChecksum !== pkg.remoteAndroidChecksum

  if (iosChanged && androidChanged) {
    reasons.push('both_platforms_changed')
  }
  else if (iosChanged) {
    reasons.push('ios_code_changed')
  }
  else if (androidChanged) {
    reasons.push('android_code_changed')
  }

  const messages: string[] = []
  const isIncompatibleReason = (reason: IncompatibilityReason) => reason !== 'requested_version_changed'
  for (const reason of reasons) {
    switch (reason) {
      case 'version_mismatch':
        messages.push(`version changed: ${pkg.remoteVersion} → ${pkg.localVersion}`)
        break
      case 'requested_version_changed':
        messages.push(`requested version changed: ${pkg.remoteRequestedVersion ?? 'unknown'} → ${pkg.localRequestedVersion ?? 'unknown'}`)
        break
      case 'ios_code_changed':
        messages.push('iOS native code changed')
        break
      case 'android_code_changed':
        messages.push('Android native code changed')
        break
      case 'both_platforms_changed':
        messages.push('iOS and Android native code changed')
        break
      case 'new_plugin':
        messages.push('new plugin (requires app store update)')
        break
      case 'removed_plugin':
        messages.push('plugin removed')
        break
    }
  }

  const isCompatible = !reasons.some(isIncompatibleReason)
  if (isCompatible) {
    return {
      compatible: true,
      reasons,
      message: messages.length > 0 ? messages.join(', ') : 'Compatible',
    }
  }

  return {
    compatible: false,
    reasons,
    message: messages.join(', '),
  }
}

/**
 * Simple compatibility check (backward compatible)
 */
export function isCompatible(pkg: Compatibility): boolean {
  return getCompatibilityDetails(pkg).compatible
}

export async function checkCompatibilityCloud(supabase: SupabaseClient<Database>, appId: string, channel: string, packageJsonPath: string | undefined, nodeModules: string | undefined) {
  const dependenciesObject = await getLocalDependencies(packageJsonPath, nodeModules)
  const mappedRemoteNativePackages = await getRemoteDependencies(supabase, appId, channel)

  const finalDependencies: Compatibility[] = dependenciesObject
    .filter(a => !!a.native)
    .map((local) => {
      const remotePackage = mappedRemoteNativePackages.get(local.name)
      if (remotePackage) {
        return {
          name: local.name,
          localVersion: local.version,
          localRequestedVersion: local.requested_version,
          remoteVersion: remotePackage.version,
          remoteRequestedVersion: remotePackage.requested_version,
          localIosChecksum: local.ios_checksum,
          remoteIosChecksum: remotePackage.ios_checksum,
          localAndroidChecksum: local.android_checksum,
          remoteAndroidChecksum: remotePackage.android_checksum,
        }
      }

      return {
        name: local.name,
        localVersion: local.version,
        localRequestedVersion: local.requested_version,
        remoteVersion: undefined,
        localIosChecksum: local.ios_checksum,
        localAndroidChecksum: local.android_checksum,
      }
    })

  // Only include remote packages that are not in local for informational purposes
  // These won't affect compatibility
  const removeNotInLocal = [...mappedRemoteNativePackages]
    .filter(([remoteName]) => !dependenciesObject.some(a => a.name === remoteName))
    .map(([name, pkg]) => ({
      name,
      localVersion: undefined,
      remoteVersion: pkg.version,
      remoteRequestedVersion: pkg.requested_version,
      remoteIosChecksum: pkg.ios_checksum,
      remoteAndroidChecksum: pkg.android_checksum,
    }))

  finalDependencies.push(...removeNotInLocal)

  return {
    finalCompatibility: finalDependencies,
    localDependencies: dependenciesObject,
  }
}

export async function checkCompatibilityNativePackages(supabase: SupabaseClient<Database>, appId: string, channel: string, nativePackages: NativePackage[]) {
  const mappedRemoteNativePackages = await getRemoteDependencies(supabase, appId, channel)

  const finalDependencies: Compatibility[] = nativePackages
    .map((local) => {
      const remotePackage = mappedRemoteNativePackages.get(local.name)
      if (remotePackage) {
        return {
          name: local.name,
          localVersion: local.version,
          localRequestedVersion: local.requested_version,
          remoteVersion: remotePackage.version,
          remoteRequestedVersion: remotePackage.requested_version,
          localIosChecksum: local.ios_checksum,
          remoteIosChecksum: remotePackage.ios_checksum,
          localAndroidChecksum: local.android_checksum,
          remoteAndroidChecksum: remotePackage.android_checksum,
        }
      }

      return {
        name: local.name,
        localVersion: local.version,
        localRequestedVersion: local.requested_version,
        remoteVersion: undefined,
        localIosChecksum: local.ios_checksum,
        localAndroidChecksum: local.android_checksum,
      }
    })

  // Only include remote packages that are not in local for informational purposes
  // These won't affect compatibility
  const removeNotInLocal = [...mappedRemoteNativePackages]
    .filter(([remoteName]) => !nativePackages.some(a => a.name === remoteName))
    .map(([name, pkg]) => ({
      name,
      localVersion: undefined,
      remoteVersion: pkg.version,
      remoteRequestedVersion: pkg.requested_version,
      remoteIosChecksum: pkg.ios_checksum,
      remoteAndroidChecksum: pkg.android_checksum,
    }))

  finalDependencies.push(...removeNotInLocal)

  return {
    finalCompatibility: finalDependencies,
    localDependencies: nativePackages,
  }
}

export interface IosUpdaterSyncValidationResult {
  shouldCheck: boolean
  valid: boolean
  details: string[]
}

function readJsonFileSafely(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath))
    return null

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  }
  catch {
    return null
  }
}

function hasUpdaterInText(content: string | undefined): boolean {
  if (!content)
    return false
  return /@capgo\/capacitor-updater|CapgoCapacitorUpdater|CapacitorUpdaterPlugin/.test(content)
}

function hasUpdaterInCapacitorConfigJson(filePath: string): boolean {
  const config = readJsonFileSafely(filePath)
  if (!config)
    return false

  const packageClassList = config.packageClassList
  return Array.isArray(packageClassList) && packageClassList.includes('CapacitorUpdaterPlugin')
}

function resolvePackageJsonLocation(rootDir: string, packageJsonPath?: string): string {
  if (!packageJsonPath)
    return join(rootDir, PACKNAME)
  return path.isAbsolute(packageJsonPath) ? packageJsonPath : resolve(rootDir, packageJsonPath)
}

/**
 * Validate whether the iOS native project is correctly synced for capacitor-updater.
 *
 * `shouldCheck` is `false` when no iOS project is present or no updater signals are detected
 * (no dependency declaration, installed package, or native references). `shouldCheck` is `true`
 * as soon as any signal indicates updater should be wired, then both dependency definitions
 * (`Podfile` or SPM `Package.swift`) and generated native outputs (`Podfile.lock`,
 * `capacitor.plugins.json`, or `ios/App/App/capacitor.config.json`) must include
 * updater markers for `valid` to be `true`.
 */
export function validateIosUpdaterSync(
  rootDir: string = cwd(),
  packageJsonPath?: string,
): IosUpdaterSyncValidationResult {
  const packageJsonLocation = resolvePackageJsonLocation(rootDir, packageJsonPath)
  const projectRoot = path.basename(packageJsonLocation) === PACKNAME ? dirname(packageJsonLocation) : packageJsonLocation
  const iosAppPath = [join(projectRoot, 'ios', 'App'), join(rootDir, 'ios', 'App')]
    .find(candidate => existsSync(candidate))

  if (!iosAppPath) {
    return {
      shouldCheck: false,
      valid: true,
      details: [],
    }
  }

  const packageJson = readJsonFileSafely(packageJsonLocation)
  const dependencies = {
    ...(packageJson?.dependencies as Record<string, unknown> | undefined),
    ...(packageJson?.devDependencies as Record<string, unknown> | undefined),
    ...(packageJson?.optionalDependencies as Record<string, unknown> | undefined),
  }
  const updaterDeclaredInPackageJson = Object.hasOwn(dependencies, '@capgo/capacitor-updater')
  const updaterPresentInNodeModules = [projectRoot, rootDir]
    .some(baseDir => existsSync(join(baseDir, 'node_modules', '@capgo', 'capacitor-updater')))

  const podfilePath = join(iosAppPath, 'Podfile')
  const spmPackagePath = join(iosAppPath, 'CapApp-SPM', 'Package.swift')
  const podfileContent = existsSync(podfilePath) ? readFileSync(podfilePath, 'utf-8') : undefined
  const spmPackageContent = existsSync(spmPackagePath) ? readFileSync(spmPackagePath, 'utf-8') : undefined
  const hasDependencyEntry = hasUpdaterInText(podfileContent) || hasUpdaterInText(spmPackageContent)

  const podfileLockPath = join(iosAppPath, 'Podfile.lock')
  const capacitorPluginsPath = join(iosAppPath, 'App', 'capacitor.plugins.json')
  const capacitorConfigJsonPath = join(iosAppPath, 'App', 'capacitor.config.json')
  const podfileLockContent = existsSync(podfileLockPath) ? readFileSync(podfileLockPath, 'utf-8') : undefined
  const capacitorPluginsContent = existsSync(capacitorPluginsPath) ? readFileSync(capacitorPluginsPath, 'utf-8') : undefined
  const hasNativeProjectEntry = hasUpdaterInText(podfileLockContent)
    || hasUpdaterInText(capacitorPluginsContent)
    || hasUpdaterInCapacitorConfigJson(capacitorConfigJsonPath)

  const shouldCheck = updaterDeclaredInPackageJson
    || updaterPresentInNodeModules
    || hasDependencyEntry
    || hasNativeProjectEntry

  if (!shouldCheck) {
    return {
      shouldCheck: false,
      valid: true,
      details: [],
    }
  }

  const details: string[] = []
  if (!hasDependencyEntry) {
    details.push(`Missing @capgo/capacitor-updater in iOS dependency files (${podfilePath} or ${spmPackagePath})`)
  }
  if (!hasNativeProjectEntry) {
    details.push(`Missing @capgo/capacitor-updater in iOS native project outputs (${podfileLockPath}, ${capacitorPluginsPath}, or ${capacitorConfigJsonPath})`)
  }

  return {
    shouldCheck: true,
    valid: hasDependencyEntry && hasNativeProjectEntry,
    details,
  }
}

interface PromptAndSyncOptions {
  validateIosUpdater?: boolean
  packageJsonPath?: string
}

export async function promptAndSyncCapacitor(
  isInit?: boolean,
  orgId?: string,
  apikey?: string,
  options?: PromptAndSyncOptions,
): Promise<void> {
  // Ask user if they want to sync with Capacitor
  const shouldSync = await confirmC({
    message: 'Would you like to sync your project with Capacitor now? This is recommended to ensure encrypted updates work properly.',
  })

  // Handle user cancellation
  if (isCancel(shouldSync)) {
    // For init flow, mark the cancellation
    if (isInit && orgId && apikey) {
      await markSnag('onboarding-v2', orgId, apikey, 'canceled', undefined, '🤷')
    }
    log.error('Canceled Capacitor sync')
    throw new Error('Capacitor sync cancelled')
  }

  if (shouldSync) {
    const pm = getPMAndCommand()
    const s = spinnerC()
    s.start('Running the command...')
    let syncError: unknown

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(pm.runner, ['cap', 'sync'], { stdio: 'pipe' })

        child.on('close', (code) => {
          if (code === 0) {
            resolve()
          }
          else {
            reject(new Error(`Command failed with exit code ${code}`))
          }
        })

        child.on('error', (error) => {
          reject(error)
        })
      })
    }
    catch (error) {
      syncError = error
      log.error(`Failed to run Capacitor sync: ${error}`)
      log.warn(`Please run "${pm.runner} cap sync" manually to ensure encrypted updates work properly`)
    }

    if (options?.validateIosUpdater) {
      const syncValidation = validateIosUpdaterSync(cwd(), options.packageJsonPath)
      if (syncValidation.shouldCheck && !syncValidation.valid) {
        const resetAdvice = getNativeProjectResetAdvice(pm.runner, 'ios')
        s.stop('iOS sync check failed ❌')
        log.error('Capgo iOS dependency sync verification failed.')
        for (const detail of syncValidation.details) {
          log.error(detail)
        }
        log.error('Stop here to avoid testing on a broken native iOS project.')
        log.warn(resetAdvice.summary)
        log.info(resetAdvice.command)
        throw new Error('iOS sync validation failed. Delete your iOS folder, then rerun the add and sync commands above and retry.')
      }
    }

    if (syncError) {
      s.stop('Error')
      return
    }

    s.stop('Capacitor sync completed ✅')
  }
  else {
    const pm = getPMAndCommand()
    log.warn('⚠️  Important: If you upload encrypted bundles without syncing, updates will fail!')
    log.info(`Remember to run "${pm.runner} cap sync" before uploading encrypted bundles`)
  }
}
