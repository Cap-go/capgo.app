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

export const CHANNEL_SELF_STORE_CUTOFF_CAPTION = `Legacy below v5 ${CHANNEL_SELF_STORE_MIN_V5}, v6 ${CHANNEL_SELF_STORE_MIN_V6}, v7 ${CHANNEL_SELF_STORE_MIN_V7}, v8 ${CHANNEL_SELF_STORE_MIN_V8}`
export const ENCRYPTION_KEY_ID_CUTOFF_CAPTION = `Current above v8 ${ENCRYPTION_KEY_ID_FORMAT_MIN_VERSION} (20-char key_id)`

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

/** Honor durable overrides only for forced dashboard/API assignments or legacy plugin devices. */
export function shouldHonorPersistedChannelOverride(
  devicePluginVersion: string | null | undefined,
  allowDeviceSelfSet: boolean,
): boolean {
  if (!allowDeviceSelfSet)
    return true

  if (!devicePluginVersion)
    return false

  return isLegacyChannelSelfStorePluginVersion(devicePluginVersion)
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

export interface PluginVersionCompatibilityBucket {
  legacyPercent: number
  currentPercent: number
  legacyDevices: number | null
  currentDevices: number | null
}

export function hasPluginVersionBreakdown(versionBreakdown: Record<string, number> | null | undefined): boolean {
  if (!versionBreakdown)
    return false

  return Object.values(versionBreakdown).some(value => Number(value) > 0)
}

export interface PluginVersionLadderEstimateInput {
  device_count: number
  percent: number
}

/** Estimates devices with a known plugin version from one ladder row (same population as version_breakdown). */
export function estimateKnownPluginVersionDevicesFromLadder(
  versionLadder: PluginVersionLadderEstimateInput[] | null | undefined,
): number | null {
  if (!versionLadder?.length)
    return null

  const anchor = versionLadder.find(entry => entry.device_count > 0 && entry.percent > 0)
  if (!anchor)
    return null

  return Math.round(anchor.device_count / (anchor.percent / 100))
}

export function bucketPluginVersionBreakdown(
  versionBreakdown: Record<string, number>,
  isLegacy: (pluginVersion: string) => boolean,
  knownVersionDeviceCount?: number | null,
): PluginVersionCompatibilityBucket {
  let legacyPercent = 0
  let currentPercent = 0

  for (const [version, percentValue] of Object.entries(versionBreakdown)) {
    const percent = Number(percentValue) || 0
    if (percent <= 0)
      continue

    if (isLegacy(version))
      legacyPercent += percent
    else
      currentPercent += percent
  }

  const devices = Number(knownVersionDeviceCount) || 0
  if (devices <= 0) {
    return {
      legacyPercent,
      currentPercent,
      legacyDevices: null,
      currentDevices: null,
    }
  }

  return {
    legacyPercent,
    currentPercent,
    legacyDevices: (legacyPercent * devices) / 100,
    currentDevices: (currentPercent * devices) / 100,
  }
}
