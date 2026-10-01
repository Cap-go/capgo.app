import type { SemVer } from '@std/semver'
import { greaterThan, parse } from '@std/semver'
import { isDeprecatedPluginVersion } from './utils.ts'

export const CHANNEL_SELF_STORE_MIN_V5 = '5.34.0'
export const CHANNEL_SELF_STORE_MIN_V6 = '6.34.0'
export const CHANNEL_SELF_STORE_MIN_V7 = '7.34.0'
export const CHANNEL_SELF_STORE_MIN_V8 = '8.0.0'
export const CHANNEL_SELF_STORE_PLACEHOLDER_PLUGIN_VERSION = '0.0.0'

/** Plugin versions at or below this use the legacy 4-char key_id format. */
export const ENCRYPTION_KEY_ID_FORMAT_MIN_VERSION = '8.40.7'


export function isLegacyChannelSelfStorePluginVersion(pluginVersion: string): boolean {
  if (!pluginVersion)
    return false
  if (pluginVersion === CHANNEL_SELF_STORE_PLACEHOLDER_PLUGIN_VERSION)
    return true

  try {
    return isDeprecatedPluginVersion(
      parse(pluginVersion),
      CHANNEL_SELF_STORE_MIN_V5,
      CHANNEL_SELF_STORE_MIN_V6,
      CHANNEL_SELF_STORE_MIN_V7,
      CHANNEL_SELF_STORE_MIN_V8,
    )
  }
  catch {
    return false
  }
}

export function usesCurrentEncryptionKeyIdFormat(parsedPluginVersion: SemVer): boolean {
  return greaterThan(parsedPluginVersion, parse(ENCRYPTION_KEY_ID_FORMAT_MIN_VERSION))
}

export function isLegacyEncryptionKeyIdPluginVersion(pluginVersion: string): boolean {
  if (!pluginVersion)
    return true

  try {
    return !usesCurrentEncryptionKeyIdFormat(parse(pluginVersion))
  }
  catch {
    return true
  }
}
