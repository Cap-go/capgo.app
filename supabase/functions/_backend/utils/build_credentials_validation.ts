/**
 * Server-side native build credential rules (pure, no I/O).
 *
 * Ported from the CLI so stored credentials (`/build/credentials`) and
 * `/build/request` with `use_stored_credentials` enforce the same contract the
 * CLI enforces locally:
 * - allowed keys and --build-env reserved names: cli/src/build/build-env.ts
 * - value normalizers: cli/src/build/credentials.ts
 * - required-credential matrix and splitPayload: cli/src/build/request.ts
 *
 * Error strings intentionally match the CLI so users see the same guidance.
 * Never put credential values in errors, summaries or logs: key names only.
 */

export type BuildPlatform = 'ios' | 'android'
export type CredentialRecord = Record<string, string>

export class BuildCredentialsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildCredentialsValidationError'
  }
}

export const MIN_OUTPUT_RETENTION_SECONDS = 60 * 60
export const MAX_OUTPUT_RETENTION_SECONDS = 7 * 24 * 60 * 60

/** Secret / credential keys understood by the builder (cli/src/schemas/build.ts buildCredentialsSchema). */
export const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'BUILD_CERTIFICATE_BASE64',
  'BUILD_PROVISION_PROFILE_BASE64',
  'APPLE_PROFILE_NAME',
  'P12_PASSWORD',
  'APPLE_KEY_ID',
  'APPLE_ISSUER_ID',
  'APPLE_KEY_CONTENT',
  'APP_STORE_CONNECT_TEAM_ID',
  'FASTLANE_USER',
  'FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD',
  'APPLE_APP_ID',
  'CAPGO_IOS_PROVISIONING_MAP',
  'ANDROID_KEYSTORE_FILE',
  'KEYSTORE_KEY_ALIAS',
  'KEYSTORE_KEY_PASSWORD',
  'KEYSTORE_STORE_PASSWORD',
  'PLAY_CONFIG_JSON',
  'PLAY_STORE_TRACK',
  'PLAY_STORE_RELEASE_STATUS',
  'PLAY_STORE_IN_APP_UPDATE_PRIORITY',
])

/** Non-secret build options that the CLI keeps out of build_credentials (request.ts NON_CREDENTIAL_KEYS). */
export const NON_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'CAPGO_IOS_SCHEME',
  'CAPGO_IOS_TARGET',
  'CAPGO_IOS_DISTRIBUTION',
  'CAPGO_IOS_XCODE_VERSION',
  'BUILD_OUTPUT_UPLOAD_ENABLED',
  'BUILD_OUTPUT_RETENTION_SECONDS',
  'SKIP_BUILD_NUMBER_BUMP',
  'SKIP_MARKETING_VERSION_BUMP',
  'CAPGO_STORE_SUBMIT_REVIEW',
  'CAPGO_STORE_RELEASE_NAME',
  'CAPGO_STORE_RELEASE_NOTES',
  'CAPGO_STORE_RELEASE_NOTES_LOCALIZED',
  'CAPGO_IOS_AUTOMATIC_RELEASE',
  'CAPGO_IOS_TESTFLIGHT_GROUPS',
  'CAPGO_IOS_SOURCE_DIR',
  'CAPGO_IOS_APP_DIR',
  'CAPGO_IOS_PROJECT_DIR',
  'IOS_PROJECT_DIR',
  'CAPGO_ANDROID_SOURCE_DIR',
  'CAPGO_ANDROID_APP_DIR',
  'CAPGO_ANDROID_PROJECT_DIR',
  'ANDROID_PROJECT_DIR',
  'CAPGO_ANDROID_FLAVOR',
])

/** Env-only alias the CLI decodes into CAPGO_IOS_PROVISIONING_MAP. */
const PROVISIONING_MAP_BASE64_KEY = 'CAPGO_IOS_PROVISIONING_MAP_BASE64'

const BUILD_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/
const MAX_KEY_LENGTH = 128
const MAX_KEYS = 200

// cli/src/build/build-env.ts RESERVED_BUILD_ENV_KEYS minus the Capgo credential/option keys,
// which are allowed here through CREDENTIAL_KEYS / NON_CREDENTIAL_KEYS.
const RESERVED_RUNNER_KEYS: ReadonlySet<string> = new Set([
  'JOB_ID',
  'DOWNLOAD_URL',
  'SECRETS_URL',
  'SECRET_TOKEN',
  'FASTLANE_PACKAGE_URL',
  'FASTLANE_PACKAGE_TOKEN',
  'REPORT_EVENT_URL',
  'REPORT_EVENT_TOKEN',
  'CACHE_ENSURE_URL',
  'CACHE_ENSURE_TOKEN',
  'CACHE_DOWNLOAD_URL',
  'CACHE_UPLOAD_URL',
  'GRADLE_USER_HOME',
  'ANDROID_USER_HOME',
  'CP_HOME_DIR',
])
const RESERVED_BUILD_ENV_PREFIXES = ['CAPGO_', 'OUTPUT_UPLOAD_URL_', 'OUTPUT_DOWNLOAD_URL_', 'LOGS_INSERT_', 'STATUS_REPORT_']

const BOOLEAN_KEYS = [
  'BUILD_OUTPUT_UPLOAD_ENABLED',
  'SKIP_BUILD_NUMBER_BUMP',
  'SKIP_MARKETING_VERSION_BUMP',
  'CAPGO_STORE_SUBMIT_REVIEW',
  'CAPGO_IOS_AUTOMATIC_RELEASE',
] as const

const IOS_DISTRIBUTION_MODES = ['app_store', 'ad_hoc'] as const
export const ANDROID_PLAY_STORE_TRACKS = ['internal', 'alpha', 'beta', 'production'] as const
export const ANDROID_PLAY_STORE_RELEASE_STATUSES = ['draft', 'completed', 'inProgress', 'halted'] as const

const LEGACY_PROVISIONING_MESSAGE = 'Legacy provisioning profile format detected. Run: npx @capgo/cli build credentials migrate --platform ios'

// ---------------------------------------------------------------------------
// Value normalizers (cli/src/build/credentials.ts)
// ---------------------------------------------------------------------------

export function parseOptionalBoolean(value: boolean | string | undefined, key = 'output-upload'): boolean {
  if (value === undefined)
    return true
  if (typeof value === 'boolean')
    return value
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes')
    return true
  if (normalized === 'false' || normalized === '0' || normalized === 'no')
    return false
  throw new BuildCredentialsValidationError(`${key} must be true/false`)
}

export function parseOutputRetentionSeconds(raw: string): number {
  const match = raw.trim().match(/^(\d+)\s*([smhd])?$/i)
  if (!match)
    throw new BuildCredentialsValidationError('output-retention must be a number with optional unit: s, m, h, d (examples: 1h, 3600s, 2d)')
  const value = Number.parseInt(match[1]!, 10)
  const unit = (match[2] || 's').toLowerCase()
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 60 * 60 : 24 * 60 * 60
  const seconds = value * multiplier
  if (seconds < MIN_OUTPUT_RETENTION_SECONDS)
    throw new BuildCredentialsValidationError(`output-retention must be at least ${MIN_OUTPUT_RETENTION_SECONDS} seconds (1h)`)
  if (seconds > MAX_OUTPUT_RETENTION_SECONDS)
    throw new BuildCredentialsValidationError(`output-retention must be at most ${MAX_OUTPUT_RETENTION_SECONDS} seconds (7d)`)
  return seconds
}

export function parseInAppUpdatePriority(value: string): number {
  if (value.trim() === '')
    throw new BuildCredentialsValidationError('in-app-update-priority must be an integer between 0 and 5')
  const num = Number(value)
  if (!Number.isInteger(num) || num < 0 || num > 5)
    throw new BuildCredentialsValidationError('in-app-update-priority must be an integer between 0 and 5')
  return num
}

export function parseAndroidPlayStoreTrack(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!(ANDROID_PLAY_STORE_TRACKS as readonly string[]).includes(normalized))
    throw new BuildCredentialsValidationError(`android-track must be one of: ${ANDROID_PLAY_STORE_TRACKS.join(', ')}`)
  return normalized
}

export function parseAndroidPlayStoreReleaseStatus(value: string): string {
  const trimmed = value.trim()
  const normalized = trimmed.toLowerCase() === 'inprogress' ? 'inProgress' : trimmed
  if (!(ANDROID_PLAY_STORE_RELEASE_STATUSES as readonly string[]).includes(normalized))
    throw new BuildCredentialsValidationError(`android-release-status must be one of: ${ANDROID_PLAY_STORE_RELEASE_STATUSES.join(', ')}`)
  return normalized
}

/** "Xcode 26.0" -> "26.0"; undefined when not a dotted version (cli request.ts normalizeMachineVersion). */
export function normalizeMachineVersion(value: string): string | undefined {
  const trimmed = value.trim().replace(/^xcode\s*/i, '')
  return /^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(trimmed) ? trimmed : undefined
}

export function parseStoreReleaseNotesLocalizedJson(value?: string): Record<string, string> | undefined {
  const raw = value?.trim()
  if (!raw)
    return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (error) {
    throw new BuildCredentialsValidationError(`CAPGO_STORE_RELEASE_NOTES_LOCALIZED must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new BuildCredentialsValidationError('CAPGO_STORE_RELEASE_NOTES_LOCALIZED must be a JSON object like {"en-US":"Bug fixes"}')
  const localized: Record<string, string> = {}
  for (const [locale, notes] of Object.entries(parsed)) {
    const cleanLocale = locale.trim()
    if (typeof notes !== 'string' || !notes.trim())
      throw new BuildCredentialsValidationError(`CAPGO_STORE_RELEASE_NOTES_LOCALIZED.${cleanLocale || locale} must be a non-empty string`)
    if (!cleanLocale)
      throw new BuildCredentialsValidationError('CAPGO_STORE_RELEASE_NOTES_LOCALIZED cannot contain an empty locale key')
    localized[cleanLocale] = notes.trim()
  }
  return Object.keys(localized).length > 0 ? localized : undefined
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.trim())
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.codePointAt(i) ?? 0
  return new TextDecoder().decode(bytes)
}

function decodeBase64Latin1(value: string): string {
  try {
    return atob(value.replaceAll(/\s/g, ''))
  }
  catch {
    return ''
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** { bundleId: { profile: base64, name } }, the CLI's persisted provisioning map contract. */
function parseProvisioningMapJson(raw: string): Record<string, { profile: string, name: string }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new BuildCredentialsValidationError('CAPGO_IOS_PROVISIONING_MAP must be valid JSON')
  }
  if (!isPlainRecord(parsed) || Object.keys(parsed).length === 0)
    throw new BuildCredentialsValidationError('CAPGO_IOS_PROVISIONING_MAP must be a non-empty JSON object of bundle id to { profile, name }')
  for (const [bundleId, entry] of Object.entries(parsed)) {
    if (!isPlainRecord(entry) || typeof entry.profile !== 'string' || !entry.profile || typeof entry.name !== 'string')
      throw new BuildCredentialsValidationError(`CAPGO_IOS_PROVISIONING_MAP.${bundleId} must be an object with string "profile" (base64) and "name"`)
  }
  return parsed as Record<string, { profile: string, name: string }>
}

// ---------------------------------------------------------------------------
// Key rules (cli/src/build/build-env.ts)
// ---------------------------------------------------------------------------

/** Throws when a key is not a Capgo credential/option key nor a valid custom build env name. */
export function assertAllowedCredentialKey(key: string): void {
  if (CREDENTIAL_KEYS.has(key) || NON_CREDENTIAL_KEYS.has(key) || key === PROVISIONING_MAP_BASE64_KEY)
    return
  if (key.length > MAX_KEY_LENGTH || !BUILD_ENV_KEY_PATTERN.test(key))
    throw new BuildCredentialsValidationError(`--build-env ${key.slice(0, MAX_KEY_LENGTH) || '(empty)'}: env var names must be uppercase letters, digits and _ (e.g. SENTRY_AUTH_TOKEN)`)
  if (RESERVED_RUNNER_KEYS.has(key) || RESERVED_BUILD_ENV_PREFIXES.some(prefix => key.startsWith(prefix)))
    throw new BuildCredentialsValidationError(`--build-env ${key}: reserved by Capgo; use the dedicated build option instead`)
}

/** Shape check for untrusted input: a flat object of string values with allowed keys. */
export function parseCredentialRecord(input: unknown, label = 'credentials'): CredentialRecord {
  if (!isPlainRecord(input))
    throw new BuildCredentialsValidationError(`${label} must be a JSON object of string values`)
  const entries = Object.entries(input)
  if (entries.length > MAX_KEYS)
    throw new BuildCredentialsValidationError(`${label} has too many keys (max ${MAX_KEYS})`)
  const result: CredentialRecord = {}
  for (const [key, value] of entries) {
    assertAllowedCredentialKey(key)
    if (typeof value !== 'string')
      throw new BuildCredentialsValidationError(`${label}.${key} must be a string`)
    result[key] = value
  }
  return result
}

/**
 * Normalize values the way the CLI does when loading env/saved credentials.
 * Empty values are dropped (the CLI never forwards empty strings). Throws on invalid values.
 */
export function normalizeCredentialValues(platform: BuildPlatform, input: CredentialRecord): CredentialRecord {
  const out: CredentialRecord = {}
  for (const [key, value] of Object.entries(input)) {
    if (value.trim() === '')
      continue
    out[key] = value
  }

  if (out[PROVISIONING_MAP_BASE64_KEY] !== undefined) {
    if (!out.CAPGO_IOS_PROVISIONING_MAP) {
      try {
        out.CAPGO_IOS_PROVISIONING_MAP = decodeBase64Utf8(out[PROVISIONING_MAP_BASE64_KEY]!)
      }
      catch {
        throw new BuildCredentialsValidationError(`${PROVISIONING_MAP_BASE64_KEY} must be base64-encoded JSON`)
      }
    }
    delete out[PROVISIONING_MAP_BASE64_KEY]
  }

  for (const key of BOOLEAN_KEYS) {
    if (out[key] !== undefined)
      out[key] = parseOptionalBoolean(out[key], key) ? 'true' : 'false'
  }
  if (out.BUILD_OUTPUT_RETENTION_SECONDS !== undefined)
    out.BUILD_OUTPUT_RETENTION_SECONDS = String(parseOutputRetentionSeconds(out.BUILD_OUTPUT_RETENTION_SECONDS))
  if (out.PLAY_STORE_TRACK !== undefined)
    out.PLAY_STORE_TRACK = parseAndroidPlayStoreTrack(out.PLAY_STORE_TRACK)
  if (out.PLAY_STORE_RELEASE_STATUS !== undefined)
    out.PLAY_STORE_RELEASE_STATUS = parseAndroidPlayStoreReleaseStatus(out.PLAY_STORE_RELEASE_STATUS)
  if (out.PLAY_STORE_IN_APP_UPDATE_PRIORITY !== undefined)
    out.PLAY_STORE_IN_APP_UPDATE_PRIORITY = String(parseInAppUpdatePriority(out.PLAY_STORE_IN_APP_UPDATE_PRIORITY))
  for (const key of ['CAPGO_ANDROID_FLAVOR', 'CAPGO_IOS_XCODE_VERSION', 'CAPGO_STORE_RELEASE_NAME', 'CAPGO_STORE_RELEASE_NOTES', 'CAPGO_IOS_TESTFLIGHT_GROUPS', 'CAPGO_STORE_RELEASE_NOTES_LOCALIZED']) {
    if (out[key] !== undefined)
      out[key] = out[key]!.trim()
  }
  if (out.CAPGO_STORE_RELEASE_NOTES_LOCALIZED !== undefined)
    parseStoreReleaseNotesLocalizedJson(out.CAPGO_STORE_RELEASE_NOTES_LOCALIZED)
  if (out.CAPGO_IOS_DISTRIBUTION !== undefined && !(IOS_DISTRIBUTION_MODES as readonly string[]).includes(out.CAPGO_IOS_DISTRIBUTION))
    throw new BuildCredentialsValidationError(`Invalid CAPGO_IOS_DISTRIBUTION value: '${out.CAPGO_IOS_DISTRIBUTION}'. Must be one of: ${IOS_DISTRIBUTION_MODES.join(', ')}`)
  if (out.CAPGO_IOS_XCODE_VERSION !== undefined) {
    const xcodeVersion = normalizeMachineVersion(out.CAPGO_IOS_XCODE_VERSION)
    if (!xcodeVersion)
      throw new BuildCredentialsValidationError(`Invalid --xcode-version / CAPGO_IOS_XCODE_VERSION value: '${out.CAPGO_IOS_XCODE_VERSION}'. Use a version like 26, 26.1 or 16.4.1`)
    out.CAPGO_IOS_XCODE_VERSION = xcodeVersion
  }
  if (out.CAPGO_IOS_PROVISIONING_MAP !== undefined)
    parseProvisioningMapJson(out.CAPGO_IOS_PROVISIONING_MAP)
  if (out.APPLE_APP_ID !== undefined && !/^\d+$/.test(out.APPLE_APP_ID.trim()))
    throw new BuildCredentialsValidationError('APPLE_APP_ID must be the app\'s numeric App Store Connect id (digits only, e.g. 1234567890)')

  if (platform === 'ios') {
    const hasLegacyProvisioning = !!(out.BUILD_PROVISION_PROFILE_BASE64 || out.APPLE_PROFILE_NAME)
    if (hasLegacyProvisioning && !out.CAPGO_IOS_PROVISIONING_MAP)
      throw new BuildCredentialsValidationError(LEGACY_PROVISIONING_MESSAGE)
  }
  return applyAndroidPasswordCopy(platform, out)
}

/** Android: when only one keystore password is set, use it for both (cli mergeCredentials). */
export function applyAndroidPasswordCopy(platform: BuildPlatform, credentials: CredentialRecord): CredentialRecord {
  if (platform !== 'android')
    return credentials
  const out = { ...credentials }
  if (out.KEYSTORE_KEY_PASSWORD && !out.KEYSTORE_STORE_PASSWORD)
    out.KEYSTORE_STORE_PASSWORD = out.KEYSTORE_KEY_PASSWORD
  else if (!out.KEYSTORE_KEY_PASSWORD && out.KEYSTORE_STORE_PASSWORD)
    out.KEYSTORE_KEY_PASSWORD = out.KEYSTORE_STORE_PASSWORD
  return out
}

// ---------------------------------------------------------------------------
// Required-credential matrix (cli/src/build/request.ts requestBuildInternal)
// ---------------------------------------------------------------------------

export interface CredentialRequirementsResult {
  /** CLI-style "missing credential" messages. Empty when the set can build. */
  missing: string[]
  /** Fatal format problems that the CLI reports with a dedicated error (legacy provisioning). */
  fatal?: string
  /** Credentials with normalized iOS distribution / Xcode version written back. */
  credentials: CredentialRecord
}

export function checkCredentialRequirements(platform: BuildPlatform, input: CredentialRecord): CredentialRequirementsResult {
  const creds: CredentialRecord = { ...input }
  const missing: string[] = []

  if (platform === 'ios') {
    const rawDistributionMode = creds.CAPGO_IOS_DISTRIBUTION
    const isValidMode = !!rawDistributionMode && (IOS_DISTRIBUTION_MODES as readonly string[]).includes(rawDistributionMode)
    if (rawDistributionMode && !isValidMode)
      missing.push(`Invalid CAPGO_IOS_DISTRIBUTION value: '${rawDistributionMode}'. Must be one of: ${IOS_DISTRIBUTION_MODES.join(', ')}`)
    const distributionMode = isValidMode ? rawDistributionMode! : 'app_store'
    creds.CAPGO_IOS_DISTRIBUTION = distributionMode

    const rawXcodeVersion = creds.CAPGO_IOS_XCODE_VERSION
    if (rawXcodeVersion !== undefined && !rawXcodeVersion.trim()) {
      delete creds.CAPGO_IOS_XCODE_VERSION
    }
    else if (rawXcodeVersion !== undefined) {
      const xcodeVersion = normalizeMachineVersion(rawXcodeVersion)
      if (xcodeVersion)
        creds.CAPGO_IOS_XCODE_VERSION = xcodeVersion
      else
        missing.push(`Invalid --xcode-version / CAPGO_IOS_XCODE_VERSION value: '${rawXcodeVersion}'. Use a version like 26, 26.1 or 16.4.1`)
    }
    if (creds.CAPGO_STORE_SUBMIT_REVIEW === 'true' && distributionMode !== 'app_store')
      missing.push('--submit-to-store-review on iOS requires --ios-distribution app_store')

    if (!creds.BUILD_CERTIFICATE_BASE64)
      missing.push('BUILD_CERTIFICATE_BASE64 (or --build-certificate-base64)')

    const hasLegacyProvisioning = !!(creds.BUILD_PROVISION_PROFILE_BASE64 || creds.APPLE_PROFILE_NAME)
    if (hasLegacyProvisioning && !creds.CAPGO_IOS_PROVISIONING_MAP)
      return { missing, fatal: LEGACY_PROVISIONING_MESSAGE, credentials: creds }

    if (!creds.CAPGO_IOS_PROVISIONING_MAP)
      missing.push('CAPGO_IOS_PROVISIONING_MAP (use --ios-provisioning-profile or save via "build credentials save")')

    if (distributionMode === 'app_store') {
      const hasAppleKeyId = !!creds.APPLE_KEY_ID
      const hasAppleIssuerId = !!creds.APPLE_ISSUER_ID
      const hasAppleKeyContent = !!creds.APPLE_KEY_CONTENT
      const anyAppleApiField = hasAppleKeyId || hasAppleIssuerId || hasAppleKeyContent
      const hasCompleteAppleApiKey = hasAppleKeyId && hasAppleIssuerId && hasAppleKeyContent
      const hasFastlaneUser = !!creds.FASTLANE_USER
      const hasAppSpecificPassword = !!creds.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD
      const hasAppleAppId = !!creds.APPLE_APP_ID
      const anyAppSpecificField = hasFastlaneUser || hasAppSpecificPassword || hasAppleAppId
      const hasCompleteAppSpecificPassword = hasFastlaneUser && hasAppSpecificPassword && hasAppleAppId

      if (creds.CAPGO_STORE_SUBMIT_REVIEW === 'true' && !hasCompleteAppleApiKey)
        missing.push('App Store Connect API key (APPLE_KEY_ID/APPLE_ISSUER_ID/APPLE_KEY_CONTENT) is required for --submit-to-store-review on iOS')
      if (hasAppleAppId && !/^\d+$/.test(String(creds.APPLE_APP_ID).trim()))
        missing.push('APPLE_APP_ID must be the app\'s numeric App Store Connect id (digits only, e.g. 1234567890)')

      if (hasCompleteAppleApiKey || hasCompleteAppSpecificPassword) {
        // Upload auth present.
      }
      else if (anyAppSpecificField) {
        const fields: string[] = []
        if (!hasFastlaneUser)
          fields.push('FASTLANE_USER (or --apple-id)')
        if (!hasAppSpecificPassword)
          fields.push('FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD (or --apple-app-specific-password)')
        if (!hasAppleAppId)
          fields.push('APPLE_APP_ID (or --apple-app-id)')
        missing.push(`Incomplete app-specific password credentials - missing: ${fields.join(', ')}`)
      }
      else if (anyAppleApiField) {
        const fields: string[] = []
        if (!hasAppleKeyId)
          fields.push('APPLE_KEY_ID (or --apple-key-id)')
        if (!hasAppleIssuerId)
          fields.push('APPLE_ISSUER_ID (or --apple-issuer-id)')
        if (!hasAppleKeyContent)
          fields.push('APPLE_KEY_CONTENT (or --apple-key-content)')
        missing.push(`Incomplete App Store Connect API key - missing: ${fields.join(', ')}`)
      }
      else if (creds.BUILD_OUTPUT_UPLOAD_ENABLED !== 'true') {
        missing.push('App Store Connect API key (APPLE_KEY_ID/APPLE_ISSUER_ID/APPLE_KEY_CONTENT) or app-specific password (FASTLANE_USER + FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD + APPLE_APP_ID) or BUILD_OUTPUT_UPLOAD_ENABLED=true (or --output-upload) (build has no output destination - enable either TestFlight upload or Capgo download link)')
      }
      else if (creds.SKIP_BUILD_NUMBER_BUMP !== 'true' || creds.SKIP_MARKETING_VERSION_BUMP !== 'true') {
        missing.push('App Store Connect API key (APPLE_KEY_ID/APPLE_ISSUER_ID/APPLE_KEY_CONTENT) or app-specific password or --skip-build-number-bump and --skip-marketing-version-bump (iOS versions cannot be auto-incremented without App Store Connect credentials)')
      }
    }

    if (!creds.APP_STORE_CONNECT_TEAM_ID)
      missing.push('APP_STORE_CONNECT_TEAM_ID (or --app-store-connect-team-id)')
  }
  else {
    if (!creds.ANDROID_KEYSTORE_FILE)
      missing.push('ANDROID_KEYSTORE_FILE (or --android-keystore-file)')
    if (!creds.KEYSTORE_KEY_ALIAS)
      missing.push('KEYSTORE_KEY_ALIAS (or --keystore-key-alias)')
    if (!creds.KEYSTORE_KEY_PASSWORD && !creds.KEYSTORE_STORE_PASSWORD)
      missing.push('KEYSTORE_KEY_PASSWORD or KEYSTORE_STORE_PASSWORD (at least one password required)')
    if (!creds.PLAY_CONFIG_JSON) {
      if (creds.CAPGO_STORE_SUBMIT_REVIEW === 'true')
        missing.push('PLAY_CONFIG_JSON is required for --submit-to-store-review on Android')
      else if (creds.BUILD_OUTPUT_UPLOAD_ENABLED !== 'true')
        missing.push('PLAY_CONFIG_JSON or BUILD_OUTPUT_UPLOAD_ENABLED=true (build has no output destination - enable either Play Store upload or Capgo download link)')
    }
  }

  return { missing, credentials: creds }
}

// ---------------------------------------------------------------------------
// build_options <-> flat key mapping (cli/src/build/request.ts splitPayload)
// ---------------------------------------------------------------------------

type OptionKind = 'string' | 'boolean' | 'number' | 'localized'

/** build_options field -> flat credential key, as produced by the CLI splitPayload. */
const OPTION_KEY_MAP: ReadonlyArray<readonly [option: string, key: string, kind: OptionKind]> = [
  ['iosScheme', 'CAPGO_IOS_SCHEME', 'string'],
  ['iosTarget', 'CAPGO_IOS_TARGET', 'string'],
  ['iosDistribution', 'CAPGO_IOS_DISTRIBUTION', 'string'],
  ['iosXcodeVersion', 'CAPGO_IOS_XCODE_VERSION', 'string'],
  ['iosSourceDir', 'CAPGO_IOS_SOURCE_DIR', 'string'],
  ['iosAppDir', 'CAPGO_IOS_APP_DIR', 'string'],
  ['iosProjectDir', 'CAPGO_IOS_PROJECT_DIR', 'string'],
  ['androidSourceDir', 'CAPGO_ANDROID_SOURCE_DIR', 'string'],
  ['androidAppDir', 'CAPGO_ANDROID_APP_DIR', 'string'],
  ['androidProjectDir', 'CAPGO_ANDROID_PROJECT_DIR', 'string'],
  ['androidFlavor', 'CAPGO_ANDROID_FLAVOR', 'string'],
  ['outputUploadEnabled', 'BUILD_OUTPUT_UPLOAD_ENABLED', 'boolean'],
  ['outputRetentionSeconds', 'BUILD_OUTPUT_RETENTION_SECONDS', 'number'],
  ['skipBuildNumberBump', 'SKIP_BUILD_NUMBER_BUMP', 'boolean'],
  ['skipMarketingVersionBump', 'SKIP_MARKETING_VERSION_BUMP', 'boolean'],
  ['submitToStoreReview', 'CAPGO_STORE_SUBMIT_REVIEW', 'boolean'],
  ['storeReleaseName', 'CAPGO_STORE_RELEASE_NAME', 'string'],
  ['storeReleaseNotes', 'CAPGO_STORE_RELEASE_NOTES', 'string'],
  ['storeReleaseNotesLocalized', 'CAPGO_STORE_RELEASE_NOTES_LOCALIZED', 'localized'],
  ['iosTestflightGroups', 'CAPGO_IOS_TESTFLIGHT_GROUPS', 'string'],
  ['iosAutomaticRelease', 'CAPGO_IOS_AUTOMATIC_RELEASE', 'boolean'],
]

function optionToFlatValue(kind: OptionKind, value: unknown): string | undefined {
  if (value === undefined || value === null)
    return undefined
  switch (kind) {
    case 'boolean':
      return typeof value === 'boolean' ? (value ? 'true' : 'false') : undefined
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : undefined
    case 'localized':
      return isPlainRecord(value) && Object.keys(value).length > 0 ? JSON.stringify(value) : undefined
    default:
      return typeof value === 'string' && value.trim() ? value : undefined
  }
}

function flatToOptionValue(kind: OptionKind, value: string): unknown {
  switch (kind) {
    case 'boolean':
      return value === 'true'
    case 'number':
      return Number.parseInt(value, 10) || MIN_OUTPUT_RETENTION_SECONDS
    case 'localized':
      return parseStoreReleaseNotesLocalizedJson(value)
    default:
      return value
  }
}

export interface MergeStoredCredentialsInput {
  platform: BuildPlatform
  /** Decrypted stored credentials (lowest priority). */
  stored: CredentialRecord
  /** Request body build_credentials (overrides stored). */
  requestCredentials: CredentialRecord
  /** Request body build_options (highest priority for fields that are present). */
  requestBuildOptions: Record<string, unknown>
  /** false = drop PLAY_CONFIG_JSON (CLI --no-playstore-upload). */
  playstoreUpload?: boolean
}

export interface MergeStoredCredentialsResult {
  buildOptions: Record<string, unknown>
  buildCredentials: CredentialRecord
}

/**
 * Merge stored credentials under the request's values, validate the merged set with the
 * CLI matrix and split it back into build_options / build_credentials (CLI splitPayload).
 *
 * Precedence, lowest to highest (same as CLI saved < env < flags):
 *   stored credentials < request build_credentials < request build_options fields that are present.
 * Stored non-secret option keys (CAPGO_IOS_DISTRIBUTION, BUILD_OUTPUT_UPLOAD_ENABLED, ...) fill
 * build_options fields the request left undefined; they never reach build_credentials.
 *
 * Throws BuildCredentialsValidationError with the CLI message on failure.
 */
export function mergeStoredCredentialsForBuild(input: MergeStoredCredentialsInput): MergeStoredCredentialsResult {
  const { platform, requestBuildOptions } = input
  const flat: CredentialRecord = { ...input.stored, ...input.requestCredentials }
  for (const [option, key, kind] of OPTION_KEY_MAP) {
    const value = optionToFlatValue(kind, requestBuildOptions[option])
    if (value !== undefined)
      flat[key] = value
  }
  if (input.playstoreUpload === false)
    delete flat.PLAY_CONFIG_JSON

  const normalized = normalizeCredentialValues(platform, flat)
  const { missing, fatal, credentials } = checkCredentialRequirements(platform, normalized)
  if (fatal)
    throw new BuildCredentialsValidationError(fatal)
  if (missing.length > 0)
    throw new BuildCredentialsValidationError(`Missing required credentials for ${platform}: ${missing.join(', ')}`)

  const buildOptions: Record<string, unknown> = { ...requestBuildOptions }
  for (const [option, key, kind] of OPTION_KEY_MAP) {
    if (option === 'iosXcodeVersion' && platform !== 'ios')
      continue
    const value = credentials[key]
    // Request-provided options keep their raw value; normalized iOS distribution/xcode win.
    if (value !== undefined && (buildOptions[option] === undefined || buildOptions[option] === null || option === 'iosDistribution' || option === 'iosXcodeVersion'))
      buildOptions[option] = flatToOptionValue(kind, value)
  }
  if (buildOptions.outputUploadEnabled === undefined)
    buildOptions.outputUploadEnabled = false
  if (buildOptions.outputRetentionSeconds === undefined)
    buildOptions.outputRetentionSeconds = MIN_OUTPUT_RETENTION_SECONDS
  for (const option of ['skipBuildNumberBump', 'skipMarketingVersionBump', 'submitToStoreReview']) {
    if (buildOptions[option] === undefined)
      buildOptions[option] = false
  }
  if (buildOptions.platform === undefined)
    buildOptions.platform = platform

  const buildCredentials: CredentialRecord = {}
  for (const [key, value] of Object.entries(credentials)) {
    if (!NON_CREDENTIAL_KEYS.has(key))
      buildCredentials[key] = value
  }
  return { buildOptions, buildCredentials }
}

// ---------------------------------------------------------------------------
// Non-secret summary
// ---------------------------------------------------------------------------

export interface ProvisioningProfileSummary {
  bundle_id: string
  name: string
  expires_at: string | null
}

export interface BuildCredentialsSummary {
  platform: BuildPlatform
  /** Key names only, sorted. Never values. */
  keys: string[]
  /** CLI matrix result under default build options (no extra flags). Empty = ready to build. */
  missing: string[]
  ios_distribution?: string
  app_store_connect_team_id?: string
  ios_upload_auth?: 'app_store_connect_api_key' | 'app_specific_password' | 'none'
  provisioning_profiles?: ProvisioningProfileSummary[]
  play_store_upload?: boolean
  custom_build_env_keys: string[]
}

/** Best-effort ExpirationDate from a base64 .mobileprovision (CMS-wrapped plist stays readable). */
export function readMobileprovisionExpiry(profileBase64: string): string | null {
  const text = decodeBase64Latin1(profileBase64)
  const match = text.match(/<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/)
  if (!match)
    return null
  const date = new Date(match[1]!.trim())
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function summarizeCredentials(platform: BuildPlatform, credentials: CredentialRecord): BuildCredentialsSummary {
  const keys = Object.keys(credentials).sort()
  const requirements = checkCredentialRequirements(platform, credentials)
  const summary: BuildCredentialsSummary = {
    platform,
    keys,
    missing: requirements.fatal ? [requirements.fatal] : requirements.missing,
    custom_build_env_keys: keys.filter(key => !CREDENTIAL_KEYS.has(key) && !NON_CREDENTIAL_KEYS.has(key)),
  }
  if (platform === 'ios') {
    summary.ios_distribution = requirements.credentials.CAPGO_IOS_DISTRIBUTION
    if (credentials.APP_STORE_CONNECT_TEAM_ID)
      summary.app_store_connect_team_id = credentials.APP_STORE_CONNECT_TEAM_ID
    summary.ios_upload_auth = credentials.APPLE_KEY_ID && credentials.APPLE_ISSUER_ID && credentials.APPLE_KEY_CONTENT
      ? 'app_store_connect_api_key'
      : credentials.FASTLANE_USER && credentials.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD && credentials.APPLE_APP_ID
        ? 'app_specific_password'
        : 'none'
    if (credentials.CAPGO_IOS_PROVISIONING_MAP) {
      try {
        const map = parseProvisioningMapJson(credentials.CAPGO_IOS_PROVISIONING_MAP)
        summary.provisioning_profiles = Object.entries(map).map(([bundleId, entry]) => ({
          bundle_id: bundleId,
          name: entry.name,
          expires_at: readMobileprovisionExpiry(entry.profile),
        }))
      }
      catch {
        summary.provisioning_profiles = []
      }
    }
  }
  else {
    summary.play_store_upload = !!credentials.PLAY_CONFIG_JSON
  }
  return summary
}
