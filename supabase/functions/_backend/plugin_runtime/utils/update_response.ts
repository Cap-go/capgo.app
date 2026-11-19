import type { ManifestEntry } from './downloadUrl.ts'
import type { Database } from './supabase.types.ts'
import { parse } from '@std/semver'
import { BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7, isDeprecatedPluginVersion } from './utils.ts'

export type UpdateResponseKind = 'up_to_date' | 'blocked' | 'failed'

const UPDATE_UP_TO_DATE_CODES = new Set([
  'no_new_version_available',
  'already_on_builtin',
  'channel_paused',
])

const UPDATE_BLOCKED_CODES = new Set([
  'cannot_update_via_private_channel',
  'disabled_platform_ios',
  'disabled_platform_android',
  'disabled_platform_electron',
  'disable_auto_update_to_major',
  'disable_auto_update_to_minor',
  'disable_auto_update_to_patch',
  'disable_auto_update_to_metadata',
  'disable_auto_update_under_native',
  'disable_prod_build',
  'disable_dev_build',
  'disable_device',
  'disable_emulator',
  'key_id_mismatch',
  'provider_infrastructure_request_blocked',
  // The app's region policy excludes regions an external provider cannot fence.
  'external_delivery_unavailable',
])

export function getUpdateResponseKind(errorCode: string): UpdateResponseKind {
  if (UPDATE_UP_TO_DATE_CODES.has(errorCode))
    return 'up_to_date'
  if (UPDATE_BLOCKED_CODES.has(errorCode))
    return 'blocked'
  return 'failed'
}

interface ResponseFeatureSupport {
  manifest: boolean
  metadata: boolean
}

const RESPONSE_FEATURE_SUPPORT_CACHE_MAX = 256
const responseFeatureSupportCache = new Map<string, ResponseFeatureSupport>()

function getResponseFeatureSupport(plugin_version: string): ResponseFeatureSupport {
  const cached = responseFeatureSupportCache.get(plugin_version)
  if (cached)
    return cached

  const pluginVersion = parse(plugin_version)
  const support = {
    manifest: !isDeprecatedPluginVersion(pluginVersion, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7),
    metadata: !isDeprecatedPluginVersion(pluginVersion, '5.35.0', '6.35.0', '7.35.0', '8.35.0'),
  }
  if (responseFeatureSupportCache.size >= RESPONSE_FEATURE_SUPPORT_CACHE_MAX) {
    const oldest = responseFeatureSupportCache.keys().next().value
    if (oldest !== undefined)
      responseFeatureSupportCache.delete(oldest)
  }
  responseFeatureSupportCache.set(plugin_version, support)
  return support
}

export function updateResponseSupportsManifest(plugin_version: string) {
  return getResponseFeatureSupport(plugin_version).manifest
}

export function resToVersion(plugin_version: string, signedURL: string, version: Database['public']['Tables']['app_versions']['Row'], manifest: ManifestEntry[], expose_metadata: boolean = false) {
  const support = getResponseFeatureSupport(plugin_version)
  const res: {
    version: string
    url: string
    session_key: string
    checksum: string | null
    manifest?: ManifestEntry[]
    link?: string | null
    comment?: string | null
  } = {
    version: version.name,
    url: signedURL,
    session_key: version.session_key ?? '',
    checksum: version.checksum,
  }
  if (manifest.length > 0 && support.manifest)
    res.manifest = manifest
  if (expose_metadata && support.metadata) {
    if (version.link)
      res.link = version.link
    if (version.comment)
      res.comment = version.comment
  }
  return res
}
