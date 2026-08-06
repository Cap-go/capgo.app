import type { BuildCredentials, SavedCredentials } from '../schemas/build'
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cwd, exit } from 'node:process'
import {
  cancel as pCancel,
  confirm as pConfirm,
  intro as pIntro,
  isCancel as pIsCancel,
  log as pLog,
  outro as pOutro,
  select as pSelect,
  text as pText,
} from '../init/prompts'
import { clearInitLogs, setInitScreen, stopInitInkSession } from '../init/runtime'
import { trackEvent } from '../analytics/track'
import { getAppId, getConfig } from '../utils'
import {
  clearSavedCredentials,
  getGlobalCredentialsPath,
  getLocalCredentialsPath,
  listAllApps,
  loadSavedCredentials,
  removeSavedCredentialKeys,
  updateSavedCredentials,
} from './credentials'
import { escapeDotenvValue, renderEnvFile } from './env-render'
import { onboardingBuilderCommand } from './onboarding/command'
import { canUseFilePicker, openSaveFilePicker } from './onboarding/file-picker'
import { copyToClipboard } from '../support/clipboard'

interface ManageCredentialsOptions {
  appId?: string
  platform?: 'ios' | 'android'
  local?: boolean
}

interface AppEntry {
  appId: string
  local: boolean
  platforms: Array<'ios' | 'android'>
  saved: SavedCredentials
}

const SECRET_KEYS = new Set([
  'P12_PASSWORD',
  'APPLE_KEY_CONTENT',
  'BUILD_CERTIFICATE_BASE64',
  'BUILD_PROVISION_PROFILE_BASE64',
  'KEYSTORE_KEY_PASSWORD',
  'KEYSTORE_STORE_PASSWORD',
  'ANDROID_KEYSTORE_FILE',
  'PLAY_CONFIG_JSON',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
  'FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD',
])

type FieldScope = 'ios' | 'android' | 'shared'
type FieldType = 'string' | 'boolean' | 'duration' | 'base64' | 'json' | 'enum'
type FieldCategory = 'credential' | 'configuration'

interface FieldKnowledge {
  scope: FieldScope
  type: FieldType
  /**
   * `credential` = signing/auth material (certs, passwords, API keys) — added
   * via the platform onboarding wizard, not the manage UI's "Add" flow.
   * `configuration` = behaviour knobs (booleans, enums, durations, simple
   * strings) — addable through "Add credential → Add configuration option".
   */
  category: FieldCategory
  enumValues?: string[]
  explain: string
}

// Authoritative descriptions sourced from the Capgo wiki (concepts/code-signing,
// concepts/cli-native-builds, concepts/android-keystore-handling). Keep these
// in sync if the wiki changes.
const CREDENTIAL_KNOWLEDGE: Record<string, FieldKnowledge> = {
  // iOS
  BUILD_CERTIFICATE_BASE64: {
    scope: 'ios',
    type: 'base64',
    category: 'credential',
    explain: 'Base64-encoded .p12 distribution certificate. The .p12 contains the iOS Distribution certificate + private key that signs your app. Sent to Capgo build workers per build, then deleted.',
  },
  P12_PASSWORD: {
    scope: 'ios',
    type: 'string',
    category: 'credential',
    explain: 'Password for the .p12 certificate file. Can be empty if the .p12 was exported without one. Stored locally; never leaves your machine permanently.',
  },
  APPLE_KEY_ID: {
    scope: 'ios',
    type: 'string',
    category: 'credential',
    explain: 'App Store Connect API key ID (10-char alphanumeric). Used to upload signed builds to TestFlight/App Store. Find it in App Store Connect → Users and Access → Keys. Optional for ad_hoc distribution.',
  },
  APPLE_ISSUER_ID: {
    scope: 'ios',
    type: 'string',
    category: 'credential',
    explain: 'App Store Connect API issuer ID (UUID). Pairs with APPLE_KEY_ID and APPLE_KEY_CONTENT to authenticate uploads. Found alongside the key ID in App Store Connect. Optional for ad_hoc distribution.',
  },
  APPLE_KEY_CONTENT: {
    scope: 'ios',
    type: 'base64',
    category: 'credential',
    explain: 'Base64-encoded contents of the .p8 App Store Connect API private key. Needed to upload to TestFlight/App Store. Capgo uses it server-side per build then discards it.',
  },
  APP_STORE_CONNECT_TEAM_ID: {
    scope: 'ios',
    type: 'string',
    category: 'credential',
    explain: 'Apple Developer team ID (10-char alphanumeric). Found at developer.apple.com → Membership. Used by xcodebuild to scope the signing context.',
  },
  FASTLANE_USER: {
    scope: 'ios',
    type: 'string',
    category: 'credential',
    explain: 'Not recommended: app-specific password authentication is a discouraged Ionic Appflow migration fallback; prefer an App Store Connect API key (.p8). This is the Apple ID email for app-specific password uploads. Pairs with FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD and APPLE_APP_ID; fastlane reads it from the environment automatically.',
  },
  FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: {
    scope: 'ios',
    type: 'string',
    category: 'credential',
    explain: 'Not recommended: prefer an App Store Connect API key (.p8); this app-specific password path exists only as an Ionic Appflow migration fallback. App-specific password (format xxxx-xxxx-xxxx-xxxx) generated at appleid.apple.com. Lets fastlane upload to TestFlight without an App Store Connect API key. Requires FASTLANE_USER and APPLE_APP_ID to also be set. Capgo uses it server-side per build then discards it.',
  },
  APPLE_APP_ID: {
    scope: 'ios',
    type: 'string',
    category: 'credential',
    explain: 'Numeric App Store Connect app id (e.g. 1234567890), found in App Store Connect → your app → App Information → Apple ID. Required for the (not recommended) app-specific password upload path so fastlane can upload without an interactive 2FA login. Not used when an App Store Connect API key (.p8) is configured, which is the preferred option.',
  },
  CAPGO_IOS_PROVISIONING_MAP: {
    scope: 'ios',
    type: 'json',
    category: 'credential',
    explain: 'JSON map of bundle IDs → { profile (base64 .mobileprovision), name }. Supports apps with multiple signable targets (main app + widget + notification service extension, etc.). Replaces the legacy single-profile BUILD_PROVISION_PROFILE_BASE64 — run `build credentials migrate` to convert.',
  },
  CAPGO_IOS_DISTRIBUTION: {
    scope: 'ios',
    type: 'enum',
    category: 'configuration',
    enumValues: ['app_store', 'ad_hoc'],
    explain: 'iOS distribution mode. `app_store` (default) exports for TestFlight/App Store and validates the App Store Connect API key. `ad_hoc` exports for direct device distribution and skips the API-key validation — useful for QA, internal builds, and device-specific testing.',
  },
  CAPGO_IOS_SCHEME: {
    scope: 'ios',
    type: 'string',
    category: 'configuration',
    explain: 'Xcode scheme name to build. Auto-detected from the .xcodeproj if there is only one shared scheme; required when multiple schemes exist.',
  },
  CAPGO_IOS_TARGET: {
    scope: 'ios',
    type: 'string',
    category: 'configuration',
    explain: 'Xcode target name. Auto-detected from the project; override only if your project has unusual target naming and the build picks the wrong one.',
  },
  BUILD_PROVISION_PROFILE_BASE64: {
    scope: 'ios',
    type: 'base64',
    category: 'credential',
    explain: 'LEGACY single-profile format. Use `build credentials migrate --platform ios` to convert this into the multi-target CAPGO_IOS_PROVISIONING_MAP. Builds will fail with this key still present.',
  },

  // Android
  ANDROID_KEYSTORE_FILE: {
    scope: 'android',
    type: 'base64',
    category: 'credential',
    explain: 'Base64-encoded .keystore / .jks / .p12 file used to sign your Android APK/AAB. Losing this means losing the ability to update your Play Store listing forever — keep a backup.',
  },
  KEYSTORE_KEY_ALIAS: {
    scope: 'android',
    type: 'string',
    category: 'credential',
    explain: 'Alias name of the key inside the keystore. PKCS#12 keystores expose readable aliases; JKS keystores often need this entered manually. The CLI wizard auto-detects aliases when possible.',
  },
  KEYSTORE_KEY_PASSWORD: {
    scope: 'android',
    type: 'string',
    category: 'credential',
    explain: 'Password protecting the individual key inside the keystore. In ~99% of keystores it equals KEYSTORE_STORE_PASSWORD; the CLI defaults to that when only one is provided.',
  },
  KEYSTORE_STORE_PASSWORD: {
    scope: 'android',
    type: 'string',
    category: 'credential',
    explain: 'Password protecting the keystore file as a whole. Asked first by the wizard; defaults the key password to the same value.',
  },
  PLAY_CONFIG_JSON: {
    scope: 'android',
    type: 'base64',
    category: 'credential',
    explain: 'Base64-encoded Google Play service-account JSON key. Authenticates uploads to Play Console via the Android Publisher API. Capgo provisions one for you via the OAuth onboarding (creates a GCP project + service account + invites it into your Play Console).',
  },
  GOOGLE_OAUTH_REFRESH_TOKEN: {
    scope: 'android',
    type: 'string',
    category: 'credential',
    explain: 'Long-lived OAuth refresh token from the Google sign-in step of `build init --platform android`. Lets the CLI re-mint short-lived access tokens for Play Console operations without re-prompting. Capgo never stores it server-side.',
  },
  CAPGO_ANDROID_FLAVOR: {
    scope: 'android',
    type: 'string',
    category: 'configuration',
    explain: 'Gradle product flavor to build (e.g. `production`, `staging`). Required when your `app/build.gradle` defines multiple flavors; ignored if empty.',
  },

  // Shared
  BUILD_OUTPUT_UPLOAD_ENABLED: {
    scope: 'shared',
    type: 'boolean',
    category: 'configuration',
    explain: 'When true, the build worker uploads the resulting IPA/APK/AAB to Capgo storage and emits a time-limited download link (and a QR code). Independent of store upload: you can enable this with --no-playstore-upload to get only the AAB download when the Play app does not exist yet. When false, Capgo skips the download link and the artifact only goes to the app store (if store credentials are set).',
  },
  BUILD_OUTPUT_RETENTION_SECONDS: {
    scope: 'shared',
    type: 'duration',
    category: 'configuration',
    explain: 'How long the BUILD_OUTPUT_UPLOAD download link stays valid. Range: 1h (3600) to 7d (604800). Stored as seconds. The CLI accepts shorthand like 6h, 2d on save.',
  },
  SKIP_BUILD_NUMBER_BUMP: {
    scope: 'shared',
    type: 'boolean',
    category: 'configuration',
    explain: 'When true, the builder uses the version code/build number already in your project files instead of auto-incrementing. Useful when you manage versions manually or via your own CI script.',
  },
}

function getFieldKnowledge(key: string): FieldKnowledge | undefined {
  return CREDENTIAL_KNOWLEDGE[key]
}

interface FieldRow {
  key: string
  value: string
  sourcePlatforms: Array<'ios' | 'android'>
  /** Short tag shown as a prefix in the picker label, e.g. `ios`, `android`, `SHARED`, `SHARED·ios`. */
  tag: string
  knowledge?: FieldKnowledge
}

function gatherFieldRows(entry: AppEntry): FieldRow[] {
  const ios = entry.saved.ios ?? {}
  const android = entry.saved.android ?? {}
  const allKeys = new Set<string>([
    ...Object.keys(ios).filter(key => typeof ios[key as keyof typeof ios] === 'string' && (ios[key as keyof typeof ios] as string).length > 0),
    ...Object.keys(android).filter(key => typeof android[key as keyof typeof android] === 'string' && (android[key as keyof typeof android] as string).length > 0),
  ])

  const rows: FieldRow[] = []

  for (const key of allKeys) {
    const knowledge = getFieldKnowledge(key)
    const iosValue = typeof ios[key as keyof typeof ios] === 'string' ? (ios[key as keyof typeof ios] as string) : undefined
    const androidValue = typeof android[key as keyof typeof android] === 'string' ? (android[key as keyof typeof android] as string) : undefined
    const declaredScope = knowledge?.scope ?? inferScope(key)

    if (declaredScope === 'shared') {
      if (iosValue !== undefined && androidValue !== undefined) {
        if (iosValue === androidValue) {
          rows.push({ key, value: iosValue, sourcePlatforms: ['ios', 'android'], tag: 'SHARED', knowledge })
        }
        else {
          // Drift between platforms — surface both rows so the user can resolve.
          rows.push({ key, value: iosValue, sourcePlatforms: ['ios'], tag: 'SHARED·ios', knowledge })
          rows.push({ key, value: androidValue, sourcePlatforms: ['android'], tag: 'SHARED·android', knowledge })
        }
      }
      else if (iosValue !== undefined) {
        rows.push({ key, value: iosValue, sourcePlatforms: ['ios'], tag: 'SHARED·ios', knowledge })
      }
      else if (androidValue !== undefined) {
        rows.push({ key, value: androidValue, sourcePlatforms: ['android'], tag: 'SHARED·android', knowledge })
      }
    }
    else if (declaredScope === 'ios' && iosValue !== undefined) {
      rows.push({ key, value: iosValue, sourcePlatforms: ['ios'], tag: 'ios', knowledge })
    }
    else if (declaredScope === 'android' && androidValue !== undefined) {
      rows.push({ key, value: androidValue, sourcePlatforms: ['android'], tag: 'android', knowledge })
    }
    else {
      // Field declared on one platform but stored on the other — surface as the platform that has it.
      if (iosValue !== undefined)
        rows.push({ key, value: iosValue, sourcePlatforms: ['ios'], tag: 'ios', knowledge })
      if (androidValue !== undefined)
        rows.push({ key, value: androidValue, sourcePlatforms: ['android'], tag: 'android', knowledge })
    }
  }

  // Order: SHARED first, then ios, then android. Within each, alphabetical.
  return rows.sort((a, b) => {
    const orderA = tagOrder(a.tag)
    const orderB = tagOrder(b.tag)
    if (orderA !== orderB)
      return orderA - orderB
    return a.key.localeCompare(b.key)
  })
}

function inferScope(key: string): FieldScope {
  if (key.startsWith('APPLE_') || key.startsWith('FASTLANE_') || key.startsWith('CAPGO_IOS_') || key.startsWith('BUILD_CERTIFICATE') || key === 'P12_PASSWORD' || key === 'APP_STORE_CONNECT_TEAM_ID' || key === 'BUILD_PROVISION_PROFILE_BASE64')
    return 'ios'
  if (key.startsWith('KEYSTORE_') || key.startsWith('ANDROID_') || key.startsWith('PLAY_') || key.startsWith('CAPGO_ANDROID_') || key.startsWith('GOOGLE_'))
    return 'android'
  return 'shared'
}

function tagOrder(tag: string): number {
  if (tag === 'SHARED')
    return 0
  if (tag.startsWith('SHARED'))
    return 1
  if (tag === 'ios')
    return 2
  return 3
}

function refreshedPlatforms(saved: SavedCredentials): Array<'ios' | 'android'> {
  const platforms: Array<'ios' | 'android'> = []
  if (saved.ios && hasAnyValue(saved.ios))
    platforms.push('ios')
  if (saved.android && hasAnyValue(saved.android))
    platforms.push('android')
  return platforms
}

/**
 * Narrow an entry to a single platform: drops the other platform's saved data
 * from the working copy so the flat inspector, exporter, deleter, and Add
 * flows all see the entry as if it only had `platform` configured. Returns
 * null when the platform isn't actually configured on this entry.
 *
 * On-disk credentials are NOT touched — this is purely a view filter for the
 * scoped session.
 */
function narrowEntryToPlatform(entry: AppEntry, platform: 'ios' | 'android'): AppEntry | null {
  const platformSaved = entry.saved[platform]
  if (!platformSaved || !hasAnyValue(platformSaved))
    return null
  return {
    ...entry,
    saved: { [platform]: platformSaved } as SavedCredentials,
    platforms: [platform],
  }
}

function applyPlatformFilter(entries: AppEntry[], platform: 'ios' | 'android' | undefined): AppEntry[] {
  if (!platform)
    return entries
  return entries
    .map(entry => narrowEntryToPlatform(entry, platform))
    .filter((entry): entry is AppEntry => entry !== null)
}

export async function manageCredentialsCommand(options: ManageCredentialsOptions = {}): Promise<void> {
  pIntro('Capgo build credentials manager')

  // Validate the --platform flag before doing anything expensive. The
  // CLI option string is untyped at the commander layer, so reject any value
  // that isn't one of the two supported platforms.
  if (options.platform !== undefined && options.platform !== 'ios' && options.platform !== 'android') {
    pCancel(`--platform must be "ios" or "android" (got "${String(options.platform)}").`)
    return
  }
  const scopedPlatform = options.platform

  try {
    let entries = await loadEntries(options.local)
    if (entries.length === 0) {
      pCancel('No saved build credentials found. Run `capgo build credentials save` first.')
      return
    }

    const targetAppId = options.appId ?? (await detectAppIdFromCapacitor(entries))
    let detectedFromCapacitor = false
    if (targetAppId) {
      const filtered = entries.filter(entry => entry.appId === targetAppId)
      if (filtered.length === 0 && options.appId) {
        pCancel(`No credentials found for app ${options.appId}.`)
        return
      }
      if (filtered.length > 0) {
        detectedFromCapacitor = !options.appId
        entries = filtered
      }
    }

    // Honour --platform: narrow every entry to just the requested platform.
    // Entries that don't have that platform configured drop out of the list.
    if (scopedPlatform) {
      entries = applyPlatformFilter(entries, scopedPlatform)
      if (entries.length === 0) {
        pCancel(`No ${scopedPlatform} credentials found${options.appId ? ` for ${options.appId}` : ''}.`)
        return
      }
    }

    let currentEntry = entries.length === 1 ? entries[0] : undefined

    let oneShotIntro: string[] | undefined
    if (detectedFromCapacitor && targetAppId)
      oneShotIntro = [`✨ Detected app from capacitor.config: ${targetAppId}`]

    let handedOffToOnboarding = false

    while (true) {
      if (!currentEntry) {
        const picked = await pickEntry(entries, oneShotIntro)
        oneShotIntro = undefined
        if (pIsCancel(picked))
          break
        currentEntry = picked
      }

      const canGoBack = entries.length > 1
      const action = await pickAction(currentEntry, canGoBack, oneShotIntro)
      oneShotIntro = undefined
      if (pIsCancel(action))
        break

      if (action === 'view') {
        const result = await inspectAppCredentials(currentEntry)
        if (result.mutated) {
          const refreshed = await loadSavedCredentials(currentEntry.appId, currentEntry.local)
          if (!refreshed || (!hasAnyValue(refreshed.ios ?? {}) && !hasAnyValue(refreshed.android ?? {}))) {
            entries = await loadEntries(options.local)
            if (options.appId)
              entries = entries.filter(entry => entry.appId === options.appId)
            entries = applyPlatformFilter(entries, scopedPlatform)
            if (entries.length === 0) {
              pOutro('All credentials cleared.')
              return
            }
            currentEntry = entries.length === 1 ? entries[0] : undefined
            continue
          }
          let nextEntry: AppEntry = {
            ...currentEntry,
            saved: refreshed,
            platforms: refreshedPlatforms(refreshed),
          }
          if (scopedPlatform) {
            const narrowed = narrowEntryToPlatform(nextEntry, scopedPlatform)
            if (!narrowed) {
              pOutro(`All ${scopedPlatform} credentials cleared.`)
              return
            }
            nextEntry = narrowed
          }
          currentEntry = nextEntry
        }
      }
      else if (action === 'add') {
        const result = await handleAddCredential(currentEntry)
        if (result.handoff) {
          handedOffToOnboarding = true
          break
        }
        if (result.mutated) {
          const refreshed = await loadSavedCredentials(currentEntry.appId, currentEntry.local)
          if (refreshed) {
            let nextEntry: AppEntry = {
              ...currentEntry,
              saved: refreshed,
              platforms: refreshedPlatforms(refreshed),
            }
            if (scopedPlatform) {
              const narrowed = narrowEntryToPlatform(nextEntry, scopedPlatform)
              if (narrowed)
                nextEntry = narrowed
            }
            currentEntry = nextEntry
          }
        }
      }
      else if (action === 'export') {
        const exported = await exportToEnvFile(currentEntry)
        if (!exported)
          pLog.warn('Export cancelled.')
      }
      else if (action === 'delete') {
        const deleted = await deletePlatformInteractive(currentEntry)
        if (deleted) {
          entries = await loadEntries(options.local)
          if (options.appId)
            entries = entries.filter(entry => entry.appId === options.appId)
          entries = applyPlatformFilter(entries, scopedPlatform)
          if (entries.length === 0) {
            pOutro('All credentials cleared.')
            return
          }
          currentEntry = entries.length === 1 ? entries[0] : undefined
          continue
        }
      }
      else if (action === 'back') {
        if (entries.length === 1)
          break
        currentEntry = undefined
        continue
      }
      else if (action === 'quit') {
        break
      }
    }

    if (!handedOffToOnboarding) {
      pOutro('Done.')
      void trackEvent({ channel: 'credentials', event: 'Credentials Managed', icon: '🗂️', tags: {} })
    }
  }
  catch (error) {
    pCancel(`Failed: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  }
}

interface ManagerScreenOptions {
  title: string
  introLines?: string[]
  statusLine?: string
  stepLabel?: string
  stepSummary?: string
}

function setManagerScreen(options: ManagerScreenOptions): void {
  setInitScreen({
    headerTitle: '🔐  Capgo Build Credentials',
    title: options.title,
    introLines: options.introLines,
    statusLine: options.statusLine,
    stepLabel: options.stepLabel,
    stepSummary: options.stepSummary,
    tone: 'cyan',
  })
}

function summarizePlatformContent(creds: Partial<BuildCredentials> | undefined): string {
  if (!creds || !hasAnyValue(creds))
    return 'no credentials'
  const total = Object.values(creds).filter(v => typeof v === 'string' && v.length > 0).length
  const secrets = Object.entries(creds).filter(([key, value]) => SECRET_KEYS.has(key) && typeof value === 'string' && value.length > 0).length
  const parts: string[] = [`${total} field${total === 1 ? '' : 's'}`]
  if (secrets > 0)
    parts.push(`${secrets} secret${secrets === 1 ? '' : 's'}`)
  return parts.join(', ')
}

function describeFieldRow(row: FieldRow): string[] {
  const lines: string[] = []
  lines.push(`Source: ${row.tag} → writes to ${row.sourcePlatforms.join(' + ')}`)
  lines.push(`${row.value.length} chars stored`)
  if (SECRET_KEYS.has(row.key))
    lines.push('marked as secret (hidden by default)')
  if (canDecodeBase64(row.key, row.value))
    lines.push('decode-eligible (base64 → JSON / text)')
  if (row.knowledge?.type === 'boolean')
    lines.push('boolean field — Edit will offer true / false')
  if (row.knowledge?.type === 'enum' && row.knowledge.enumValues)
    lines.push(`enum field — Edit will offer: ${row.knowledge.enumValues.join(' / ')}`)
  if (row.knowledge?.type === 'duration')
    lines.push('duration field — accepts 1h, 6h, 2d (1h–7d range)')
  if (row.key === 'CAPGO_IOS_PROVISIONING_MAP')
    lines.push(summarizeProvisioningMap(row.value))
  if (row.key.endsWith('_ID'))
    lines.push('identifier (not secret — visible in Apple/Google portals)')
  return lines
}

async function detectAppIdFromCapacitor(entries: AppEntry[]): Promise<string | undefined> {
  if (entries.length === 0)
    return undefined
  try {
    const extConfig = await getConfig()
    const inferred = getAppId(undefined, extConfig?.config)
    return inferred || undefined
  }
  catch {
    return undefined
  }
}

async function loadEntries(localOnly?: boolean): Promise<AppEntry[]> {
  const entries: AppEntry[] = []
  const scopes: Array<{ local: boolean }> = localOnly ? [{ local: true }] : [{ local: false }, { local: true }]

  for (const scope of scopes) {
    const appIds = await listAllApps(scope.local)
    for (const appId of appIds) {
      const saved = await loadSavedCredentials(appId, scope.local)
      if (!saved)
        continue
      const platforms: Array<'ios' | 'android'> = []
      if (saved.ios && hasAnyValue(saved.ios))
        platforms.push('ios')
      if (saved.android && hasAnyValue(saved.android))
        platforms.push('android')
      if (platforms.length === 0)
        continue
      entries.push({ appId, local: scope.local, platforms, saved })
    }
  }

  return entries
}

function hasAnyValue(creds: Partial<BuildCredentials>): boolean {
  return Object.values(creds).some(value => typeof value === 'string' && value.length > 0)
}

async function pickEntry(entries: AppEntry[], extraIntro?: string[]): Promise<AppEntry | symbol> {
  setManagerScreen({
    title: 'Pick an app',
    introLines: [
      ...(extraIntro ?? []),
      ...(extraIntro ? [''] : []),
      `${entries.length} app${entries.length === 1 ? '' : 's'} have saved credentials.`,
      `Global store: ${getGlobalCredentialsPath()}`,
      `Local store:  ${getLocalCredentialsPath()}`,
    ],
    statusLine: 'Use ↑/↓ then Enter to choose. Ctrl+C to quit.',
  })
  const result = await pSelect({
    message: 'Pick an app',
    options: entries.map((entry, index) => ({
      value: String(index),
      label: `${entry.appId} (${entry.local ? 'local' : 'global'})`,
      hint: entry.platforms.join(' + '),
    })),
  })
  if (pIsCancel(result))
    return result
  return entries[Number.parseInt(result, 10)]
}

async function pickAction(entry: AppEntry, canGoBack: boolean, extraIntro?: string[]): Promise<string | symbol> {
  const platformsLine = entry.platforms.length === 0
    ? 'no platforms configured'
    : entry.platforms.map(p => `${p === 'ios' ? 'iOS' : 'Android'}: ${summarizePlatformContent(entry.saved[p])}`).join('   ·   ')

  setManagerScreen({
    title: `${entry.appId} · credentials`,
    introLines: [
      ...(extraIntro ?? []),
      ...(extraIntro ? [''] : []),
      `Source: ${entry.local ? 'local' : 'global'} store`,
      platformsLine,
      '',
      'View    — flat list of every credential across platforms (show, decode, copy, edit, explain, remove).',
      'Add…    — add a new platform via onboarding, or add a configuration option.',
      'Export  — write a .env file ready for CI/CD secrets (combined across platforms; pass --platform to scope to one).',
      'Delete  — wipe all credentials for one platform (asks which if both are configured).',
    ],
    statusLine: canGoBack ? 'Esc = back, Ctrl+C = quit.' : 'Ctrl+C or Esc to quit.',
  })
  const options = [
    { value: 'view', label: 'View credentials', hint: 'inspect, decode, copy, edit, explain, remove' },
    { value: 'add', label: 'Add credential…', hint: 'add platform support or a configuration option' },
    { value: 'export', label: 'Export to .env', hint: 'CI/CD-ready file' },
    { value: 'delete', label: 'Delete', hint: 'remove a platform from storage' },
    ...(canGoBack ? [{ value: 'back', label: 'Back', hint: 'previous picker' }] : []),
    { value: 'quit', label: 'Quit' },
  ]
  return pSelect({
    message: `${entry.appId} (${entry.local ? 'local' : 'global'})`,
    options,
  })
}

interface InspectResult {
  mutated: boolean
}

async function inspectAppCredentials(entry: AppEntry): Promise<InspectResult> {
  let mutated = false
  let workingEntry = entry

  while (true) {
    const fresh = await loadSavedCredentials(workingEntry.appId, workingEntry.local)
    if (!fresh || (!hasAnyValue(fresh.ios ?? {}) && !hasAnyValue(fresh.android ?? {}))) {
      pLog.info(`No credentials remain for ${workingEntry.appId}.`)
      return { mutated }
    }
    workingEntry = { ...workingEntry, saved: fresh, platforms: refreshedPlatforms(fresh) }

    const rows = gatherFieldRows(workingEntry)
    if (rows.length === 0) {
      pLog.info(`No credential fields stored for ${workingEntry.appId}.`)
      return { mutated }
    }

    const pickedIndex = await pickFieldRow(workingEntry, rows)
    if (pIsCancel(pickedIndex))
      return { mutated }

    const row = rows[Number.parseInt(pickedIndex, 10)]
    if (!row)
      continue

    const action = await pickFieldAction(row)
    if (pIsCancel(action) || action === 'back')
      continue

    if (action === 'show') {
      actionShowField(row)
    }
    else if (action === 'decode') {
      actionDecodeField(row)
    }
    else if (action === 'copy') {
      actionCopyField(row)
    }
    else if (action === 'explain') {
      actionExplainField(row)
    }
    else if (action === 'edit') {
      const edited = await actionEditField(workingEntry, row)
      if (edited)
        mutated = true
    }
    else if (action === 'remove') {
      const removed = await actionRemoveField(workingEntry, row)
      if (removed)
        mutated = true
    }
  }
}

async function pickFieldRow(entry: AppEntry, rows: FieldRow[]): Promise<string | symbol> {
  const secretCount = rows.filter(row => SECRET_KEYS.has(row.key)).length
  const decodableCount = rows.filter(row => canDecodeBase64(row.key, row.value)).length
  const explainableCount = rows.filter(row => row.knowledge).length

  setManagerScreen({
    title: `${entry.appId} · credentials`,
    introLines: [
      `${rows.length} field${rows.length === 1 ? '' : 's'} stored — ${secretCount} secret${secretCount === 1 ? '' : 's'}, ${decodableCount} decode-eligible, ${explainableCount} with wiki explanations.`,
      `Source: ${entry.local ? 'local' : 'global'} store.`,
      `Tags: [SHARED] = same value on both platforms · [SHARED·ios] / [SHARED·android] = stored on one only · [ios] / [android] = platform-specific.`,
      '',
      'Per-field actions: Show / Decode / Copy / Edit / Explain / Remove.',
      'Esc returns to the action menu without changes.',
    ],
    statusLine: 'Tip: secrets show **** until you choose Show or Copy.',
  })

  const options = rows.map((row, index) => ({
    value: String(index),
    label: `[${row.tag}] ${row.key}`,
    hint: previewValue(row.key, row.value),
  }))
  return pSelect({
    message: `${entry.appId} (${entry.local ? 'local' : 'global'}) — credentials`,
    options,
  })
}

async function pickFieldAction(row: FieldRow): Promise<string | symbol> {
  const decodable = canDecodeBase64(row.key, row.value)
  const explainable = row.knowledge !== undefined
  const editLabel = pickEditLabel(row)

  // Clear any prior action's output so the user lands on a fresh canvas for
  // this field — previous Show/Decode dumps would otherwise stack visually.
  clearInitLogs()

  setManagerScreen({
    title: `Action · [${row.tag}] ${row.key}`,
    introLines: describeFieldRow(row),
    statusLine: 'Esc returns to the field list. Ctrl+C quits the manager.',
  })

  const options = [
    { value: 'show', label: 'Show value', hint: 'print the raw stored value' },
    ...(decodable ? [{ value: 'decode', label: 'Decode (base64 → readable)', hint: 'JSON pretty-print or text preview' }] : []),
    { value: 'copy', label: 'Copy to clipboard', hint: 'pbcopy / xclip / wl-copy' },
    { value: 'edit', label: editLabel.label, hint: editLabel.hint },
    ...(explainable ? [{ value: 'explain', label: 'Explain', hint: 'what this field is and how Capgo uses it' }] : []),
    { value: 'remove', label: 'Remove this field', hint: row.sourcePlatforms.length > 1 ? 'delete from both platforms' : `delete from ${row.sourcePlatforms[0]}` },
    { value: 'back', label: 'Back' },
  ]
  return pSelect({ message: `Action for ${row.key}`, options })
}

function pickEditLabel(row: FieldRow): { label: string, hint: string } {
  const fieldType = row.knowledge?.type
  if (fieldType === 'boolean')
    return { label: 'Edit', hint: 'pick true or false' }
  if (fieldType === 'enum')
    return { label: 'Edit', hint: `pick from: ${row.knowledge?.enumValues?.join(' / ') ?? ''}` }
  if (fieldType === 'duration')
    return { label: 'Edit', hint: 'enter a duration like 1h, 6h, 2d (1h–7d)' }
  return { label: 'Edit', hint: 'opens a temp file in your editor of choice' }
}

function previewValue(key: string, value: string): string {
  if (SECRET_KEYS.has(key))
    return `**** (${value.length} chars)`
  if (key === 'CAPGO_IOS_PROVISIONING_MAP')
    return summarizeProvisioningMap(value)
  if (value.length > 60)
    return `${value.slice(0, 40)}… (${value.length} chars)`
  return value
}

function canDecodeBase64(key: string, value: string): boolean {
  if (key === 'CAPGO_IOS_PROVISIONING_MAP')
    return false
  if (key.endsWith('_BASE64'))
    return true
  if (key === 'APPLE_KEY_CONTENT' || key === 'ANDROID_KEYSTORE_FILE' || key === 'PLAY_CONFIG_JSON')
    return true
  // Heuristic fallback: long string that matches base64 alphabet
  if (value.length >= 32 && /^[A-Z0-9+/=\s]+$/i.test(value))
    return true
  return false
}

function actionShowField(row: FieldRow): void {
  pLog.info(`──── [${row.tag}] ${row.key} (${row.value.length} chars) ────`)
  pLog.info(row.value)
  pLog.success(`✓ Showed ${row.key}.`)
}

// JSON object keys whose values must never be printed by the Decode action.
// Covers service-account JSON (private_key, private_key_id), generic OAuth /
// API patterns (client_secret, api_key, access_token, refresh_token), and the
// catch-all "secret" / "password". Match is case-insensitive.
const SENSITIVE_JSON_KEYS = new Set<string>([
  'private_key',
  'private_key_id',
  'client_secret',
  'api_key',
  'apikey',
  'secret',
  'password',
  'access_token',
  'refresh_token',
])

interface RedactedJson {
  value: unknown
  redactedKeys: string[]
}

function redactSensitiveJson(input: unknown): RedactedJson {
  const redactedKeys: string[] = []
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map(walk)
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        if (SENSITIVE_JSON_KEYS.has(key.toLowerCase())) {
          redactedKeys.push(key)
          result[key] = '[REDACTED]'
        }
        else {
          result[key] = walk(child)
        }
      }
      return result
    }
    return value
  }
  return { value: walk(input), redactedKeys }
}

function actionDecodeField(row: FieldRow): void {
  let decoded: Buffer
  try {
    decoded = Buffer.from(row.value, 'base64')
  }
  catch (error) {
    pLog.error(`✗ Could not decode ${row.key}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const text = decoded.toString('utf-8')
  try {
    const parsed: unknown = JSON.parse(text)
    const { value: redacted, redactedKeys } = redactSensitiveJson(parsed)
    const tagSuffix = redactedKeys.length > 0 ? `, ${redactedKeys.length} sensitive key${redactedKeys.length === 1 ? '' : 's'} redacted` : ''
    pLog.info(`──── [${row.tag}] ${row.key} (decoded JSON, ${decoded.length} bytes${tagSuffix}) ────`)
    pLog.info(JSON.stringify(redacted, null, 2))
    if (redactedKeys.length > 0)
      pLog.warn(`Redacted: ${redactedKeys.join(', ')}. Use "Show value" to view the raw base64.`)
    pLog.success(`✓ Decoded ${row.key} as JSON (${decoded.length} bytes → ${text.length} chars).`)
    return
  }
  catch {
    // Not JSON, try printable text next.
  }

  const printable = isPrintableText(text)
  if (printable) {
    pLog.info(`──── [${row.tag}] ${row.key} (decoded text, ${decoded.length} bytes) ────`)
    const preview = text.length > 500 ? `${text.slice(0, 500)}\n… truncated (${text.length} bytes total)` : text
    pLog.info(preview)
    pLog.success(`✓ Decoded ${row.key} as text.`)
    return
  }

  pLog.info(`✓ ${row.key} decodes to ${decoded.length} bytes of binary data (not displayed — likely a certificate or keystore).`)
}

function actionExplainField(row: FieldRow): void {
  const knowledge = row.knowledge
  if (!knowledge) {
    pLog.warn(`No wiki entry found for ${row.key}.`)
    return
  }
  pLog.info(`──── [${row.tag}] ${row.key} — explanation ────`)
  pLog.info(knowledge.explain)
  if (knowledge.type === 'enum' && knowledge.enumValues)
    pLog.info(`Allowed values: ${knowledge.enumValues.join(', ')}`)
  pLog.success(`✓ Explained ${row.key}.`)
}

function isPrintableText(text: string): boolean {
  if (text.length === 0)
    return false
  let printable = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 0x09 || code === 0x0A || code === 0x0D || (code >= 0x20 && code <= 0x7E))
      printable += 1
  }
  return printable / text.length >= 0.95
}

function actionCopyField(row: FieldRow): void {
  const result = copyToClipboard(row.value)
  if (result.ok)
    pLog.success(`✓ Copied ${row.key} (${row.value.length} chars) to clipboard via ${result.method}.`)
  else
    pLog.warn(`✗ Clipboard not available — could not copy ${row.key}. Use "Show value" and copy manually.`)
}

async function actionEditField(entry: AppEntry, row: FieldRow): Promise<boolean> {
  const fieldType = row.knowledge?.type
  if (fieldType === 'boolean')
    return editBooleanField(entry, row)
  if (fieldType === 'enum')
    return editEnumField(entry, row)
  if (fieldType === 'duration')
    return editDurationField(entry, row)
  return editTextField(entry, row)
}

async function editBooleanField(entry: AppEntry, row: FieldRow): Promise<boolean> {
  const current = parseBooleanValue(row.value)
  const picked = await pSelect<'true' | 'false'>({
    message: `Set ${row.key} (currently ${current ?? row.value})`,
    options: [
      { value: 'true', label: 'true', hint: current === true ? 'current value' : '' },
      { value: 'false', label: 'false', hint: current === false ? 'current value' : '' },
    ],
  })
  if (pIsCancel(picked))
    return false

  if (picked === row.value) {
    pLog.info('No changes detected.')
    return false
  }

  await writeFieldToSourcePlatforms(entry, row, picked)
  pLog.success(`✓ Updated ${row.key} → ${picked} on ${row.sourcePlatforms.join(' + ')}.`)
  return true
}

async function editEnumField(entry: AppEntry, row: FieldRow): Promise<boolean> {
  const enumValues = row.knowledge?.enumValues ?? []
  if (enumValues.length === 0) {
    pLog.error(`Enum field ${row.key} has no allowed values configured.`)
    return false
  }
  const picked = await pSelect<string>({
    message: `Set ${row.key} (currently ${row.value})`,
    options: enumValues.map(v => ({ value: v, label: v, hint: v === row.value ? 'current value' : '' })),
  })
  if (pIsCancel(picked))
    return false
  if (picked === row.value) {
    pLog.info('No changes detected.')
    return false
  }
  await writeFieldToSourcePlatforms(entry, row, picked)
  pLog.success(`✓ Updated ${row.key} → ${picked} on ${row.sourcePlatforms.join(' + ')}.`)
  return true
}

async function editDurationField(entry: AppEntry, row: FieldRow): Promise<boolean> {
  const currentSeconds = Number.parseInt(row.value, 10)
  const placeholder = Number.isFinite(currentSeconds) ? `${currentSeconds}s (e.g. 1h, 6h, 2d)` : '1h, 6h, 2d (1h–7d)'
  const entered = await pText({
    message: `New duration for ${row.key}`,
    placeholder,
    validate: (value) => {
      if (!value || value.trim().length === 0)
        return 'Required'
      try {
        parseOutputRetentionLocal(value)
      }
      catch (error) {
        return error instanceof Error ? error.message : 'Invalid duration'
      }
      return undefined
    },
  })
  if (pIsCancel(entered))
    return false

  const newSeconds = parseOutputRetentionLocal(entered)
  const newValue = String(newSeconds)
  if (newValue === row.value) {
    pLog.info('No changes detected.')
    return false
  }
  await writeFieldToSourcePlatforms(entry, row, newValue)
  pLog.success(`✓ Updated ${row.key} → ${newValue}s on ${row.sourcePlatforms.join(' + ')}.`)
  return true
}

async function editTextField(entry: AppEntry, row: FieldRow): Promise<boolean> {
  const ext = looksLikeJson(row.value) ? 'json' : 'txt'
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const tmpPath = join(tmpdir(), `capgo-${token}-${sanitizeForFilename(row.key)}.${ext}`)

  await writeFile(tmpPath, row.value, { mode: 0o600 })

  pLog.info('\nA temp file has been created with the current value:')
  pLog.info(`  ${tmpPath}`)
  pLog.info('Open it in your editor of choice, save your changes, then confirm below.')

  try {
    const done = await pConfirm({
      message: 'Done editing? (Yes = read & save, No = discard changes)',
      initialValue: true,
    })
    if (pIsCancel(done) || !done) {
      pLog.warn('Edit cancelled — no changes saved.')
      return false
    }

    let updated: string
    try {
      updated = readFileSync(tmpPath, 'utf-8')
    }
    catch (error) {
      pLog.error(`Could not read temp file: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }

    if (updated === row.value) {
      pLog.info('No changes detected.')
      return false
    }

    if (row.key === 'CAPGO_IOS_PROVISIONING_MAP') {
      try {
        JSON.parse(updated)
      }
      catch (error) {
        pLog.error(`Invalid JSON — keeping previous value. Error: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }

    await writeFieldToSourcePlatforms(entry, row, updated)
    pLog.success(`✓ Updated ${row.key} on ${row.sourcePlatforms.join(' + ')} — ${row.value.length} → ${updated.length} chars.`)
    return true
  }
  finally {
    try {
      unlinkSync(tmpPath)
    }
    catch {
      // Best-effort cleanup; ignore errors.
    }
  }
}

async function writeFieldToSourcePlatforms(entry: AppEntry, row: FieldRow, newValue: string): Promise<void> {
  for (const platform of row.sourcePlatforms)
    await updateSavedCredentials(entry.appId, platform, { [row.key]: newValue }, entry.local)
}

function parseBooleanValue(value: string): boolean | undefined {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes')
    return true
  if (trimmed === 'false' || trimmed === '0' || trimmed === 'no')
    return false
  return undefined
}

function parseOutputRetentionLocal(raw: string): number {
  // Local copy of the CLI's parser to avoid an import cycle with credentials-command.
  const trimmed = raw.trim()
  const match = trimmed.match(/^(\d+)\s*([smhd])?$/i)
  if (!match)
    throw new Error('Use a number with unit s, m, h, or d (e.g. 1h, 6h, 2d)')
  const value = Number.parseInt(match[1]!, 10)
  const unit = (match[2] || 's').toLowerCase() as 's' | 'm' | 'h' | 'd'
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400
  const seconds = value * multiplier
  if (seconds < 3600)
    throw new Error('Minimum is 1h (3600s)')
  if (seconds > 7 * 86400)
    throw new Error('Maximum is 7d (604800s)')
  return seconds
}

async function actionRemoveField(entry: AppEntry, row: FieldRow): Promise<boolean> {
  const confirmed = await pConfirm({
    message: `Remove ${row.key} from ${entry.appId} (${row.sourcePlatforms.join(' + ')})?`,
    initialValue: false,
  })
  if (pIsCancel(confirmed) || !confirmed)
    return false

  for (const platform of row.sourcePlatforms)
    await removeSavedCredentialKeys(entry.appId, platform, [row.key], entry.local)

  pLog.success(`✓ Removed ${row.key} from ${entry.appId} (${row.sourcePlatforms.join(' + ')}).`)
  return true
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^\w-]/g, '_').slice(0, 40)
}

function summarizeProvisioningMap(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, { name?: string }>
    const bundleIds = Object.keys(parsed)
    const lines = bundleIds.map((id) => {
      const name = parsed[id]?.name ?? '(unnamed)'
      return `${id} → ${name}`
    })
    return `${bundleIds.length} target${bundleIds.length === 1 ? '' : 's'}: ${lines.join(', ')}`
  }
  catch {
    return `(JSON, ${raw.length} chars)`
  }
}

async function exportToEnvFile(entry: AppEntry): Promise<boolean> {
  if (entry.platforms.length === 0) {
    pLog.warn('Nothing to export — no platforms configured for this app.')
    return false
  }

  // When both platforms are in scope, write a single combined .env file. iOS and
  // Android env-var names are disjoint, so combining them avoids forcing the user
  // to run `gh secret set -f` (or equivalent) once per platform. Callers that
  // want a single platform's file pass `--platform ios` (or android) at the
  // manage command, which narrows the entry to one platform upstream.
  if (entry.platforms.length > 1)
    return exportCombinedEnvFile(entry)

  const platform = entry.platforms[0]
  const creds = entry.saved[platform]
  if (!creds || !hasAnyValue(creds)) {
    pLog.warn('Nothing to export.')
    return false
  }

  const defaultName = `.env.capgo.${entry.appId}.${platform}`
  const target = await resolveExportTarget(entry, platform, defaultName)
  if (target === null) {
    pLog.info('✗ Export cancelled.')
    return false
  }

  const content = renderEnvFile({ appId: entry.appId, local: entry.local, platform, creds })
  await writeFile(target.path, content, { mode: 0o600 })
  // Node's writeFile mode option only applies when the file is newly created;
  // an overwrite leaves the existing permission bits untouched. Force 0o600
  // explicitly so a pre-existing 0644/0660 file is tightened down to match
  // the success message — credentials must not be world- or group-readable.
  await chmod(target.path, 0o600)

  const fieldCount = Object.values(creds).filter(v => typeof v === 'string' && v.length > 0).length
  pLog.success(`✓ Exported ${fieldCount} field${fieldCount === 1 ? '' : 's'} → ${target.path} (mode 0600).`)
  pLog.info('Add it to .gitignore — never commit this file.')
  pLog.info('Reference: https://capgo.app/docs/cli/cloud-build/')
  return true
}

async function exportCombinedEnvFile(entry: AppEntry): Promise<boolean> {
  const sections: Array<{ platform: 'ios' | 'android', creds: Partial<BuildCredentials> }> = []
  for (const platform of entry.platforms) {
    const creds = entry.saved[platform]
    if (creds && hasAnyValue(creds))
      sections.push({ platform, creds })
  }

  if (sections.length === 0) {
    pLog.warn('Nothing to export.')
    return false
  }

  // If only one of the listed platforms actually has values, fall back to the
  // per-platform file name so the user isn't surprised by a generic name.
  if (sections.length === 1) {
    const { platform, creds } = sections[0]
    const defaultName = `.env.capgo.${entry.appId}.${platform}`
    const target = await resolveExportTarget(entry, platform, defaultName)
    if (target === null) {
      pLog.info('✗ Export cancelled.')
      return false
    }
    const content = renderEnvFile({ appId: entry.appId, local: entry.local, platform, creds })
    await writeFile(target.path, content, { mode: 0o600 })
    await chmod(target.path, 0o600)
    const fieldCount = Object.values(creds).filter(v => typeof v === 'string' && v.length > 0).length
    pLog.success(`✓ Exported ${fieldCount} field${fieldCount === 1 ? '' : 's'} → ${target.path} (mode 0600).`)
    pLog.info('Add it to .gitignore — never commit this file.')
    pLog.info('Reference: https://capgo.app/docs/cli/cloud-build/')
    return true
  }

  // The manager allows the same key to be stored under both platforms (the View
  // screen tags these as [SHARED]), and the stored values can drift. When the
  // combined file gets ingested by `gh secret set -f`, shell sourcing, or any
  // other dotenv consumer, the LAST occurrence wins — so a drifted key silently
  // produces wrong CI behaviour for at least one platform. Detect and surface.
  const conflicts = findCombinedExportConflicts(sections)
  if (conflicts.length > 0) {
    pLog.warn(`⚠️  ${conflicts.length} key${conflicts.length === 1 ? '' : 's'} differ across platforms — dotenv ingestion keeps only the LAST value per key, so at least one platform will get the wrong setting:`)
    for (const { key, occurrences } of conflicts) {
      const summary = occurrences.map(o => `${o.platform}=${maskConflictValue(o.value)}`).join(', ')
      pLog.warn(`  • ${key}: ${summary}`)
    }
    pLog.info('Fix: cancel and re-export per-platform (`--platform ios`, then `--platform android`), or reconcile the values in the View screen first.')

    const proceed = await pConfirm({
      message: 'Write the combined file anyway?',
      initialValue: false,
    })
    if (pIsCancel(proceed) || !proceed) {
      pLog.info('✗ Export cancelled.')
      return false
    }
  }

  const defaultName = `.env.capgo.${entry.appId}`
  const target = await resolveExportTarget(entry, 'combined', defaultName)
  if (target === null) {
    pLog.info('✗ Export cancelled.')
    return false
  }

  const content = renderEnvFileCombined(entry, sections, conflicts)
  await writeFile(target.path, content, { mode: 0o600 })
  await chmod(target.path, 0o600)

  const totalFields = sections.reduce(
    (sum, { creds }) => sum + Object.values(creds).filter(v => typeof v === 'string' && v.length > 0).length,
    0,
  )
  const platformList = sections.map(s => s.platform).join(' + ')
  pLog.success(`✓ Exported ${totalFields} fields (${platformList}) → ${target.path} (mode 0600).`)
  pLog.info('Add it to .gitignore — never commit this file.')
  pLog.info('Reference: https://capgo.app/docs/cli/cloud-build/')
  return true
}

interface CombinedKeyConflict {
  key: string
  occurrences: Array<{ platform: 'ios' | 'android', value: string }>
}

function findCombinedExportConflicts(
  sections: Array<{ platform: 'ios' | 'android', creds: Partial<BuildCredentials> }>,
): CombinedKeyConflict[] {
  if (sections.length < 2)
    return []
  const occurrencesByKey = new Map<string, Array<{ platform: 'ios' | 'android', value: string }>>()
  for (const { platform, creds } of sections) {
    for (const [key, value] of Object.entries(creds)) {
      if (typeof value !== 'string' || value.length === 0)
        continue
      const list = occurrencesByKey.get(key) ?? []
      list.push({ platform, value })
      occurrencesByKey.set(key, list)
    }
  }
  const conflicts: CombinedKeyConflict[] = []
  for (const [key, occurrences] of occurrencesByKey) {
    if (occurrences.length < 2)
      continue
    const distinctValues = new Set(occurrences.map(o => o.value))
    if (distinctValues.size > 1)
      conflicts.push({ key, occurrences })
  }
  return conflicts
}

// Conflicting values are usually short config toggles (booleans, retention
// strings) where the actual value is what the user needs to see to decide.
// Mask anything long enough to plausibly be a secret instead.
function maskConflictValue(value: string): string {
  return value.length <= 32 ? value : `(${value.length} chars)`
}

async function resolvePlatformChoice(entry: AppEntry, message: string): Promise<'ios' | 'android' | null> {
  if (entry.platforms.length === 1)
    return entry.platforms[0]
  const picked = await pSelect<'ios' | 'android'>({
    message,
    options: entry.platforms.map(p => ({
      value: p,
      label: p === 'ios' ? 'iOS' : 'Android',
      hint: summarizePlatformContent(entry.saved[p]),
    })),
  })
  if (pIsCancel(picked))
    return null
  return picked
}

interface ExportTarget {
  path: string
}

async function resolveExportTarget(entry: AppEntry, label: 'ios' | 'android' | 'combined', defaultName: string): Promise<ExportTarget | null> {
  if (canUseFilePicker()) {
    const picked = await openSaveFilePicker({
      prompt: `Save Capgo .env for ${entry.appId} (${label})`,
      defaultName,
      defaultLocation: cwd(),
    })
    if (picked === null)
      return null
    // macOS save dialog already asked for overwrite confirmation if needed.
    return { path: picked }
  }

  const pickedPath = await pText({
    message: 'Output file',
    placeholder: defaultName,
    validate: (value) => {
      if (!value || value.trim().length === 0)
        return undefined
      if (value.includes('\n'))
        return 'Path cannot contain newlines'
      return undefined
    },
  })
  if (pIsCancel(pickedPath))
    return null

  const rawPath = (pickedPath || defaultName).trim() || defaultName
  const expanded = rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath
  const resolved = resolve(cwd(), expanded)

  if (existsSync(resolved)) {
    const overwrite = await pConfirm({
      message: `${resolved} already exists. Overwrite?`,
      initialValue: false,
    })
    if (pIsCancel(overwrite) || !overwrite)
      return null
  }

  return { path: resolved }
}

function renderEnvFileCombined(
  entry: AppEntry,
  sections: Array<{ platform: 'ios' | 'android', creds: Partial<BuildCredentials> }>,
  conflicts: CombinedKeyConflict[] = [],
): string {
  const lines: string[] = []
  const generated = new Date().toISOString()
  const platformList = sections.map(s => s.platform).join(', ')
  lines.push('# Capgo build credentials — CI/CD environment file')
  lines.push(`# App: ${entry.appId}`)
  lines.push(`# Platforms: ${platformList}`)
  lines.push(`# Source: ${entry.local ? 'local' : 'global'} credentials store`)
  lines.push(`# Generated: ${generated}`)
  lines.push('#')
  lines.push('# Paste these into your CI/CD provider as secrets, or source the file locally:')
  lines.push('#   set -a; . ./this-file; set +a')
  lines.push('#')
  lines.push('# DO NOT commit this file. Add to .gitignore: .env.capgo.*')
  if (conflicts.length > 0) {
    lines.push('#')
    lines.push('# ⚠️  CONFLICTING KEYS: the following appear in multiple platform sections')
    lines.push('# with different values. Dotenv ingestion (gh secret set -f, shell sourcing)')
    lines.push('# keeps only the LAST occurrence per key — re-export per-platform to preserve both.')
    for (const { key, occurrences } of conflicts)
      lines.push(`#   ${key} (${occurrences.map(o => o.platform).join(' & ')})`)
  }

  for (const { platform, creds } of sections) {
    lines.push('')
    lines.push(`# === ${platform.toUpperCase()} ===`)
    const provisioningMapRaw = creds.CAPGO_IOS_PROVISIONING_MAP
    for (const [key, value] of Object.entries(creds)) {
      if (typeof value !== 'string' || value.length === 0)
        continue
      if (key === 'CAPGO_IOS_PROVISIONING_MAP')
        continue
      lines.push(`${key}=${escapeDotenvValue(value)}`)
    }
    if (provisioningMapRaw) {
      const base64 = Buffer.from(provisioningMapRaw, 'utf-8').toString('base64')
      lines.push('')
      lines.push('# Provisioning map — base64 form is preferred to avoid newline/quoting issues in CI.')
      lines.push(`CAPGO_IOS_PROVISIONING_MAP_BASE64=${base64}`)
      lines.push(`# CAPGO_IOS_PROVISIONING_MAP=${escapeDotenvValue(provisioningMapRaw)}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

async function deletePlatformInteractive(entry: AppEntry): Promise<boolean> {
  if (entry.platforms.length === 0) {
    pLog.warn('Nothing to delete — no platforms configured.')
    return false
  }

  const platform = await resolvePlatformChoice(entry, 'Pick which platform to delete')
  if (platform === null)
    return false

  const confirmed = await pConfirm({
    message: `Delete ${platform} credentials for ${entry.appId} (${entry.local ? 'local' : 'global'})?`,
    initialValue: false,
  })
  if (pIsCancel(confirmed) || !confirmed)
    return false

  await clearSavedCredentials(entry.appId, platform, entry.local)
  pLog.success(`✓ Deleted ${platform} credentials for ${entry.appId} (${entry.local ? 'local' : 'global'}).`)
  return true
}

interface AddCredentialResult {
  /** True when the user picked "Add platform support" and the manager has handed off to the onboarding wizard. The caller must exit immediately. */
  handoff: boolean
  /** True when on-disk credentials were written and the caller should reload `currentEntry.saved`. */
  mutated: boolean
}

async function handleAddCredential(entry: AppEntry): Promise<AddCredentialResult> {
  let workingEntry = entry
  let mutatedAnyTime = false

  while (true) {
    // Recompute on every iteration: after an Add config completes the missing
    // platforms set is unchanged but the addable-config count decreases.
    const missingPlatforms: Array<'ios' | 'android'> = (['ios', 'android'] as const).filter(p => !workingEntry.platforms.includes(p))
    const canAddPlatform = missingPlatforms.length > 0
    const addableConfigCount = countAddableConfigurations(workingEntry)

    setManagerScreen({
      title: `${workingEntry.appId} · add credential`,
      introLines: [
        `Source: ${workingEntry.local ? 'local' : 'global'} store`,
        '',
        'Add platform support — run the build onboarding wizard for a platform you have not yet set up.',
        '   Note: this CLOSES the credentials manager. You will not return here automatically.',
        '',
        'Add configuration option — set a behaviour knob (QR code upload, retention, version bump, distribution mode, flavor, …).',
        '   Credential material (certificates, keystores, API keys) is set up via the onboarding flow, not here.',
      ],
      statusLine: 'Esc returns to the action menu, Ctrl+C quits.',
    })

    const options: Array<{ value: string, label: string, hint: string }> = []
    options.push({
      value: 'platform',
      label: canAddPlatform ? 'Add platform support' : 'Add platform support (all configured)',
      hint: canAddPlatform ? missingPlatforms.map(p => p === 'ios' ? 'iOS' : 'Android').join(' or ') : 'iOS and Android both set up',
    })
    options.push({
      value: 'config',
      label: addableConfigCount > 0 ? 'Add configuration option' : 'Add configuration option (none available)',
      hint: addableConfigCount > 0 ? `${addableConfigCount} option${addableConfigCount === 1 ? '' : 's'} unset` : 'all known options are already set',
    })
    options.push({ value: 'back', label: 'Back', hint: 'return to the action menu' })

    const choice = await pSelect({ message: 'Add credential', options })
    // Esc at this level — bubble back to the main action menu.
    if (pIsCancel(choice) || choice === 'back')
      return { handoff: false, mutated: mutatedAnyTime }

    if (choice === 'platform') {
      if (!canAddPlatform) {
        pLog.warn('Both platforms are already configured for this app.')
        continue
      }
      const handed = await handleAddPlatform(workingEntry, missingPlatforms)
      if (handed)
        return { handoff: true, mutated: mutatedAnyTime }
      // Handoff was declined — stay in the Add sub-menu so Esc only goes one
      // level up from the confirm prompt.
      continue
    }

    if (choice === 'config') {
      if (addableConfigCount === 0) {
        pLog.warn('All known configuration options are already set.')
        continue
      }
      const added = await handleAddConfiguration(workingEntry)
      if (added) {
        mutatedAnyTime = true
        // Reload so the next iteration excludes just-added keys.
        const refreshed = await loadSavedCredentials(workingEntry.appId, workingEntry.local)
        if (refreshed) {
          workingEntry = {
            ...workingEntry,
            saved: refreshed,
            platforms: refreshedPlatforms(refreshed),
          }
        }
      }
      // Whether the inner flow added something or the user cancelled out of
      // it, we stay in the Add sub-menu.
      continue
    }
  }
}

async function handleAddPlatform(entry: AppEntry, missingPlatforms: Array<'ios' | 'android'>): Promise<boolean> {
  let target: 'ios' | 'android'
  if (missingPlatforms.length === 1) {
    target = missingPlatforms[0]
  }
  else {
    const picked = await pSelect<'ios' | 'android'>({
      message: 'Which platform to add?',
      options: missingPlatforms.map(p => ({ value: p, label: p === 'ios' ? 'iOS' : 'Android' })),
    })
    if (pIsCancel(picked))
      return false
    target = picked
  }

  const platformLabel = target === 'ios' ? 'iOS' : 'Android'
  const proceed = await pConfirm({
    message: `This will close the credentials manager and launch the ${platformLabel} onboarding wizard. You won't return here automatically — re-run \`capgo build credentials manage\` afterwards. Continue?`,
    initialValue: false,
  })
  if (pIsCancel(proceed) || !proceed)
    return false

  // Hand off: stop the Ink session cleanly and launch the build-onboarding
  // wizard. It runs its own Ink render(), then exits. The caller signals exit
  // so we do not print a "Done." outro.
  stopInitInkSession({ text: `Launching ${platformLabel} onboarding…`, tone: 'green' })
  await onboardingBuilderCommand({})
  return true
}

function countAddableConfigurations(entry: AppEntry): number {
  return enumerateAddableConfigurations(entry).length
}

interface ConfigurationCandidate {
  key: string
  knowledge: FieldKnowledge
  /** Platforms that do NOT yet have this key set (and to which the new value could be written). */
  missingOn: Array<'ios' | 'android'>
}

function enumerateAddableConfigurations(entry: AppEntry): ConfigurationCandidate[] {
  const candidates: ConfigurationCandidate[] = []
  for (const [key, knowledge] of Object.entries(CREDENTIAL_KNOWLEDGE)) {
    if (knowledge.category !== 'configuration')
      continue
    if (knowledge.scope === 'shared') {
      const missingOn = entry.platforms.filter(p => !hasValue(entry.saved[p], key))
      if (missingOn.length > 0)
        candidates.push({ key, knowledge, missingOn })
    }
    else {
      const platform = knowledge.scope
      if (entry.platforms.includes(platform) && !hasValue(entry.saved[platform], key))
        candidates.push({ key, knowledge, missingOn: [platform] })
    }
  }
  return candidates
}

function hasValue(creds: Partial<BuildCredentials> | undefined, key: string): boolean {
  if (!creds)
    return false
  const value = (creds as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0
}

async function handleAddConfiguration(entry: AppEntry): Promise<boolean> {
  let workingEntry = entry
  let mutatedAnyTime = false

  while (true) {
    const candidates = enumerateAddableConfigurations(workingEntry)
    if (candidates.length === 0) {
      pLog.info('Every known configuration option is now set.')
      return mutatedAnyTime
    }

    setManagerScreen({
      title: `${workingEntry.appId} · add configuration`,
      introLines: [
        `${candidates.length} option${candidates.length === 1 ? '' : 's'} available to add.`,
        'Each option shows its scope tag — [SHARED] writes to both platforms, [ios]/[android] to one.',
      ],
      statusLine: 'Esc returns to the Add credential menu.',
    })

    const pickedIndex = await pSelect({
      message: 'Which configuration option to add?',
      options: candidates.map((c, i) => ({
        value: String(i),
        label: `[${c.knowledge.scope === 'shared' ? 'SHARED' : c.knowledge.scope}] ${c.key}`,
        hint: shortenForHint(c.knowledge.explain),
      })),
    })
    // Esc at the config picker — return to the Add credential sub-menu.
    if (pIsCancel(pickedIndex))
      return mutatedAnyTime

    const picked = candidates[Number.parseInt(pickedIndex, 10)]
    if (!picked)
      continue

    // For shared keys, decide which platform(s) to write to.
    let writePlatforms: Array<'ios' | 'android'> = picked.missingOn
    if (picked.knowledge.scope === 'shared' && picked.missingOn.length > 1) {
      const choice = await pSelect<'both' | 'ios' | 'android'>({
        message: `Write ${picked.key} to which platform(s)?`,
        options: [
          { value: 'both', label: 'Both', hint: 'recommended for shared settings' },
          { value: 'ios', label: 'iOS only' },
          { value: 'android', label: 'Android only' },
        ],
      })
      // Esc at the platform-target picker — return to the config picker, not
      // out of the whole Add flow.
      if (pIsCancel(choice))
        continue
      if (choice === 'ios')
        writePlatforms = ['ios']
      else if (choice === 'android')
        writePlatforms = ['android']
    }

    const newValue = await promptValueForType(picked.key, picked.knowledge)
    // Esc at the value prompt — return to the config picker.
    if (newValue === null)
      continue

    for (const platform of writePlatforms)
      await updateSavedCredentials(workingEntry.appId, platform, { [picked.key]: newValue }, workingEntry.local)

    pLog.success(`✓ Added ${picked.key} = ${formatValueForLog(picked.knowledge, newValue)} on ${writePlatforms.join(' + ')}.`)
    mutatedAnyTime = true

    // Reload so the just-added key drops out of the picker on the next iteration.
    const refreshed = await loadSavedCredentials(workingEntry.appId, workingEntry.local)
    if (refreshed) {
      workingEntry = {
        ...workingEntry,
        saved: refreshed,
        platforms: refreshedPlatforms(refreshed),
      }
    }
  }
}

function shortenForHint(text: string): string {
  const firstSentence = text.split('. ')[0] ?? text
  if (firstSentence.length <= 70)
    return firstSentence
  return `${firstSentence.slice(0, 67)}…`
}

function formatValueForLog(knowledge: FieldKnowledge, value: string): string {
  if (knowledge.type === 'duration')
    return `${value}s`
  if (value.length > 40)
    return `${value.slice(0, 37)}… (${value.length} chars)`
  return value
}

async function promptValueForType(key: string, knowledge: FieldKnowledge): Promise<string | null> {
  if (knowledge.type === 'boolean') {
    const picked = await pSelect<'true' | 'false'>({
      message: `Set ${key}`,
      options: [
        { value: 'true', label: 'true' },
        { value: 'false', label: 'false' },
      ],
    })
    if (pIsCancel(picked))
      return null
    return picked
  }

  if (knowledge.type === 'enum') {
    const enumValues = knowledge.enumValues ?? []
    if (enumValues.length === 0) {
      pLog.error(`Enum field ${key} has no allowed values configured.`)
      return null
    }
    const picked = await pSelect<string>({
      message: `Set ${key}`,
      options: enumValues.map(v => ({ value: v, label: v })),
    })
    if (pIsCancel(picked))
      return null
    return picked
  }

  if (knowledge.type === 'duration') {
    const entered = await pText({
      message: `Duration for ${key}`,
      placeholder: '1h, 6h, 2d (1h–7d range)',
      validate: (value) => {
        if (!value || value.trim().length === 0)
          return 'Required'
        try {
          parseOutputRetentionLocal(value)
        }
        catch (error) {
          return error instanceof Error ? error.message : 'Invalid duration'
        }
        return undefined
      },
    })
    if (pIsCancel(entered))
      return null
    return String(parseOutputRetentionLocal(entered))
  }

  if (knowledge.type === 'string') {
    const entered = await pText({
      message: `Value for ${key}`,
      placeholder: 'enter a value',
      validate: (value) => {
        if (!value || value.trim().length === 0)
          return 'Required'
        if (value.includes('\n'))
          return 'Single-line values only'
        return undefined
      },
    })
    if (pIsCancel(entered))
      return null
    return entered.trim()
  }

  // base64 / json — not addable via this flow. Surface a hint instead of crashing.
  pLog.warn(`${key} is credential material (type=${knowledge.type}) and must be added via the platform onboarding wizard, not the configuration flow.`)
  return null
}
