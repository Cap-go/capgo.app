import type { BuildCredentials } from './request'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cwd, exit } from 'node:process'
import { log } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { createSupabaseClient, findSavedKey, getAppId, getConfig, getOrganizationId, sendEvent } from '../utils'
import {
  clearSavedCredentials,
  convertFilesToCredentials,
  getGlobalCredentialsPath,
  getLocalCredentialsPath,
  getSavedCredentials,
  listAllApps,
  loadSavedCredentials,
  MIN_OUTPUT_RETENTION_SECONDS,
  parseInAppUpdatePriority,
  parseOptionalBoolean,
  parseOutputRetentionSeconds,
  removeSavedCredentialKeys,
  updateSavedCredentials,
} from './credentials'
import { parseMobileprovision, parseMobileprovisionFromBase64 } from './mobileprovision-parser'
import { findSignableTargets, readPbxproj } from './pbxproj-parser'

interface SaveCredentialsOptions {
  platform?: 'ios' | 'android'
  appId?: string
  local?: boolean

  outputUpload?: boolean
  outputRetention?: string
  skipBuildNumberBump?: boolean
  skipMarketingVersionBump?: boolean

  // iOS options
  certificate?: string
  iosProvisioningProfile?: string[]
  overwriteIosProvisioningMap?: boolean
  p12Password?: string
  appleKey?: string
  appleKeyId?: string
  appleIssuerId?: string
  appleTeamId?: string
  iosDistribution?: 'app_store' | 'ad_hoc'
  // iOS app-specific password upload (alternative to App Store Connect API key)
  appleId?: string
  appleAppSpecificPassword?: string
  appleAppId?: string

  // Android options
  keystore?: string
  keystoreAlias?: string
  keystoreKeyPassword?: string
  keystoreStorePassword?: string
  playConfig?: string
  androidFlavor?: string
  inAppUpdatePriority?: number | string
}

/**
 * APPLE_APP_ID is the app's numeric App Store Connect id. Reject non-numeric
 * input at save/update time so users get immediate feedback instead of a
 * cryptic fastlane failure at build time.
 */
function assertNumericAppleAppId(appleAppId: string | undefined): void {
  if (appleAppId !== undefined && !/^\d+$/.test(appleAppId.trim())) {
    log.error('❌ --apple-app-id must be the app\'s numeric App Store Connect id (digits only, e.g. 1234567890)')
    exit(1)
  }
}

/**
 * Provisioning map entry: stores the base64-encoded profile and its extracted name
 */
interface ProvisioningMapEntry {
  profile: string
  name: string
}

/**
 * Build a provisioning map from --ios-provisioning-profile entries.
 *
 * Each entry is either:
 *   - "bundleId=path" (explicit bundle ID assignment)
 *   - "path" (auto-infer bundle ID by matching mobileprovision against pbxproj targets)
 */
export function buildProvisioningMap(
  entries: string[],
  projectDir?: string,
): Record<string, ProvisioningMapEntry> {
  const map: Record<string, ProvisioningMapEntry> = {}

  // Read pbxproj targets for auto-inference
  let pbxTargets: Array<{ name: string, bundleId: string, productType: string }> = []
  if (projectDir) {
    const pbxContent = readPbxproj(projectDir)
    if (pbxContent) {
      pbxTargets = findSignableTargets(pbxContent)
    }
  }

  for (const entry of entries) {
    const equalsIdx = entry.indexOf('=')
    let bundleId: string
    let profilePath: string

    if (equalsIdx !== -1) {
      // Explicit format: bundleId=path
      bundleId = entry.slice(0, equalsIdx).trim()
      profilePath = entry.slice(equalsIdx + 1).trim()

      if (!bundleId)
        throw new Error(`Empty bundle ID in provisioning profile entry: "${entry}"`)
      if (!profilePath)
        throw new Error(`Empty profile path in provisioning profile entry: "${entry}"`)
    }
    else {
      // Auto-infer: just a path
      profilePath = entry.trim()
      if (!profilePath)
        throw new Error('Empty provisioning profile entry')

      const resolved = resolve(profilePath)
      if (!existsSync(resolved)) {
        throw new Error(`Provisioning profile not found: ${resolved}`)
      }

      const info = parseMobileprovision(resolved)
      // Try to match against pbxproj targets
      const matchedTarget = pbxTargets.find(t => t.bundleId === info.bundleId)
      if (matchedTarget) {
        bundleId = info.bundleId
      }
      else if (info.bundleId.endsWith('.*')) {
        // Wildcard profile - match against main app target (first application target)
        const mainTarget = pbxTargets.find(t => t.productType === 'com.apple.product-type.application')
        if (mainTarget) {
          bundleId = mainTarget.bundleId
        }
        else {
          bundleId = info.bundleId
        }
      }
      else {
        bundleId = info.bundleId
      }
    }

    const resolvedPath = resolve(profilePath)
    if (!existsSync(resolvedPath)) {
      throw new Error(`Provisioning profile not found: ${resolvedPath}`)
    }

    if (map[bundleId])
      throw new Error(`Duplicate provisioning profile for bundle ID "${bundleId}". Each bundle ID can only have one profile.`)

    const profileData = readFileSync(resolvedPath)
    const base64 = profileData.toString('base64')
    const info = parseMobileprovision(resolvedPath)

    map[bundleId] = {
      profile: base64,
      name: info.name,
    }
  }

  return map
}

/**
 * Save build credentials locally
 *
 * SECURITY NOTE:
 * - Credentials are saved to ~/.capgo-credentials/credentials.json on YOUR local machine only
 * - When you run a build, credentials are sent to Capgo's build servers
 * - Credentials are NEVER stored permanently on Capgo servers
 * - They are automatically deleted after build completion
 */
export async function saveCredentialsCommand(options: SaveCredentialsOptions): Promise<void> {
  try {
    if (!options.platform) {
      log.error('Platform is required. Use --platform ios or --platform android')
      exit(1)
    }

    // Try to infer appId from capacitor.config if not provided
    const extConfig = await getConfig()
    const appId = getAppId(options.appId, extConfig?.config)

    if (!appId) {
      log.error('❌ App ID is required.')
      log.error('')
      log.error('Either:')
      log.error('  1. Run this command from a Capacitor project directory, OR')
      log.error('  2. Provide --appId explicitly: --appId com.example.app')
      log.error('')
      exit(1)
    }

    const platform = options.platform

    // Display security notice
    log.info('\n🔒 SECURITY NOTICE:')
    log.info('  - Credentials saved to ~/.capgo-credentials/credentials.json (local only)')
    log.info('  - When building, credentials are sent to Capgo servers')
    log.info('  - Credentials are NEVER stored on Capgo servers')
    log.info('  - Auto-deleted after build')
    log.info('  - Builds sent directly to app stores')
    log.info('  - Build outputs can optionally be uploaded for time-limited download links\n')

    const credentials: Partial<BuildCredentials> = {}
    const files: any = {}

    // Output upload settings: always save, inform user when defaulting
    if (options.outputUpload !== undefined) {
      credentials.BUILD_OUTPUT_UPLOAD_ENABLED = parseOptionalBoolean(options.outputUpload) ? 'true' : 'false'
    }
    else {
      credentials.BUILD_OUTPUT_UPLOAD_ENABLED = 'false'
      log.info('ℹ️  --output-upload not specified, defaulting to false (no Capgo download link)')
    }
    if (options.outputRetention) {
      credentials.BUILD_OUTPUT_RETENTION_SECONDS = String(parseOutputRetentionSeconds(options.outputRetention))
    }
    else {
      credentials.BUILD_OUTPUT_RETENTION_SECONDS = String(MIN_OUTPUT_RETENTION_SECONDS)
      log.info(`ℹ️  --output-retention not specified, defaulting to ${MIN_OUTPUT_RETENTION_SECONDS}s (1 hour)`)
    }
    if (options.skipBuildNumberBump !== undefined) {
      credentials.SKIP_BUILD_NUMBER_BUMP = parseOptionalBoolean(options.skipBuildNumberBump) ? 'true' : 'false'
    }
    else {
      log.info('ℹ️  --skip-build-number-bump not specified, build number will be auto-incremented (default)')
    }
    if (options.skipMarketingVersionBump !== undefined) {
      credentials.SKIP_MARKETING_VERSION_BUMP = parseOptionalBoolean(options.skipMarketingVersionBump) ? 'true' : 'false'
    }
    else {
      log.info('ℹ️  --skip-marketing-version-bump not specified, marketing version will be auto-bumped when already released (default)')
    }

    if (platform === 'ios') {
      // Handle iOS credentials
      if (options.certificate) {
        const certPath = resolve(options.certificate)
        if (!existsSync(certPath)) {
          log.error(`Certificate file not found: ${certPath}`)
          exit(1)
        }
        files.BUILD_CERTIFICATE_FILE = certPath
        log.info(`✓ Certificate file: ${certPath}`)
      }

      // Handle provisioning profiles via --ios-provisioning-profile (repeatable)
      if (options.iosProvisioningProfile && options.iosProvisioningProfile.length > 0) {
        try {
          const provMap = buildProvisioningMap(options.iosProvisioningProfile, cwd())
          credentials.CAPGO_IOS_PROVISIONING_MAP = JSON.stringify(provMap)
          const bundleIds = Object.keys(provMap)
          for (const bid of bundleIds) {
            log.info(`✓ Provisioning profile for ${bid}: ${provMap[bid].name}`)
          }

          // Best-effort warning about uncovered targets
          const pbxContent = readPbxproj(cwd())
          if (pbxContent) {
            const targets = findSignableTargets(pbxContent)
            const uncovered = targets.filter(t => !provMap[t.bundleId])
            if (uncovered.length > 0) {
              log.warn(`⚠️  The following signable targets have no provisioning profile:`)
              for (const t of uncovered) {
                log.warn(`     ${t.name} (${t.bundleId})`)
              }
              log.warn(`   Add more --ios-provisioning-profile entries if these targets need signing.`)
            }
          }
        }
        catch (error) {
          log.error(`Failed to process provisioning profiles: ${error instanceof Error ? error.message : String(error)}`)
          exit(1)
        }
      }

      if (options.appleKey) {
        const keyPath = resolve(options.appleKey)
        if (!existsSync(keyPath)) {
          log.error(`Apple key file not found: ${keyPath}`)
          exit(1)
        }
        files.APPLE_KEY_FILE = keyPath
        log.info(`✓ Apple key file: ${keyPath}`)
      }

      // Passwords and IDs (not files)
      if (options.p12Password) {
        credentials.P12_PASSWORD = options.p12Password
      }
      else if (files.BUILD_CERTIFICATE_FILE) {
        // Warn if certificate is provided but no password
        log.warn('⚠️  No P12 password provided - assuming certificate has no password')
        log.warn('   If your certificate requires a password, add --p12-password "your-password"')
      }
      if (options.appleKeyId)
        credentials.APPLE_KEY_ID = options.appleKeyId
      if (options.appleIssuerId)
        credentials.APPLE_ISSUER_ID = options.appleIssuerId
      if (options.appleTeamId)
        credentials.APP_STORE_CONNECT_TEAM_ID = options.appleTeamId
      // App-specific password upload (alternative to the App Store Connect API key)
      if (options.appleId)
        credentials.FASTLANE_USER = options.appleId
      if (options.appleAppSpecificPassword)
        credentials.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD = options.appleAppSpecificPassword
      if (options.appleAppId) {
        assertNumericAppleAppId(options.appleAppId)
        credentials.APPLE_APP_ID = options.appleAppId.trim()
      }
      if (options.iosDistribution) {
        credentials.CAPGO_IOS_DISTRIBUTION = options.iosDistribution
      }
      else {
        credentials.CAPGO_IOS_DISTRIBUTION = 'app_store'
        log.info('ℹ️  --ios-distribution not specified, defaulting to app_store (App Store + TestFlight)')
      }
    }
    else if (platform === 'android') {
      // Handle Android credentials
      if (options.keystore) {
        const keystorePath = resolve(options.keystore)
        if (!existsSync(keystorePath)) {
          log.error(`Keystore file not found: ${keystorePath}`)
          exit(1)
        }
        files.ANDROID_KEYSTORE_PATH = keystorePath
        log.info(`✓ Keystore file: ${keystorePath}`)
      }

      if (options.playConfig) {
        const configPath = resolve(options.playConfig)
        if (!existsSync(configPath)) {
          log.error(`Play config file not found: ${configPath}`)
          exit(1)
        }
        files.PLAY_CONFIG_JSON_PATH = configPath
        log.info(`✓ Play Store config: ${configPath}`)
      }

      // Passwords and aliases (not files)
      if (options.keystoreAlias)
        credentials.KEYSTORE_KEY_ALIAS = options.keystoreAlias

      // If only one password is provided, use it for both key and store
      const hasKeyPassword = !!options.keystoreKeyPassword
      const hasStorePassword = !!options.keystoreStorePassword

      if (hasKeyPassword && !hasStorePassword) {
        // Use key password for both
        credentials.KEYSTORE_KEY_PASSWORD = options.keystoreKeyPassword
        credentials.KEYSTORE_STORE_PASSWORD = options.keystoreKeyPassword
      }
      else if (!hasKeyPassword && hasStorePassword) {
        // Use store password for both
        credentials.KEYSTORE_KEY_PASSWORD = options.keystoreStorePassword
        credentials.KEYSTORE_STORE_PASSWORD = options.keystoreStorePassword
      }
      else if (hasKeyPassword && hasStorePassword) {
        // Both provided, use separately
        credentials.KEYSTORE_KEY_PASSWORD = options.keystoreKeyPassword
        credentials.KEYSTORE_STORE_PASSWORD = options.keystoreStorePassword
      }

      if (options.androidFlavor) {
        const trimmedFlavor = options.androidFlavor.trim()
        if (trimmedFlavor) {
          credentials.CAPGO_ANDROID_FLAVOR = trimmedFlavor
          log.info(`✓ Android flavor: ${trimmedFlavor}`)
        }
        else {
          log.warn('Ignoring whitespace-only --android-flavor value')
        }
      }
      else {
        log.info('ℹ️  --android-flavor not specified, no product flavor will be used')
      }

      if (options.inAppUpdatePriority !== undefined) {
        try {
          const priority = parseInAppUpdatePriority(options.inAppUpdatePriority)
          credentials.PLAY_STORE_IN_APP_UPDATE_PRIORITY = String(priority)
          log.info(`✓ In-app update priority: ${priority}`)
        }
        catch (error) {
          log.error(`❌ ${(error as Error).message}`)
          exit(1)
        }
      }
    }

    // Convert files to base64 and merge with other credentials
    const fileCredentials = await convertFilesToCredentials(platform, files, credentials)

    // Validate minimum required credentials for each platform
    const missingCreds: string[] = []

    if (platform === 'ios') {
      const rawDistributionMode = (fileCredentials.CAPGO_IOS_DISTRIBUTION || 'app_store') as string
      const validModes = ['app_store', 'ad_hoc']
      if (!validModes.includes(rawDistributionMode)) {
        log.error(`❌ Invalid --ios-distribution value: '${rawDistributionMode}'. Must be one of: ${validModes.join(', ')}`)
        exit(1)
      }
      const distributionMode = rawDistributionMode

      // iOS minimum requirements (all modes)
      if (!fileCredentials.BUILD_CERTIFICATE_BASE64)
        missingCreds.push('--certificate <path> (P12 certificate file)')
      if (!fileCredentials.CAPGO_IOS_PROVISIONING_MAP)
        missingCreds.push('--ios-provisioning-profile <path> (Provisioning profile file)')

      // Upload auth: app_store mode needs either an App Store Connect API key OR
      // an Apple ID + app-specific password (e.g. migrated Ionic Appflow apps).
      if (distributionMode === 'app_store') {
        const hasAppleApiKey = fileCredentials.APPLE_KEY_ID && fileCredentials.APPLE_ISSUER_ID && fileCredentials.APPLE_KEY_CONTENT
        const hasAppSpecificPassword = fileCredentials.FASTLANE_USER && fileCredentials.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD && fileCredentials.APPLE_APP_ID
        if (!hasAppleApiKey && !hasAppSpecificPassword) {
          if (fileCredentials.BUILD_OUTPUT_UPLOAD_ENABLED === 'false') {
            missingCreds.push('--apple-key/--apple-key-id/--apple-issuer-id (App Store Connect API key) OR --apple-id/--apple-app-specific-password/--apple-app-id (app-specific password) OR --output-upload (Build has no output destination - enable either TestFlight upload or Capgo download link)')
          }
          else {
            log.warn('⚠️  No App Store Connect API key or app-specific password provided - TestFlight auto-upload is disabled')
            log.warn('   When building without either, you must also set --skip-build-number-bump')
            log.warn('   To enable auto-upload, add either an API key (--apple-key ./AuthKey.p8 --apple-key-id KEY_ID --apple-issuer-id ISSUER_ID) or an app-specific password (--apple-id EMAIL --apple-app-specific-password PASSWORD --apple-app-id NUMERIC_ID)')
          }
        }
      }
      else if (distributionMode === 'ad_hoc') {
        log.info('📦 Ad-hoc distribution mode: App Store Connect API key not required')
      }

      if (!fileCredentials.APP_STORE_CONNECT_TEAM_ID)
        missingCreds.push('--apple-team-id <id> (App Store Connect Team ID)')
    }
    else if (platform === 'android') {
      // Android minimum requirements
      if (!fileCredentials.ANDROID_KEYSTORE_FILE)
        missingCreds.push('--keystore <path> (Keystore file)')
      if (!fileCredentials.KEYSTORE_KEY_ALIAS)
        missingCreds.push('--keystore-alias <alias> (Keystore alias)')

      // For Android, we need at least one password (will be used for both if only one provided)
      if (!fileCredentials.KEYSTORE_KEY_PASSWORD && !fileCredentials.KEYSTORE_STORE_PASSWORD)
        missingCreds.push('--keystore-key-password <password> OR --keystore-store-password <password> (At least one password required, will be used for both)')

      // Google Play Store credentials (optional - only needed for auto-upload to Play Store)
      if (!fileCredentials.PLAY_CONFIG_JSON) {
        if (fileCredentials.BUILD_OUTPUT_UPLOAD_ENABLED === 'false') {
          missingCreds.push('--play-config <path> OR --output-upload (Build has no output destination - enable either Play Store upload or Capgo download link)')
        }
        else {
          log.warn('⚠️  --play-config not provided - builds will succeed but cannot auto-upload to Play Store')
          log.warn('   To enable auto-upload, add: --play-config ./play-store-service-account.json')
        }
      }
    }

    if (missingCreds.length > 0) {
      log.error(`❌ Missing required credentials for ${platform.toUpperCase()}:`)
      log.error('')
      for (const cred of missingCreds) {
        log.error(`  • ${cred}`)
      }
      log.error('')
      log.error('Example:')
      if (platform === 'ios') {
        log.error('  npx @capgo/cli build credentials save --platform ios \\')
        log.error('    --certificate ./cert.p12 \\')
        log.error('    --p12-password "your-password" \\  # Optional if cert has no password')
        log.error('    --ios-provisioning-profile ./profile.mobileprovision \\')
        log.error('    --apple-team-id "XXXXXXXXXX" \\')
        log.error('    --output-upload')
        log.error('')
        log.error('  For multi-target apps (e.g., with extensions), repeat --ios-provisioning-profile:')
        log.error('    --ios-provisioning-profile ./App.mobileprovision \\')
        log.error('    --ios-provisioning-profile com.example.widget=./Widget.mobileprovision')
        log.error('')
        log.error('  Optionally replace --output-upload with --apple-key, --apple-key-id, --apple-issuer-id for TestFlight auto-upload.')
      }
      else {
        log.error('  npx @capgo/cli build credentials save --platform android \\')
        log.error('    --keystore ./release.keystore \\')
        log.error('    --keystore-alias "my-key-alias" \\')
        log.error('    --keystore-key-password "password"')
        log.error('')
        log.error('  Note: If both key and store passwords are the same, you only need to provide one.')
        log.error('        If they differ, provide both --keystore-key-password and --keystore-store-password.')
        log.error('        Optionally add --play-config for auto-uploading to Google Play Store.')
      }
      log.error('')
      exit(1)
    }

    // Save credentials for this specific app
    await updateSavedCredentials(appId, platform, fileCredentials, options.local)

    // When --android-flavor is omitted during save, remove any previously saved
    // flavor so it doesn't silently carry over to future builds.
    if (platform === 'android' && !options.androidFlavor) {
      await removeSavedCredentialKeys(appId, platform, ['CAPGO_ANDROID_FLAVOR'], options.local)
    }
    // Same semantics for --in-app-update-priority: re-saving without it clears the prior value.
    if (platform === 'android' && options.inAppUpdatePriority === undefined) {
      await removeSavedCredentialKeys(appId, platform, ['PLAY_STORE_IN_APP_UPDATE_PRIORITY'], options.local)
    }

    // Send analytics event
    try {
      const apikey = findSavedKey(true)
      if (apikey) {
        const supabase = await createSupabaseClient(apikey)
        const orgId = await getOrganizationId(supabase, appId)
        await sendEvent(apikey, {
          channel: 'credentials',
          event: 'Credentials saved',
          icon: '🔐',
          org_id: orgId,
          tracking_version: 2,
          tags: {
            'app-id': appId,
            'platform': platform,
            'storage': options.local ? 'local' : 'global',
          },
          notify: false,
        }).catch()
      }
    }
    catch {
      // Silently ignore analytics errors
    }

    const credentialsPath = options.local ? getLocalCredentialsPath() : getGlobalCredentialsPath()
    log.success(`\n✅ ${platform.toUpperCase()} credentials saved successfully for ${appId}!`)
    log.info(`   Location: ${credentialsPath}`)
    log.info(`   Use: npx @capgo/cli build ${appId} --platform ${platform}\n`)
  }
  catch (error) {
    log.error(`Failed to save credentials: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  }
}

/**
 * List saved credentials (masked for security)
 */
export async function listCredentialsCommand(options?: { appId?: string, local?: boolean }): Promise<void> {
  try {
    // If local flag is set, only show local credentials
    // Otherwise show both local and global
    const localAppIds = options?.local ? await listAllApps(true) : []
    const globalAppIds = options?.local ? [] : await listAllApps(false)
    const allAppIds = [...new Set([...localAppIds, ...globalAppIds])]

    if (allAppIds.length === 0) {
      log.info('No saved credentials found.')
      log.info('Use: npx @capgo/cli build credentials save --platform <ios|android>')
      return
    }

    log.info('\n📋 Saved Build Credentials:\n')

    // Try to infer appId from capacitor.config if not provided
    const extConfig = await getConfig()
    const inferredAppId = options?.appId || getAppId(undefined, extConfig?.config)

    // If specific appId is provided or inferred, only show that one
    const appsToShow = inferredAppId ? [inferredAppId] : allAppIds

    for (const appId of appsToShow) {
      const saved = await loadSavedCredentials(appId, options?.local)
      if (!saved)
        continue

      const isLocal = localAppIds.includes(appId)
      const locationLabel = isLocal ? ' (local)' : ' (global)'
      log.info(`\n🔹 App: ${appId}${locationLabel}`)

      if (saved.ios) {
        log.info('  iOS Credentials:')
        const ios = saved.ios
        if (ios.BUILD_CERTIFICATE_BASE64)
          log.info('    ✓ Certificate (base64)')
        if (ios.CAPGO_IOS_PROVISIONING_MAP) {
          try {
            const provMap = JSON.parse(ios.CAPGO_IOS_PROVISIONING_MAP) as Record<string, { name: string }>
            const bundleIds = Object.keys(provMap)
            log.info(`    ✓ Provisioning Map (${bundleIds.length} target${bundleIds.length === 1 ? '' : 's'}):`)
            for (const bid of bundleIds) {
              log.info(`      - ${bid}: ${provMap[bid].name}`)
            }
          }
          catch {
            log.info('    ✓ Provisioning Map (JSON)')
          }
        }
        if (ios.BUILD_PROVISION_PROFILE_BASE64)
          log.info('    ⚠️  Legacy Provisioning Profile (run "build credentials migrate" to update)')
        if (ios.APPLE_KEY_CONTENT)
          log.info('    ✓ Apple Key Content (base64)')
        if (ios.P12_PASSWORD)
          log.info('    ✓ P12 Password: ********')
        if (ios.APPLE_KEY_ID)
          log.info(`    ✓ Apple Key ID: ${ios.APPLE_KEY_ID}`)
        if (ios.APPLE_ISSUER_ID)
          log.info(`    ✓ Apple Issuer ID: ${ios.APPLE_ISSUER_ID}`)
        if (ios.APP_STORE_CONNECT_TEAM_ID)
          log.info(`    ✓ Team ID: ${ios.APP_STORE_CONNECT_TEAM_ID}`)
        if (ios.FASTLANE_USER)
          log.info(`    ✓ Apple ID (app-specific password): ${ios.FASTLANE_USER}`)
        if (ios.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD)
          log.info('    ✓ App-Specific Password: ********')
        if (ios.APPLE_APP_ID)
          log.info(`    ✓ App Store Connect App ID: ${ios.APPLE_APP_ID}`)
        if (ios.CAPGO_IOS_DISTRIBUTION)
          log.info(`    ✓ Distribution Mode: ${ios.CAPGO_IOS_DISTRIBUTION}`)
      }

      if (saved.android) {
        log.info('  Android Credentials:')
        const android = saved.android
        if (android.ANDROID_KEYSTORE_FILE)
          log.info('    ✓ Keystore (base64)')
        if (android.PLAY_CONFIG_JSON)
          log.info('    ✓ Play Store Config (base64)')
        if (android.KEYSTORE_KEY_ALIAS)
          log.info(`    ✓ Keystore Alias: ${android.KEYSTORE_KEY_ALIAS}`)
        if (android.KEYSTORE_KEY_PASSWORD)
          log.info('    ✓ Key Password: ********')
        if (android.KEYSTORE_STORE_PASSWORD)
          log.info('    ✓ Store Password: ********')
        if (android.PLAY_STORE_IN_APP_UPDATE_PRIORITY)
          log.info(`    ✓ In-app Update Priority: ${android.PLAY_STORE_IN_APP_UPDATE_PRIORITY}`)
      }
    }

    log.info(`\nGlobal: ${getGlobalCredentialsPath()}`)
    log.info(`Local:  ${getLocalCredentialsPath()}`)
    log.info('\n🔒 These credentials are stored locally on your machine only.')
    log.info('   When building, they are sent to Capgo but NEVER stored there.\n')

    void trackEvent({ channel: 'credentials', event: 'Credentials Listed', icon: '📋', tags: { credentials_count: appsToShow.length } })
  }
  catch (error) {
    log.error(`Failed to list credentials: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  }
}

/**
 * Clear saved credentials
 */
export async function clearCredentialsCommand(options: { appId?: string, platform?: 'ios' | 'android', local?: boolean }): Promise<void> {
  try {
    // Try to infer appId from capacitor.config if not explicitly provided
    const extConfig = await getConfig()
    const appId = options.appId || getAppId(undefined, extConfig?.config)
    const credentialsPath = options.local ? getLocalCredentialsPath() : getGlobalCredentialsPath()

    if (appId && options.platform) {
      // Clear specific platform for specific app
      const current = await getSavedCredentials(appId, options.platform, options.local)
      if (!current) {
        log.info(`No ${options.platform.toUpperCase()} credentials found for ${appId}.`)
        return
      }

      await clearSavedCredentials(appId, options.platform, options.local)
      log.success(`✅ ${options.platform.toUpperCase()} credentials cleared for ${appId}!`)
    }
    else if (appId) {
      // Clear all platforms for specific app
      const saved = await loadSavedCredentials(appId, options.local)
      if (!saved || (!saved.ios && !saved.android)) {
        log.info(`No credentials found for ${appId}.`)
        return
      }

      await clearSavedCredentials(appId, undefined, options.local)
      log.success(`✅ All credentials cleared for ${appId}!`)
    }
    else {
      // Clear everything (no appId provided or inferred)
      const appIds = await listAllApps(options.local)
      if (appIds.length === 0) {
        log.info('No saved credentials found.')
        return
      }

      await clearSavedCredentials(undefined, undefined, options.local)
      log.success('✅ All credentials cleared!')
    }

    log.info(`   Location: ${credentialsPath}\n`)

    void trackEvent({ channel: 'credentials', event: 'Credentials Cleared', icon: '🧹', tags: {} })
  }
  catch (error) {
    log.error(`Failed to clear credentials: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  }
}

/**
 * Update existing credentials (partial update, no full validation)
 * Use this to update specific credentials without providing all of them again
 */
export async function updateCredentialsCommand(options: SaveCredentialsOptions): Promise<void> {
  try {
    // Detect platform from provided options if not explicitly set
    const hasIosOptions = !!(options.certificate || (options.iosProvisioningProfile && options.iosProvisioningProfile.length > 0)
      || options.p12Password || options.appleKey || options.appleKeyId || options.appleIssuerId
      || options.appleTeamId || options.appleId || options.appleAppSpecificPassword || options.appleAppId)
    const hasAndroidOptions = !!(options.keystore || options.keystoreAlias || options.keystoreKeyPassword
      || options.keystoreStorePassword || options.playConfig || options.androidFlavor || options.inAppUpdatePriority !== undefined)
    const hasCrossPlatformOptions = options.outputUpload !== undefined || options.outputRetention !== undefined || options.skipBuildNumberBump !== undefined || options.skipMarketingVersionBump !== undefined

    let platform = options.platform
    if (!platform) {
      if (hasIosOptions && !hasAndroidOptions) {
        platform = 'ios'
      }
      else if (hasAndroidOptions && !hasIosOptions) {
        platform = 'android'
      }
      else if (hasIosOptions && hasAndroidOptions) {
        log.error('Cannot mix iOS and Android options. Please use --platform to specify which platform.')
        exit(1)
      }
      else if (hasCrossPlatformOptions) {
        log.error('These options require --platform to be set (ios or android).')
        exit(1)
      }
      else {
        log.error('No credentials provided to update.')
        log.error('')
        log.error('Usage: npx @capgo/cli build credentials update [options]')
        log.error('')
        log.error('iOS options: --certificate, --provisioning-profile, --apple-key, etc.')
        log.error('Android options: --keystore, --keystore-alias, --play-config, etc.')
        exit(1)
      }
    }

    // Try to infer appId from capacitor.config if not provided
    const extConfig = await getConfig()
    const appId = getAppId(options.appId, extConfig?.config)

    if (!appId) {
      log.error('❌ App ID is required.')
      log.error('')
      log.error('Either:')
      log.error('  1. Run this command from a Capacitor project directory, OR')
      log.error('  2. Provide --appId explicitly: --appId com.example.app')
      exit(1)
    }

    // Check if credentials exist for this app/platform
    const existing = await getSavedCredentials(appId, platform, options.local)
    if (!existing) {
      log.error(`❌ No existing ${platform.toUpperCase()} credentials found for ${appId}.`)
      log.error('')
      log.error('Use "build credentials save" to create credentials first.')
      exit(1)
    }

    const credentials: Partial<BuildCredentials> = {}
    const files: any = {}

    if (options.outputUpload !== undefined) {
      const outputUploadEnabled = parseOptionalBoolean(options.outputUpload)
      credentials.BUILD_OUTPUT_UPLOAD_ENABLED = outputUploadEnabled ? 'true' : 'false'
    }

    if (options.outputRetention) {
      const outputRetentionSeconds = parseOutputRetentionSeconds(options.outputRetention)
      credentials.BUILD_OUTPUT_RETENTION_SECONDS = String(outputRetentionSeconds)
    }

    if (options.skipBuildNumberBump !== undefined) {
      credentials.SKIP_BUILD_NUMBER_BUMP = parseOptionalBoolean(options.skipBuildNumberBump) ? 'true' : 'false'
    }
    if (options.skipMarketingVersionBump !== undefined) {
      credentials.SKIP_MARKETING_VERSION_BUMP = parseOptionalBoolean(options.skipMarketingVersionBump) ? 'true' : 'false'
    }

    if (platform === 'ios') {
      // Handle iOS credentials
      if (options.certificate) {
        const certPath = resolve(options.certificate)
        if (!existsSync(certPath)) {
          log.error(`Certificate file not found: ${certPath}`)
          exit(1)
        }
        files.BUILD_CERTIFICATE_FILE = certPath
        log.info(`✓ Updating certificate: ${certPath}`)
      }

      // Handle provisioning profiles via --ios-provisioning-profile (repeatable)
      if (options.iosProvisioningProfile && options.iosProvisioningProfile.length > 0) {
        try {
          const newEntries = buildProvisioningMap(options.iosProvisioningProfile, cwd())

          let mergedMap: Record<string, ProvisioningMapEntry>
          if (options.overwriteIosProvisioningMap) {
            mergedMap = newEntries
          }
          else {
            // Merge into existing map (additive)
            let existingMap: Record<string, ProvisioningMapEntry> = {}
            if (existing.CAPGO_IOS_PROVISIONING_MAP) {
              try {
                existingMap = JSON.parse(existing.CAPGO_IOS_PROVISIONING_MAP) as Record<string, ProvisioningMapEntry>
              }
              catch {
                // Invalid existing JSON — start fresh
              }
            }
            mergedMap = { ...existingMap, ...newEntries }
          }

          credentials.CAPGO_IOS_PROVISIONING_MAP = JSON.stringify(mergedMap)
          const newBundleIds = Object.keys(newEntries)
          for (const bid of newBundleIds) {
            log.info(`✓ Updating provisioning profile for ${bid}: ${newEntries[bid].name}`)
          }
        }
        catch (error) {
          log.error(`Failed to process provisioning profiles: ${error instanceof Error ? error.message : String(error)}`)
          exit(1)
        }
      }

      if (options.appleKey) {
        const keyPath = resolve(options.appleKey)
        if (!existsSync(keyPath)) {
          log.error(`Apple key file not found: ${keyPath}`)
          exit(1)
        }
        files.APPLE_KEY_FILE = keyPath
        log.info(`✓ Updating Apple key file: ${keyPath}`)
      }

      // Passwords and IDs (not files)
      if (options.p12Password) {
        credentials.P12_PASSWORD = options.p12Password
        log.info('✓ Updating P12 password')
      }
      if (options.appleKeyId) {
        credentials.APPLE_KEY_ID = options.appleKeyId
        log.info(`✓ Updating Apple Key ID: ${options.appleKeyId}`)
      }
      if (options.appleIssuerId) {
        credentials.APPLE_ISSUER_ID = options.appleIssuerId
        log.info(`✓ Updating Apple Issuer ID: ${options.appleIssuerId}`)
      }
      if (options.appleTeamId) {
        credentials.APP_STORE_CONNECT_TEAM_ID = options.appleTeamId
        log.info(`✓ Updating Apple Team ID: ${options.appleTeamId}`)
      }
      // App-specific password upload (alternative to the App Store Connect API key)
      if (options.appleId) {
        credentials.FASTLANE_USER = options.appleId
        log.info(`✓ Updating Apple ID: ${options.appleId}`)
      }
      if (options.appleAppSpecificPassword) {
        credentials.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD = options.appleAppSpecificPassword
        log.info('✓ Updating app-specific password')
      }
      if (options.appleAppId) {
        assertNumericAppleAppId(options.appleAppId)
        credentials.APPLE_APP_ID = options.appleAppId.trim()
        log.info(`✓ Updating App Store Connect App ID: ${options.appleAppId}`)
      }
      if (options.iosDistribution) {
        credentials.CAPGO_IOS_DISTRIBUTION = options.iosDistribution
        log.info(`✓ Updating iOS distribution mode: ${options.iosDistribution}`)
      }
    }
    else if (platform === 'android') {
      // Handle Android credentials
      if (options.keystore) {
        const keystorePath = resolve(options.keystore)
        if (!existsSync(keystorePath)) {
          log.error(`Keystore file not found: ${keystorePath}`)
          exit(1)
        }
        files.ANDROID_KEYSTORE_PATH = keystorePath
        log.info(`✓ Updating keystore: ${keystorePath}`)
      }

      if (options.playConfig) {
        const configPath = resolve(options.playConfig)
        if (!existsSync(configPath)) {
          log.error(`Play config file not found: ${configPath}`)
          exit(1)
        }
        files.PLAY_CONFIG_JSON_PATH = configPath
        log.info(`✓ Updating Play Store config: ${configPath}`)
      }

      // Passwords and aliases (not files)
      if (options.keystoreAlias) {
        credentials.KEYSTORE_KEY_ALIAS = options.keystoreAlias
        log.info(`✓ Updating keystore alias: ${options.keystoreAlias}`)
      }
      if (options.keystoreKeyPassword) {
        credentials.KEYSTORE_KEY_PASSWORD = options.keystoreKeyPassword
        log.info('✓ Updating keystore key password')
      }
      if (options.keystoreStorePassword) {
        credentials.KEYSTORE_STORE_PASSWORD = options.keystoreStorePassword
        log.info('✓ Updating keystore store password')
      }
      // Note: unlike `save` (which clears CAPGO_ANDROID_FLAVOR when --android-flavor
      // is omitted), `update` intentionally leaves it untouched — partial-update
      // semantics mean "only change what I explicitly pass."
      if (options.androidFlavor) {
        const trimmedFlavor = options.androidFlavor.trim()
        if (trimmedFlavor) {
          credentials.CAPGO_ANDROID_FLAVOR = trimmedFlavor
          log.info(`✓ Updating Android flavor: ${trimmedFlavor}`)
        }
        else {
          log.warn('Ignoring whitespace-only --android-flavor value')
        }
      }
      if (options.inAppUpdatePriority !== undefined) {
        try {
          const priority = parseInAppUpdatePriority(options.inAppUpdatePriority)
          credentials.PLAY_STORE_IN_APP_UPDATE_PRIORITY = String(priority)
          log.info(`✓ Updating in-app update priority: ${priority}`)
        }
        catch (error) {
          log.error(`❌ ${(error as Error).message}`)
          exit(1)
        }
      }
    }

    // Convert files to base64 and merge with other credentials
    const fileCredentials = await convertFilesToCredentials(platform, files, credentials)

    // Update credentials (merge with existing)
    await updateSavedCredentials(appId, platform, fileCredentials, options.local)

    const credentialsPath = options.local ? getLocalCredentialsPath() : getGlobalCredentialsPath()
    log.success(`\n✅ ${platform.toUpperCase()} credentials updated for ${appId}!`)
    log.info(`   Location: ${credentialsPath}\n`)

    void trackEvent({ channel: 'credentials', event: 'Credentials Updated', icon: '✏️', tags: {} })
  }
  catch (error) {
    log.error(`Failed to update credentials: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  }
}

/**
 * Build a migration map from a single legacy base64 provisioning profile.
 *
 * Takes the legacy BUILD_PROVISION_PROFILE_BASE64 value and a bundle ID,
 * extracts the profile name, and returns a JSON-serialized provisioning map.
 */
export function buildMigrationMap(profileBase64: string, bundleId: string): string {
  const info = parseMobileprovisionFromBase64(profileBase64)
  const map: Record<string, ProvisioningMapEntry> = {
    [bundleId]: {
      profile: profileBase64,
      name: info.name,
    },
  }
  return JSON.stringify(map)
}

/**
 * Migrate legacy provisioning profile credentials to the new map format.
 *
 * Reads saved credentials, finds the legacy BUILD_PROVISION_PROFILE_BASE64,
 * discovers the main bundle ID from the local pbxproj, synthesizes the map,
 * saves it, and removes old keys.
 */
export async function migrateCredentialsCommand(options: { appId?: string, platform?: string, local?: boolean }): Promise<void> {
  try {
    if (options.platform && options.platform !== 'ios') {
      log.error('Migration is only needed for iOS credentials.')
      exit(1)
    }

    // Try to infer appId from capacitor.config if not provided
    const extConfig = await getConfig()
    const appId = getAppId(options.appId, extConfig?.config)

    if (!appId) {
      log.error('❌ App ID is required.')
      log.error('')
      log.error('Either:')
      log.error('  1. Run this command from a Capacitor project directory, OR')
      log.error('  2. Provide --appId explicitly: --appId com.example.app')
      exit(1)
    }

    // Load existing credentials
    const saved = await getSavedCredentials(appId, 'ios', options.local)
    if (!saved) {
      log.error(`❌ No iOS credentials found for ${appId}.`)
      log.error('   Nothing to migrate.')
      exit(1)
    }

    // Check for legacy format
    if (!saved.BUILD_PROVISION_PROFILE_BASE64) {
      if (saved.CAPGO_IOS_PROVISIONING_MAP) {
        log.info('✅ Credentials are already in the new provisioning map format. No migration needed.')
        return
      }
      log.error('❌ No provisioning profile found in saved credentials. Nothing to migrate.')
      exit(1)
    }

    if (saved.CAPGO_IOS_PROVISIONING_MAP) {
      log.info('✅ Credentials already have a provisioning map. No migration needed.')
      return
    }

    // Discover main bundle ID from local pbxproj
    let mainBundleId: string | undefined
    const pbxContent = readPbxproj(cwd())
    if (pbxContent) {
      const targets = findSignableTargets(pbxContent)
      const mainTarget = targets.find(t => t.productType === 'com.apple.product-type.application')
      if (mainTarget) {
        mainBundleId = mainTarget.bundleId
        log.info(`Discovered main target: ${mainTarget.name} (${mainTarget.bundleId})`)
      }
    }

    if (!mainBundleId) {
      // Try to infer from the profile itself
      try {
        const info = parseMobileprovisionFromBase64(saved.BUILD_PROVISION_PROFILE_BASE64)
        mainBundleId = info.bundleId
        log.info(`Using bundle ID from provisioning profile: ${mainBundleId}`)
      }
      catch {
        log.error('❌ Could not determine bundle ID from pbxproj or provisioning profile.')
        log.error('   Please run this command from a Capacitor project directory with an Xcode project.')
        exit(1)
      }
    }

    // Build the provisioning map
    const mapJson = buildMigrationMap(saved.BUILD_PROVISION_PROFILE_BASE64, mainBundleId!)
    const provMap = JSON.parse(mapJson)

    // Save updated credentials: add map, remove old keys
    const updates: Partial<BuildCredentials> = {
      CAPGO_IOS_PROVISIONING_MAP: mapJson,
    }

    await updateSavedCredentials(appId, 'ios', updates, options.local)

    // Remove legacy keys that are superseded by CAPGO_IOS_PROVISIONING_MAP
    const legacyKeys = ['BUILD_PROVISION_PROFILE_BASE64', 'APPLE_PROFILE_NAME']
    await removeSavedCredentialKeys(appId, 'ios', legacyKeys, options.local)

    const bundleIds = Object.keys(provMap)
    log.success(`\n✅ Migration complete for ${appId}!`)
    log.info(`   Provisioning map created with ${bundleIds.length} target${bundleIds.length === 1 ? '' : 's'}:`)
    for (const bid of bundleIds) {
      log.info(`     - ${bid}: ${provMap[bid].name}`)
    }

    // Warn about extension targets
    if (pbxContent) {
      const targets = findSignableTargets(pbxContent)
      const extensions = targets.filter(t => t.productType !== 'com.apple.product-type.application')
      if (extensions.length > 0) {
        log.warn('')
        log.warn('⚠️  Your project has extension targets that are not covered by this migration:')
        for (const ext of extensions) {
          log.warn(`     ${ext.name} (${ext.bundleId})`)
        }
        log.warn('')
        log.warn('   To add provisioning profiles for extensions, run:')
        log.warn('     npx @capgo/cli build credentials update --platform ios \\')
        log.warn('       --ios-provisioning-profile bundleId=path.mobileprovision')
      }
    }

    log.info('')

    void trackEvent({ channel: 'credentials', event: 'Credentials Migrated', icon: '🔀', tags: {} })
  }
  catch (error) {
    log.error(`Failed to migrate credentials: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  }
}
