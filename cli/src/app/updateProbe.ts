import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cwd } from 'node:process'
import { getPlatformDirFromCapacitorConfig } from '../build/platform-paths'
import { getInstalledVersion } from '../utils'

const defaultUpdateUrl = 'https://plugin.capgo.app/updates'
export const updateProbeDeviceId = '00000000-0000-0000-0000-000000000000'

/**
 * Full troubleshooting reference for common update failure codes.
 * Maintained in the Capgo website repo (Cap-go/website) at:
 *   src/content/docs/docs/plugins/updater/commonProblems.mdx
 */
const commonProblemsDocsUrl = 'https://capgo.app/docs/plugins/updater/commonproblems/'

interface NativeVersionInfo {
  versionName: string
  versionCode?: string
  source: string
}

interface UpdateProbePayload {
  app_id: string
  device_id: string
  version_name: string
  version_build: string
  is_emulator: boolean
  is_prod: boolean
  platform: 'ios' | 'android'
  plugin_version: string
  defaultChannel: string
}

export interface PreparedUpdateProbe {
  endpoint: string
  payload: UpdateProbePayload
  nativeSource: string
  versionBuildSource: string
  appIdSource: string
}

export type PrepareUpdateProbeResult
  = | { ok: true, context: PreparedUpdateProbe }
    | { ok: false, error: string }

interface ParsedUpdateResponse {
  status: 'available' | 'retry' | 'failed'
  detail: string
  responseVersion?: string
  errorCode?: string
  backendMessage?: string
  extra?: Record<string, unknown>
}

export type UpdateProbeResult
  = | { success: true, availableVersion: string }
    | {
      success: false
      reason: string
      backendRefusal: boolean
      errorCode?: string
      backendMessage?: string
      extra?: Record<string, unknown>
    }

function readTextIfExists(filePath: string): string | undefined {
  if (!existsSync(filePath))
    return undefined
  return readFileSync(filePath, 'utf-8')
}

function parseAndroidNativeVersion(platformDir: string): NativeVersionInfo | undefined {
  const candidates = [
    join(cwd(), platformDir, 'app', 'build.gradle'),
    join(cwd(), platformDir, 'app', 'build.gradle.kts'),
  ]
  for (const candidate of candidates) {
    const content = readTextIfExists(candidate)
    if (!content)
      continue
    const versionName = content.match(/versionName\s*(?:=\s*)?["']([^"']+)["']/)?.[1]
    const versionCode = content.match(/versionCode\s*(?:=\s*)?(\d+)/)?.[1]
    if (versionName) {
      return {
        versionName,
        versionCode,
        source: candidate,
      }
    }
  }
  return undefined
}

function parsePlistString(content: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = content.match(new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]+)</string>`))
  return match?.[1]?.trim()
}

function parsePbxprojSetting(content: string, setting: 'MARKETING_VERSION' | 'CURRENT_PROJECT_VERSION') {
  const match = content.match(new RegExp(`${setting}\\s*=\\s*([^;]+);`))
  const raw = match?.[1]?.trim()
  if (!raw)
    return undefined
  return raw.replace(/"/g, '').trim()
}

function parseIosNativeVersion(platformDir: string): NativeVersionInfo | undefined {
  const appRoot = join(cwd(), platformDir, 'App')
  const plistPath = join(appRoot, 'App', 'Info.plist')
  const pbxprojPath = join(appRoot, 'App.xcodeproj', 'project.pbxproj')
  const plist = readTextIfExists(plistPath)
  const pbxproj = readTextIfExists(pbxprojPath)
  if (!plist)
    return undefined

  let versionName = parsePlistString(plist, 'CFBundleShortVersionString')
  let versionCode = parsePlistString(plist, 'CFBundleVersion')

  if (versionName === '$(MARKETING_VERSION)')
    versionName = pbxproj ? parsePbxprojSetting(pbxproj, 'MARKETING_VERSION') : undefined
  if (versionCode === '$(CURRENT_PROJECT_VERSION)')
    versionCode = pbxproj ? parsePbxprojSetting(pbxproj, 'CURRENT_PROJECT_VERSION') : undefined

  if (!versionName && pbxproj)
    versionName = parsePbxprojSetting(pbxproj, 'MARKETING_VERSION')
  if (!versionCode && pbxproj)
    versionCode = parsePbxprojSetting(pbxproj, 'CURRENT_PROJECT_VERSION')

  if (!versionName)
    return undefined

  return {
    versionName,
    versionCode,
    source: plistPath,
  }
}

function getConfiguredUpdaterVersion(capConfig: any): string | undefined {
  const configured = capConfig?.plugins?.CapacitorUpdater?.version
  if (typeof configured === 'string' && configured.trim().length > 0)
    return configured.trim()
  return undefined
}

function getProbeDefaultChannel(capConfig: any): string {
  const configured = capConfig?.plugins?.CapacitorUpdater?.defaultChannel
  if (typeof configured === 'string' && configured.trim().length > 0)
    return configured.trim()
  return ''
}

function getUpdateUrl(capConfig: any): string {
  const configured = capConfig?.plugins?.CapacitorUpdater?.updateUrl
  if (typeof configured === 'string' && configured.trim().length > 0)
    return configured.trim()
  return defaultUpdateUrl
}

export async function prepareUpdateProbe(
  platform: 'ios' | 'android',
  capConfig: any,
): Promise<PrepareUpdateProbeResult> {
  const updaterAppId = capConfig?.plugins?.CapacitorUpdater?.appId
  const topLevelAppId = capConfig?.appId
  const resolvedAppId = updaterAppId || topLevelAppId
  if (!resolvedAppId) {
    return {
      ok: false,
      error: 'Could not resolve app ID from capacitor config. Ensure appId is set in capacitor.config.ts or CapacitorUpdater.appId is configured.',
    }
  }
  const appIdSource = updaterAppId
    ? 'CapacitorUpdater.appId from capacitor config'
    : 'top-level appId from capacitor config'

  const platformDir = getPlatformDirFromCapacitorConfig(capConfig, platform)
  const nativeVersion = platform === 'android'
    ? parseAndroidNativeVersion(platformDir)
    : parseIosNativeVersion(platformDir)
  if (!nativeVersion) {
    return {
      ok: false,
      error: `Unable to resolve native ${platform.toUpperCase()} version values from platform files in "${platformDir}".`,
    }
  }

  const configuredVersion = getConfiguredUpdaterVersion(capConfig)
  const probeVersionBuild = configuredVersion || nativeVersion.versionName
  const versionBuildSource = configuredVersion ? 'CapacitorUpdater.version from capacitor config' : `native ${platform.toUpperCase()} versionName`

  const packageJsonPath = join(cwd(), 'package.json')
  const projectPath = dirname(packageJsonPath)
  const pluginVersion = await getInstalledVersion('@capgo/capacitor-updater', projectPath, packageJsonPath)
  if (!pluginVersion) {
    return {
      ok: false,
      error: 'Unable to resolve installed @capgo/capacitor-updater version from this project.',
    }
  }

  return {
    ok: true,
    context: {
      endpoint: getUpdateUrl(capConfig),
      payload: {
        app_id: resolvedAppId,
        device_id: updateProbeDeviceId,
        version_name: 'builtin',
        version_build: probeVersionBuild,
        is_emulator: false,
        is_prod: false,
        platform,
        plugin_version: pluginVersion,
        defaultChannel: getProbeDefaultChannel(capConfig),
      },
      nativeSource: nativeVersion.source,
      versionBuildSource,
      appIdSource,
    },
  }
}

function extractExtra(json: any): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  if (json && typeof json === 'object') {
    for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
      if (key !== 'error' && key !== 'message')
        extra[key] = value
    }
  }
  return extra
}

function parseUpdateResponse(json: any, currentVersionName: string): ParsedUpdateResponse {
  const error = typeof json?.error === 'string' ? json.error : undefined
  const message = typeof json?.message === 'string' ? json.message : undefined
  const responseVersion = typeof json?.version === 'string' ? json.version : undefined

  if (error === 'no_new_version_available' || (responseVersion && responseVersion === currentVersionName)) {
    return {
      status: 'retry',
      detail: message || 'No new version available yet',
    }
  }

  if (error) {
    return {
      status: 'failed',
      detail: `${error}: ${message ?? 'Unknown backend message'}`,
      errorCode: error,
      backendMessage: message,
      extra: extractExtra(json),
    }
  }

  if (responseVersion && responseVersion !== currentVersionName) {
    return {
      status: 'available',
      detail: `Update ${responseVersion} is available`,
      responseVersion,
    }
  }

  return {
    status: 'failed',
    detail: `Unexpected response format: ${JSON.stringify(json)}`,
  }
}

const PROBE_TIMEOUT_MS = 10_000

export async function singleProbeRequest(endpoint: string, payload: UpdateProbePayload): Promise<UpdateProbeResult> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  }
  catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return {
        success: false,
        reason: `Request timed out after ${PROBE_TIMEOUT_MS / 1000}s — the endpoint did not respond in time.`,
        backendRefusal: false,
      }
    }
    return {
      success: false,
      reason: `Network error: ${error instanceof Error ? error.message : String(error)}`,
      backendRefusal: false,
    }
  }

  let json: any
  try {
    json = await response.json()
  }
  catch {
    json = { error: 'invalid_json_response', message: 'Non-JSON response from updates endpoint' }
  }

  if (!response.ok) {
    const errorCode = typeof json?.error === 'string' ? json.error : undefined
    const backendMessage = typeof json?.message === 'string' ? json.message : undefined
    return {
      success: false,
      reason: `HTTP ${response.status}: ${JSON.stringify(json)}`,
      backendRefusal: !!errorCode,
      errorCode,
      backendMessage,
      extra: extractExtra(json),
    }
  }

  const parsed = parseUpdateResponse(json, payload.version_name)
  if (parsed.status === 'available') {
    return {
      success: true,
      availableVersion: parsed.responseVersion ?? '',
    }
  }

  if (parsed.status === 'retry') {
    return {
      success: false,
      reason: parsed.detail,
      backendRefusal: false,
    }
  }

  return {
    success: false,
    reason: parsed.detail,
    backendRefusal: !!parsed.errorCode,
    errorCode: parsed.errorCode,
    backendMessage: parsed.backendMessage,
    extra: parsed.extra,
  }
}

/**
 * Brief CLI hints for recognized error codes.
 * One-liner cause + quick-fix with a deep-link into the specific section of
 * the common-problems docs page ({@link commonProblemsDocsUrl}).
 *
 * Anchors are derived from the heading slugs in:
 *   Cap-go/website  src/content/docs/docs/plugins/updater/commonProblems.mdx
 */
const errorHints: Record<string, { cause: string, fix: string, docsUrl?: string }> = {
  disable_auto_update_to_major: {
    cause: 'Channel blocks major upgrades and device baseline major does not match the target bundle major.',
    fix: 'Set plugins.CapacitorUpdater.version so its MAJOR matches the bundle MAJOR (e.g. 1.0.0 for bundle 1.x.x), run npx cap sync, and reinstall the native build.',
    docsUrl: `${commonProblemsDocsUrl}#disable_auto_update_to_major`,
  },
  disable_auto_update_to_minor: {
    cause: 'Channel blocks minor upgrades and the target bundle minor is above the device baseline.',
    fix: 'Upload a bundle within the allowed minor range, or change the channel disable_auto_update policy in the dashboard.',
    docsUrl: `${commonProblemsDocsUrl}#disable_auto_update_to_minor--disable_auto_update_to_patch`,
  },
  disable_auto_update_to_patch: {
    cause: 'Channel blocks patch upgrades and the target bundle patch is above the device baseline.',
    fix: 'Upload a bundle within the allowed patch range, or change the channel disable_auto_update policy in the dashboard.',
    docsUrl: `${commonProblemsDocsUrl}#disable_auto_update_to_minor--disable_auto_update_to_patch`,
  },
  disable_auto_update_to_metadata: {
    cause: 'Channel uses metadata-based targeting (version_number) and the device baseline is below the required min_update_version.',
    fix: 'Set plugins.CapacitorUpdater.version to match the installed native version, or adjust min_update_version on the channel.',
    docsUrl: `${commonProblemsDocsUrl}#disable_auto_update_to_metadata`,
  },
  disable_auto_update_under_native: {
    cause: 'Channel prevents downgrades below the native app version.',
    fix: 'Upload a bundle with version >= native baseline, or disable the under-native downgrade protection on the channel.',
    docsUrl: `${commonProblemsDocsUrl}#disable_auto_update_under_native`,
  },
  misconfigured_channel: {
    cause: 'Channel has disable_auto_update=version_number but min_update_version is missing.',
    fix: 'Set a valid min_update_version on the channel, or change disable_auto_update to a different mode.',
  },
  cannot_update_via_private_channel: {
    cause: 'The selected channel does not allow device self-assignment.',
    fix: 'Use a channel with self-assignment enabled, or enable self-assignment / make the channel public.',
    docsUrl: `${commonProblemsDocsUrl}#cannot_update_via_private_channel`,
  },
  semver_error: {
    cause: 'version_build sent to the backend is not valid semver (expected x.y.z).',
    fix: 'Set plugins.CapacitorUpdater.version to a valid semver like 1.2.3, run npx cap sync, and rebuild native.',
    docsUrl: `${commonProblemsDocsUrl}#unknown_version_build--semver_error`,
  },
  unknown_version_build: {
    cause: 'Backend received version_build=unknown (device baseline version is missing).',
    fix: 'Set plugins.CapacitorUpdater.version in capacitor.config.*, run npx cap sync, and rebuild native.',
    docsUrl: `${commonProblemsDocsUrl}#unknown_version_build--semver_error`,
  },
  unsupported_plugin_version: {
    cause: 'Installed @capgo/capacitor-updater is too old for the current backend.',
    fix: 'Run npm install @capgo/capacitor-updater@latest, then npx cap sync, and rebuild native.',
    docsUrl: `${commonProblemsDocsUrl}#unsupported_plugin_version`,
  },
  key_id_mismatch: {
    cause: 'Bundle encryption key and device key differ.',
    fix: 'Ensure the same public key is used in app config and when encrypting bundles, then re-upload the bundle.',
    docsUrl: `${commonProblemsDocsUrl}#key_id_mismatch`,
  },
  disabled_platform_ios: {
    cause: 'Channel has iOS updates disabled.',
    fix: 'Enable the iOS platform toggle on the target channel in the dashboard.',
    docsUrl: `${commonProblemsDocsUrl}#disabled_platform_ios--disabled_platform_android`,
  },
  disabled_platform_android: {
    cause: 'Channel has Android updates disabled.',
    fix: 'Enable the Android platform toggle on the target channel in the dashboard.',
    docsUrl: `${commonProblemsDocsUrl}#disabled_platform_ios--disabled_platform_android`,
  },
  disabled_platform_electron: {
    cause: 'Channel has Electron updates disabled.',
    fix: 'Enable the Electron platform toggle on the target channel in the dashboard.',
  },
  disable_prod_build: {
    cause: 'Channel blocks production builds (allow_prod is off).',
    fix: 'Enable allow_prod on the channel, or test with a development build.',
    docsUrl: `${commonProblemsDocsUrl}#disable_prod_build--disable_dev_build--disable_device--disable_emulator`,
  },
  disable_dev_build: {
    cause: 'Channel blocks development builds (allow_dev is off).',
    fix: 'Enable allow_dev on the channel, or test with a production build.',
    docsUrl: `${commonProblemsDocsUrl}#disable_prod_build--disable_dev_build--disable_device--disable_emulator`,
  },
  disable_device: {
    cause: 'Channel blocks physical devices (allow_device is off).',
    fix: 'Enable allow_device on the channel, or test on an emulator.',
    docsUrl: `${commonProblemsDocsUrl}#disable_prod_build--disable_dev_build--disable_device--disable_emulator`,
  },
  disable_emulator: {
    cause: 'Channel blocks emulators (allow_emulator is off).',
    fix: 'Enable allow_emulator on the channel, or test on a physical device.',
    docsUrl: `${commonProblemsDocsUrl}#disable_prod_build--disable_dev_build--disable_device--disable_emulator`,
  },
  no_channel: {
    cause: 'No channel was resolved for this device.',
    fix: 'Set defaultChannel in capacitor.config.* plugins.CapacitorUpdater section, or create a default channel in the dashboard.',
    docsUrl: `${commonProblemsDocsUrl}#no_channel--null_channel_data`,
  },
  null_channel_data: {
    cause: 'Channel was resolved but contains no usable data.',
    fix: 'Set defaultChannel in capacitor.config.* plugins.CapacitorUpdater section, or verify the channel has a bundle assigned.',
    docsUrl: `${commonProblemsDocsUrl}#no_channel--null_channel_data`,
  },
  missing_info: {
    cause: 'Request is missing required fields (app_id, device_id, version_build, or platform).',
    fix: 'Check capacitor.config.* for a valid appId and verify the probe payload.',
  },
  no_bundle: {
    cause: 'Channel resolved a version but no downloadable bundle artifact exists.',
    fix: 'Re-upload the bundle with npx @capgo/cli@latest bundle upload and verify channel assignment.',
  },
  no_bundle_url: {
    cause: 'Bundle was resolved but its download URL is missing.',
    fix: 'Re-upload the bundle — the storage artifact may be corrupted or missing.',
  },
  no_url_or_manifest: {
    cause: 'Bundle was resolved but neither URL nor manifest is available.',
    fix: 'Re-upload the bundle — the storage artifact may be corrupted or missing.',
  },
  already_on_builtin: {
    cause: 'Device is already running the builtin bundle.',
    fix: 'Upload and assign a bundle to the channel for OTA updates to be delivered.',
  },
  revert_to_builtin_plugin_version_too_old: {
    cause: 'Plugin version is too old for safe builtin revert.',
    fix: 'Run npm install @capgo/capacitor-updater@latest, then npx cap sync, and rebuild native.',
  },
  provider_infrastructure_request_blocked: {
    cause: 'Update requests from known provider infrastructure networks are intentionally blocked.',
    fix: 'Retry from a normal client device network or test through the same updater path used by users.',
    docsUrl: commonProblemsDocsUrl,
  },
  on_premise_app: {
    cause: 'App is either flagged as on-premise or does not exist in Capgo Cloud.',
    fix: 'Check that the app_id is registered in Capgo (capgo app add). If it is an on-premise app, configure plugins.CapacitorUpdater.updateUrl to point to your on-prem update endpoint.',
  },
  need_plan_upgrade: {
    cause: 'Update checks are blocked by plan limits.',
    fix: 'Upgrade your Capgo plan or contact your organization admin.',
  },
  invalid_json_body: {
    cause: 'Updates endpoint rejected the request body as invalid JSON.',
    fix: 'This is likely a CLI bug — please report it at https://github.com/Cap-go/capgo/issues.',
  },
  invalid_query_parameters: {
    cause: 'Updates endpoint rejected the query parameters.',
    fix: 'This is likely a CLI bug — please report it at https://github.com/Cap-go/capgo/issues.',
  },
}

export function explainCommonUpdateError(result: Extract<UpdateProbeResult, { success: false }>): string[] {
  if (!result.errorCode)
    return []

  const hints: string[] = []

  // Special context for major-block errors
  if (result.errorCode === 'disable_auto_update_to_major') {
    const blockedVersion = typeof result.extra?.version === 'string' ? result.extra.version : 'unknown'
    const oldVersion = typeof result.extra?.old === 'string' ? result.extra.old : 'unknown'
    hints.push(`Channel policy blocks major upgrades (target ${blockedVersion}, device baseline ${oldVersion}).`)
  }

  const known = errorHints[result.errorCode]
  if (known) {
    hints.push(known.cause)
    hints.push(`Fix: ${known.fix}`)
    hints.push(`Details: ${known.docsUrl || commonProblemsDocsUrl}`)
  }
  else {
    hints.push(`Backend returned ${result.errorCode}.`)
    hints.push('Check channel restrictions, app/plugin configuration, and device version values.')
    hints.push(`Troubleshooting guide: ${commonProblemsDocsUrl}`)
  }

  return hints
}
