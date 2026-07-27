/**
 * Build Credentials Management
 *
 * This module provides utilities for managing build credentials locally on your machine.
 *
 * IMPORTANT SECURITY NOTICE:
 * - Credentials are stored LOCALLY in ~/.capgo-credentials/credentials.json on YOUR machine only
 * - When you request a build, credentials are sent to Capgo's build servers
 * - Credentials are NEVER stored permanently on Capgo servers
 * - Credentials are used only during the build process and are automatically deleted
 *   from Capgo servers after the build completes (maximum 24 hours)
 * - Builds are sent DIRECTLY to app stores (Apple App Store / Google Play Store)
 * - Build outputs may optionally be uploaded for time-limited download links
 *
 * Security best practices:
 * - Ensure ~/.capgo-credentials/ directory has restricted file permissions
 * - Never commit credentials.json to version control
 * - Use separate credentials for CI/CD vs local development
 * - Rotate credentials regularly
 */

import type { AllCredentials, CredentialFile, SavedCredentials } from '../schemas/build'
import type { BuildCredentials } from './request'
import { Buffer } from 'node:buffer'
import { readFile as readNodeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cwd, env } from 'node:process'
import { ensureSecureDirectory, readSafeFile, writeFileAtomic } from '../utils/safeWrites'

const CREDENTIALS_DIR = join(homedir(), '.capgo-credentials')
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json')
const LOCAL_CREDENTIALS_FILE = '.capgo-credentials.json'
export const MIN_OUTPUT_RETENTION_SECONDS = 60 * 60
export const MAX_OUTPUT_RETENTION_SECONDS = 7 * 24 * 60 * 60

/**
 * Get the credentials file path based on local flag
 */
function getCredentialsPath(local?: boolean): string {
  return local ? join(cwd(), LOCAL_CREDENTIALS_FILE) : CREDENTIALS_FILE
}

/**
 * Get the credentials directory (only for global storage)
 */
function getCredentialsDir(local?: boolean): string | null {
  return local ? null : CREDENTIALS_DIR
}

export type { CredentialFile, SavedCredentials } from '../schemas/build'

export function parseOutputRetentionSeconds(raw: string): number {
  const trimmed = raw.trim()
  const match = trimmed.match(/^(\d+)\s*([smhd])?$/i)
  if (!match)
    throw new Error('output-retention must be a number with optional unit: s, m, h, d (examples: 1h, 3600s, 2d)')

  const value = Number.parseInt(match[1]!, 10)
  const unit = (match[2] || 's').toLowerCase() as 's' | 'm' | 'h' | 'd'

  const multiplier = unit === 's'
    ? 1
    : unit === 'm'
      ? 60
      : unit === 'h'
        ? 60 * 60
        : 24 * 60 * 60

  const seconds = value * multiplier
  if (seconds < MIN_OUTPUT_RETENTION_SECONDS)
    throw new Error(`output-retention must be at least ${MIN_OUTPUT_RETENTION_SECONDS} seconds (1h)`)
  if (seconds > MAX_OUTPUT_RETENTION_SECONDS)
    throw new Error(`output-retention must be at most ${MAX_OUTPUT_RETENTION_SECONDS} seconds (7d)`)

  return seconds
}

export function parseOptionalBoolean(value: boolean | string | undefined): boolean {
  if (value === undefined)
    return true
  if (typeof value === 'boolean')
    return value

  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes')
    return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no')
    return false

  throw new Error('output-upload must be true/false (examples: --output-upload, --output-upload false)')
}

export function parseInAppUpdatePriority(value: number | string): number {
  // Reject blank/whitespace-only strings before numeric coercion — Number('') and Number('   ')
  // both yield 0, which would silently apply priority 0 to a Play release.
  if (typeof value === 'string' && value.trim() === '')
    throw new Error('in-app-update-priority must be an integer between 0 and 5')
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(num) || num < 0 || num > 5)
    throw new Error('in-app-update-priority must be an integer between 0 and 5')
  return num
}

/**
 * Convert a file to base64 string
 */
async function fileToBase64(filePath: string): Promise<string> {
  const buffer = await readNodeFile(filePath)
  return buffer.toString('base64')
}

/**
 * Load all credentials from file (global or local)
 */
async function loadAllCredentials(local?: boolean): Promise<AllCredentials> {
  try {
    const filePath = getCredentialsPath(local)
    const content = await readSafeFile(filePath)
    return JSON.parse(content) as AllCredentials
  }
  catch {
    return {}
  }
}

/**
 * Load saved credentials for a specific app
 * Checks local file first, then global file
 */
export async function loadSavedCredentials(appId?: string, local?: boolean): Promise<SavedCredentials | null> {
  // If local is explicitly set, only check that location
  if (local !== undefined) {
    const all = await loadAllCredentials(local)
    if (!appId) {
      const appIds = Object.keys(all)
      if (appIds.length === 0)
        return null
      return all[appIds[0]] || null
    }
    return all[appId] || null
  }

  // Otherwise, check local first, then global (local takes precedence)
  const localAll = await loadAllCredentials(true)
  const globalAll = await loadAllCredentials(false)

  // If no appId provided, try to get default (backward compatibility)
  if (!appId) {
    // Check local first
    const localAppIds = Object.keys(localAll)
    if (localAppIds.length > 0)
      return localAll[localAppIds[0]] || null

    // Then global
    const globalAppIds = Object.keys(globalAll)
    if (globalAppIds.length === 0)
      return null
    return globalAll[globalAppIds[0]] || null
  }

  // Return local if exists, otherwise global
  return localAll[appId] || globalAll[appId] || null
}

/**
 * Save all credentials to file (global or local)
 */
async function saveAllCredentials(credentials: AllCredentials, local?: boolean): Promise<void> {
  const filePath = getCredentialsPath(local)
  const dir = getCredentialsDir(local)

  // Create directory only for global storage
  if (dir) {
    await ensureSecureDirectory(dir, 0o700)
  }

  await writeFileAtomic(filePath, JSON.stringify(credentials, null, 2), { mode: 0o600 })
}

function readRuntimeEnv(name: string): string | undefined {
  // Use runtime key lookup to avoid bundler static replacement.
  return env[name]
}

/**
 * Load credentials from environment variables
 * Only returns credentials that are actually set in env
 */
export function loadCredentialsFromEnv(): Partial<BuildCredentials> {
  const credentials: Partial<BuildCredentials> = {}
  const buildCertificateBase64 = readRuntimeEnv('BUILD_CERTIFICATE_BASE64')
  const p12Password = readRuntimeEnv('P12_PASSWORD')
  const appleKeyId = readRuntimeEnv('APPLE_KEY_ID')
  const appleIssuerId = readRuntimeEnv('APPLE_ISSUER_ID')
  const appleKeyContent = readRuntimeEnv('APPLE_KEY_CONTENT')
  const appStoreConnectTeamId = readRuntimeEnv('APP_STORE_CONNECT_TEAM_ID')
  // iOS app-specific password upload (alternative to the App Store Connect API key)
  const fastlaneUser = readRuntimeEnv('FASTLANE_USER')
  const appSpecificPassword = readRuntimeEnv('FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD')
  const appleAppId = readRuntimeEnv('APPLE_APP_ID')
  const capgoIosScheme = readRuntimeEnv('CAPGO_IOS_SCHEME')
  const capgoIosTarget = readRuntimeEnv('CAPGO_IOS_TARGET')
  // Provisioning map can be supplied as raw JSON (CAPGO_IOS_PROVISIONING_MAP) or
  // base64-encoded JSON (CAPGO_IOS_PROVISIONING_MAP_BASE64). The base64 form
  // avoids quoting/newline pitfalls when storing the stringified JSON in CI secrets.
  const capgoIosProvisioningMapRaw = readRuntimeEnv('CAPGO_IOS_PROVISIONING_MAP')
  const capgoIosProvisioningMapBase64 = readRuntimeEnv('CAPGO_IOS_PROVISIONING_MAP_BASE64')
  const capgoIosProvisioningMap = capgoIosProvisioningMapRaw
    || (capgoIosProvisioningMapBase64
      ? Buffer.from(capgoIosProvisioningMapBase64, 'base64').toString('utf-8')
      : undefined)
  const rawCapgoAndroidFlavor = readRuntimeEnv('CAPGO_ANDROID_FLAVOR')
  const capgoAndroidFlavor = rawCapgoAndroidFlavor?.trim() || undefined
  const androidKeystoreFile = readRuntimeEnv('ANDROID_KEYSTORE_FILE')
  const keystoreKeyAlias = readRuntimeEnv('KEYSTORE_KEY_ALIAS')
  const keystoreKeyPassword = readRuntimeEnv('KEYSTORE_KEY_PASSWORD')
  const keystoreStorePassword = readRuntimeEnv('KEYSTORE_STORE_PASSWORD')
  const playConfigJson = readRuntimeEnv('PLAY_CONFIG_JSON')
  const playStoreInAppUpdatePriority = readRuntimeEnv('PLAY_STORE_IN_APP_UPDATE_PRIORITY')
  const buildOutputUploadEnabled = readRuntimeEnv('BUILD_OUTPUT_UPLOAD_ENABLED')
  const buildOutputRetentionSeconds = readRuntimeEnv('BUILD_OUTPUT_RETENTION_SECONDS')
  const skipBuildNumberBump = readRuntimeEnv('SKIP_BUILD_NUMBER_BUMP')
  const skipMarketingVersionBump = readRuntimeEnv('SKIP_MARKETING_VERSION_BUMP')
  const capgoIosDistribution = readRuntimeEnv('CAPGO_IOS_DISTRIBUTION')
  const capgoStoreSubmitReview = readRuntimeEnv('CAPGO_STORE_SUBMIT_REVIEW')
  const capgoStoreReleaseName = readRuntimeEnv('CAPGO_STORE_RELEASE_NAME')
  const capgoStoreReleaseNotes = readRuntimeEnv('CAPGO_STORE_RELEASE_NOTES')
  const capgoStoreReleaseNotesLocalized = readRuntimeEnv('CAPGO_STORE_RELEASE_NOTES_LOCALIZED')
  const capgoIosTestflightGroups = readRuntimeEnv('CAPGO_IOS_TESTFLIGHT_GROUPS')
  const capgoIosAutomaticRelease = readRuntimeEnv('CAPGO_IOS_AUTOMATIC_RELEASE')

  // iOS credentials
  if (buildCertificateBase64)
    credentials.BUILD_CERTIFICATE_BASE64 = buildCertificateBase64
  if (p12Password)
    credentials.P12_PASSWORD = p12Password
  if (appleKeyId)
    credentials.APPLE_KEY_ID = appleKeyId
  if (appleIssuerId)
    credentials.APPLE_ISSUER_ID = appleIssuerId
  if (appleKeyContent)
    credentials.APPLE_KEY_CONTENT = appleKeyContent
  if (appStoreConnectTeamId)
    credentials.APP_STORE_CONNECT_TEAM_ID = appStoreConnectTeamId
  if (fastlaneUser)
    credentials.FASTLANE_USER = fastlaneUser
  if (appSpecificPassword)
    credentials.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD = appSpecificPassword
  if (appleAppId)
    credentials.APPLE_APP_ID = appleAppId
  if (capgoIosScheme)
    credentials.CAPGO_IOS_SCHEME = capgoIosScheme
  if (capgoStoreSubmitReview)
    credentials.CAPGO_STORE_SUBMIT_REVIEW = parseOptionalBoolean(capgoStoreSubmitReview) ? 'true' : 'false'
  if (capgoStoreReleaseName?.trim())
    credentials.CAPGO_STORE_RELEASE_NAME = capgoStoreReleaseName.trim()
  if (capgoStoreReleaseNotes?.trim())
    credentials.CAPGO_STORE_RELEASE_NOTES = capgoStoreReleaseNotes.trim()
  if (capgoStoreReleaseNotesLocalized?.trim())
    credentials.CAPGO_STORE_RELEASE_NOTES_LOCALIZED = capgoStoreReleaseNotesLocalized.trim()
  if (capgoIosTestflightGroups?.trim())
    credentials.CAPGO_IOS_TESTFLIGHT_GROUPS = capgoIosTestflightGroups.trim()
  if (capgoIosAutomaticRelease)
    credentials.CAPGO_IOS_AUTOMATIC_RELEASE = parseOptionalBoolean(capgoIosAutomaticRelease) ? 'true' : 'false'
  if (capgoIosTarget)
    credentials.CAPGO_IOS_TARGET = capgoIosTarget
  if (capgoIosDistribution)
    credentials.CAPGO_IOS_DISTRIBUTION = capgoIosDistribution as 'app_store' | 'ad_hoc'
  if (capgoIosProvisioningMap)
    credentials.CAPGO_IOS_PROVISIONING_MAP = capgoIosProvisioningMap

  // Android credentials
  const trimmedFlavor = capgoAndroidFlavor?.trim()
  if (trimmedFlavor)
    credentials.CAPGO_ANDROID_FLAVOR = trimmedFlavor
  if (androidKeystoreFile)
    credentials.ANDROID_KEYSTORE_FILE = androidKeystoreFile
  if (keystoreKeyAlias)
    credentials.KEYSTORE_KEY_ALIAS = keystoreKeyAlias
  if (keystoreKeyPassword)
    credentials.KEYSTORE_KEY_PASSWORD = keystoreKeyPassword
  if (keystoreStorePassword)
    credentials.KEYSTORE_STORE_PASSWORD = keystoreStorePassword
  if (playConfigJson)
    credentials.PLAY_CONFIG_JSON = playConfigJson
  if (playStoreInAppUpdatePriority) {
    credentials.PLAY_STORE_IN_APP_UPDATE_PRIORITY = String(parseInAppUpdatePriority(playStoreInAppUpdatePriority))
  }
  if (buildOutputUploadEnabled) {
    credentials.BUILD_OUTPUT_UPLOAD_ENABLED = parseOptionalBoolean(buildOutputUploadEnabled) ? 'true' : 'false'
  }
  if (buildOutputRetentionSeconds) {
    credentials.BUILD_OUTPUT_RETENTION_SECONDS = String(parseOutputRetentionSeconds(buildOutputRetentionSeconds))
  }
  if (skipBuildNumberBump) {
    credentials.SKIP_BUILD_NUMBER_BUMP = parseOptionalBoolean(skipBuildNumberBump) ? 'true' : 'false'
  }
  if (skipMarketingVersionBump) {
    credentials.SKIP_MARKETING_VERSION_BUMP = parseOptionalBoolean(skipMarketingVersionBump) ? 'true' : 'false'
  }

  return credentials
}

/**
 * Merge credentials from all three sources with proper precedence:
 * 1. CLI arguments (highest priority)
 * 2. Environment variables (middle priority)
 * 3. Saved credentials file (lowest priority)
 */
export async function mergeCredentials(
  appId: string,
  platform: 'ios' | 'android',
  cliArgs?: Partial<BuildCredentials>,
): Promise<BuildCredentials | undefined> {
  // Load from all three sources
  const saved = await loadSavedCredentials(appId)
  const envCreds = loadCredentialsFromEnv()

  // Start with saved credentials (lowest priority)
  const merged: Partial<BuildCredentials> = { ...(saved?.[platform] || {}) }

  // Merge env vars (middle priority)
  Object.assign(merged, envCreds)

  // Merge CLI args (highest priority)
  if (cliArgs) {
    Object.assign(merged, cliArgs)
  }

  // For Android: if only one password is provided, use it for both
  if (platform === 'android') {
    const hasKeyPassword = !!merged.KEYSTORE_KEY_PASSWORD
    const hasStorePassword = !!merged.KEYSTORE_STORE_PASSWORD

    if (hasKeyPassword && !hasStorePassword) {
      merged.KEYSTORE_STORE_PASSWORD = merged.KEYSTORE_KEY_PASSWORD
    }
    else if (!hasKeyPassword && hasStorePassword) {
      merged.KEYSTORE_KEY_PASSWORD = merged.KEYSTORE_STORE_PASSWORD
    }
  }

  // Return undefined if no credentials found at all
  return Object.keys(merged).length > 0 ? (merged as BuildCredentials) : undefined
}

/**
 * Convert file paths to base64 credentials
 */
export async function convertFilesToCredentials(
  platform: 'ios' | 'android',
  files: CredentialFile,
  passwords: Partial<BuildCredentials> = {},
): Promise<BuildCredentials> {
  const credentials: BuildCredentials = { ...passwords }

  if (platform === 'ios') {
    // iOS certificates
    if (files.BUILD_CERTIFICATE_FILE) {
      credentials.BUILD_CERTIFICATE_BASE64 = await fileToBase64(files.BUILD_CERTIFICATE_FILE)
    }
    if (files.APPLE_KEY_FILE) {
      credentials.APPLE_KEY_CONTENT = await fileToBase64(files.APPLE_KEY_FILE)
    }
  }
  else if (platform === 'android') {
    // Android keystore and service account
    if (files.ANDROID_KEYSTORE_PATH) {
      credentials.ANDROID_KEYSTORE_FILE = await fileToBase64(files.ANDROID_KEYSTORE_PATH)
    }
    if (files.PLAY_CONFIG_JSON_PATH) {
      credentials.PLAY_CONFIG_JSON = await fileToBase64(files.PLAY_CONFIG_JSON_PATH)
    }
  }

  return credentials
}

/**
 * Update saved credentials for a specific app and platform
 */
export async function updateSavedCredentials(
  appId: string,
  platform: 'ios' | 'android',
  credentials: Partial<BuildCredentials>,
  local?: boolean,
): Promise<void> {
  const all = await loadAllCredentials(local)
  const saved = all[appId] || {}

  saved[platform] = {
    ...saved[platform],
    ...credentials,
  }

  all[appId] = saved
  await saveAllCredentials(all, local)
}

/**
 * Remove specific credential keys for an app/platform.
 * Used during migration to clean up legacy keys.
 */
export async function removeSavedCredentialKeys(
  appId: string,
  platform: 'ios' | 'android',
  keys: string[],
  local?: boolean,
): Promise<void> {
  const all = await loadAllCredentials(local)
  const saved = all[appId]
  if (!saved || !saved[platform])
    return

  for (const key of keys) {
    delete (saved[platform] as Record<string, unknown>)[key]
  }

  all[appId] = saved
  await saveAllCredentials(all, local)
}

/**
 * Clear saved credentials for a specific app and/or platform
 */
export async function clearSavedCredentials(appId?: string, platform?: 'ios' | 'android', local?: boolean): Promise<void> {
  const all = await loadAllCredentials(local)

  if (!appId) {
    // Clear all apps
    await saveAllCredentials({}, local)
    return
  }

  if (!platform) {
    // Clear all platforms for this app
    delete all[appId]
    await saveAllCredentials(all, local)
    return
  }

  // Clear specific platform for this app
  const saved = all[appId] || {}
  delete saved[platform]

  if (Object.keys(saved).length === 0) {
    // If no platforms left, remove the app entry
    delete all[appId]
  }
  else {
    all[appId] = saved
  }

  await saveAllCredentials(all, local)
}

/**
 * Get saved credentials for a specific app and platform
 */
export async function getSavedCredentials(appId: string, platform: 'ios' | 'android', local?: boolean): Promise<Partial<BuildCredentials> | null> {
  const saved = await loadSavedCredentials(appId, local)
  return saved?.[platform] || null
}

/**
 * List all apps that have saved credentials
 */
export async function listAllApps(local?: boolean): Promise<string[]> {
  const all = await loadAllCredentials(local)
  return Object.keys(all)
}

/**
 * Get the local credentials file path (for display purposes)
 */
export function getLocalCredentialsPath(): string {
  return join(cwd(), LOCAL_CREDENTIALS_FILE)
}

/**
 * Get the global credentials file path (for display purposes)
 */
export function getGlobalCredentialsPath(): string {
  return CREDENTIALS_FILE
}
