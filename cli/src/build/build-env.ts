import process from 'node:process'

const BUILD_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/

// Names the builder owns: its runner variables and Capgo's own build credentials/options.
// Those have dedicated options (or must never be overridden).
const RESERVED_BUILD_ENV_KEYS = new Set([
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
  'BUILD_CERTIFICATE_BASE64',
  'P12_PASSWORD',
  'APPLE_KEY_ID',
  'APPLE_ISSUER_ID',
  'APPLE_KEY_CONTENT',
  'APP_STORE_CONNECT_TEAM_ID',
  'FASTLANE_USER',
  'FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD',
  'APPLE_APP_ID',
  'ANDROID_KEYSTORE_FILE',
  'KEYSTORE_KEY_ALIAS',
  'KEYSTORE_KEY_PASSWORD',
  'KEYSTORE_STORE_PASSWORD',
  'PLAY_CONFIG_JSON',
  'PLAY_STORE_TRACK',
  'PLAY_STORE_RELEASE_STATUS',
  'PLAY_STORE_IN_APP_UPDATE_PRIORITY',
  'BUILD_OUTPUT_UPLOAD_ENABLED',
  'BUILD_OUTPUT_RETENTION_SECONDS',
  'BUILD_SYMBOLS_UPLOAD_ENABLED',
  'SKIP_BUILD_NUMBER_BUMP',
  'SKIP_MARKETING_VERSION_BUMP',
  'IOS_PROJECT_DIR',
  'ANDROID_PROJECT_DIR',
])
const RESERVED_BUILD_ENV_PREFIXES = ['CAPGO_', 'OUTPUT_UPLOAD_URL_', 'OUTPUT_DOWNLOAD_URL_', 'LOGS_INSERT_', 'STATUS_REPORT_']

/**
 * Custom env vars for the cloud build, from repeatable `--build-env` entries and the
 * CAPGO_BUILD_ENV env var (comma-separated). `KEY` takes the value from this process's
 * environment (CI secrets stay out of the command line); `KEY=VALUE` sets it literally.
 * They reach the build as credentials: Gradle and Xcode build phases see them as env vars
 * (e.g. SENTRY_AUTH_TOKEN for the Sentry Gradle plugin).
 */
export function parseBuildEnv(
  entries: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const all = [
    ...(env.CAPGO_BUILD_ENV ?? '').split(',').map(entry => entry.trim()).filter(Boolean),
    ...(entries ?? []),
  ]
  const result: Record<string, string> = {}
  for (const entry of all) {
    const separator = entry.indexOf('=')
    const key = (separator === -1 ? entry : entry.slice(0, separator)).trim()
    if (!BUILD_ENV_KEY_PATTERN.test(key))
      throw new Error(`--build-env ${key || entry}: env var names must be uppercase letters, digits and _ (e.g. SENTRY_AUTH_TOKEN)`)
    if (RESERVED_BUILD_ENV_KEYS.has(key) || RESERVED_BUILD_ENV_PREFIXES.some(prefix => key.startsWith(prefix)))
      throw new Error(`--build-env ${key}: reserved by Capgo; use the dedicated build option instead`)
    const value = separator === -1 ? env[key] : entry.slice(separator + 1)
    if (value === undefined || value === '')
      throw new Error(`--build-env ${key}: ${separator === -1 ? 'the environment variable is not set' : 'empty value'}`)
    result[key] = value
  }
  return result
}
