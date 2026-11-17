import type { SemVer } from '@std/semver'
import { greaterOrEqual, greaterThan, lessThan, tryParse } from '@std/semver'

/**
 * Pure impact preview for a channel change ("who gets what if I set this?").
 *
 * The /updates gates are replayed against aggregated device setups (platform,
 * native build, current bundle, plugin version, build type) so the console can
 * tell, before a bundle is set, rolled out or reverted, how many devices will
 * receive it and why the others will not. Keep the gate order in sync with
 * plugin_runtime/utils/update.ts.
 */

export type ChannelImpactPlatform = 'ios' | 'android' | 'electron' | 'unknown'
export type ChannelImpactStrategy = 'major' | 'minor' | 'patch' | 'version_number' | 'none'

export const CHANNEL_IMPACT_WINDOW_DAYS = 30
/** First plugin version that understands the revert-to-builtin response. */
export const BUILTIN_REVERT_MIN_PLUGIN_VERSION = '6.2.0'
const MAX_SAMPLES = 5
const MAX_NATIVE_VERSIONS = 8

/** One distinct device setup on the channel and how many devices share it. */
export interface ChannelImpactDeviceGroup {
  platform: ChannelImpactPlatform
  /** Native build (store binary) version, normalized to semver by the plugin parser. */
  version_build: string
  /** Bundle the device runs now. Equals version_build while on the store bundle. */
  version_name: string
  plugin_version: string
  is_prod: boolean | null
  is_emulator: boolean | null
  device_count: number
  /** Most recently seen device of this setup, shown as an example. */
  sample_device_id: string
  last_seen: string | null
}

export interface ChannelImpactChannelConfig {
  disable_auto_update: ChannelImpactStrategy
  disable_auto_update_under_native: boolean
  ios: boolean
  android: boolean
  electron: boolean
  allow_prod: boolean
  allow_dev: boolean
  allow_device: boolean
  allow_emulator: boolean
}

export type ChannelImpactTarget
  = | { kind: 'bundle', name: string, min_update_version: string | null }
    | { kind: 'builtin' }

export const CHANNEL_IMPACT_OUTCOMES = [
  'receive',
  'receive_below_native',
  'revert_to_builtin',
  'already_on_target',
  'blocked_major',
  'blocked_minor',
  'blocked_patch',
  'blocked_metadata',
  'blocked_misconfigured',
  'blocked_under_native',
  'blocked_platform',
  'blocked_build_type',
  'plugin_too_old',
  'unknown_native',
] as const
export type ChannelImpactOutcome = typeof CHANNEL_IMPACT_OUTCOMES[number]

/** Outcomes where the device switches to the target bundle at its next update check. */
const RECEIVING_OUTCOMES = new Set<ChannelImpactOutcome>(['receive', 'receive_below_native', 'revert_to_builtin'])

export function isReceivingOutcome(outcome: ChannelImpactOutcome) {
  return RECEIVING_OUTCOMES.has(outcome)
}

/** What a device needs to be able to receive a strategy-gated bundle. */
export interface ChannelImpactRequirement {
  strategy: 'major' | 'minor' | 'patch' | 'metadata'
  /** Native build version from which (major, metadata) or for which (minor, patch) the bundle is delivered. */
  native: string
}

export interface ChannelImpactNativeVersion {
  platform: ChannelImpactPlatform
  version_build: string
  device_count: number
  receive: number
  /** Most common outcome for this native build. */
  outcome: ChannelImpactOutcome
}

export interface ChannelImpactSample {
  device_id: string
  platform: ChannelImpactPlatform
  version_build: string
  version_name: string
  plugin_version: string
  is_prod: boolean | null
  is_emulator: boolean | null
  last_seen: string | null
  outcome: ChannelImpactOutcome
  /** Represented devices sharing this setup. */
  device_count: number
}

export interface ChannelImpactSummary {
  total_devices: number
  /** Devices that switch to the target at their next update check (stable mode). */
  receive: number
  outcomes: Record<ChannelImpactOutcome, number>
  requirement: ChannelImpactRequirement | null
  native_versions: ChannelImpactNativeVersion[]
  samples: ChannelImpactSample[]
}

function emptyOutcomes(): Record<ChannelImpactOutcome, number> {
  return Object.fromEntries(CHANNEL_IMPACT_OUTCOMES.map(outcome => [outcome, 0])) as Record<ChannelImpactOutcome, number>
}

function parseVersion(value: string | null | undefined): SemVer | null {
  if (!value)
    return null
  return tryParse(value) ?? null
}

/** Mirrors the strategy, guard, platform and build-type gates of /updates for one device setup. */
export function evaluateDeviceOutcome(
  device: Pick<ChannelImpactDeviceGroup, 'platform' | 'version_build' | 'version_name' | 'plugin_version' | 'is_prod' | 'is_emulator'>,
  channel: ChannelImpactChannelConfig,
  target: ChannelImpactTarget,
): ChannelImpactOutcome {
  const native = parseVersion(device.version_build)
  // /updates refuses a missing or non-semver native build before any channel gate.
  if (!native)
    return 'unknown_native'

  const targetName = target.kind === 'builtin' ? 'builtin' : target.name
  // Already running the bundle: /updates answers "no new version" before the channel gates.
  if (target.kind === 'bundle' && device.version_name === target.name)
    return 'already_on_target'

  if (device.platform === 'ios' && !channel.ios)
    return 'blocked_platform'
  if (device.platform === 'android' && !channel.android)
    return 'blocked_platform'
  if (device.platform === 'electron' && !channel.electron)
    return 'blocked_platform'

  if (target.kind === 'bundle') {
    const bundle = parseVersion(targetName)
    if (bundle) {
      if (channel.disable_auto_update === 'major' && bundle.major > native.major)
        return 'blocked_major'
      if (channel.disable_auto_update === 'minor' && (bundle.major !== native.major || bundle.minor !== native.minor))
        return 'blocked_minor'
      if (channel.disable_auto_update === 'patch' && (bundle.major !== native.major || bundle.minor !== native.minor || bundle.patch !== native.patch))
        return 'blocked_patch'
    }
    if (channel.disable_auto_update === 'version_number') {
      const minUpdate = parseVersion(target.min_update_version)
      if (!minUpdate)
        return 'blocked_misconfigured'
      if (greaterThan(minUpdate, native))
        return 'blocked_metadata'
    }
    if (bundle && channel.disable_auto_update_under_native && lessThan(bundle, native))
      return 'blocked_under_native'
  }

  // Unknown build flags are treated like the plugin defaults (prod, physical device).
  const isProd = device.is_prod ?? true
  const isEmulator = device.is_emulator ?? false
  if (!channel.allow_prod && isProd)
    return 'blocked_build_type'
  if (!channel.allow_dev && !isProd)
    return 'blocked_build_type'
  if (!channel.allow_device && !isEmulator)
    return 'blocked_build_type'
  if (!channel.allow_emulator && isEmulator)
    return 'blocked_build_type'

  if (target.kind === 'builtin') {
    // On the store bundle the plugin reports version_name = version_build.
    if (device.version_name === device.version_build)
      return 'already_on_target'
    const plugin = parseVersion(device.plugin_version)
    const minPlugin = parseVersion(BUILTIN_REVERT_MIN_PLUGIN_VERSION)
    if (!plugin || !minPlugin || !greaterOrEqual(plugin, minPlugin))
      return 'plugin_too_old'
    return 'revert_to_builtin'
  }

  const bundle = parseVersion(targetName)
  if (bundle && lessThan(bundle, native))
    return 'receive_below_native'
  return 'receive'
}

/** Native build a device needs before a strategy-gated bundle can reach it. */
export function computeRequirement(channel: ChannelImpactChannelConfig, target: ChannelImpactTarget): ChannelImpactRequirement | null {
  if (target.kind !== 'bundle')
    return null
  const bundle = parseVersion(target.name)
  switch (channel.disable_auto_update) {
    case 'major':
      return bundle ? { strategy: 'major', native: `${bundle.major}.0.0` } : null
    case 'minor':
      return bundle ? { strategy: 'minor', native: `${bundle.major}.${bundle.minor}.x` } : null
    case 'patch':
      return bundle ? { strategy: 'patch', native: `${bundle.major}.${bundle.minor}.${bundle.patch}` } : null
    case 'version_number':
      return parseVersion(target.min_update_version) ? { strategy: 'metadata', native: target.min_update_version! } : null
    default:
      return null
  }
}

function compareNative(a: string, b: string) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left && right)
    return greaterThan(left, right) ? -1 : lessThan(left, right) ? 1 : 0
  return a.localeCompare(b)
}

interface EvaluatedGroup extends ChannelImpactDeviceGroup {
  outcome: ChannelImpactOutcome
}

/**
 * Pick up to five real devices that show the different things that will
 * happen: the largest setup of each outcome first, then other native builds.
 */
export function pickImpactSamples(groups: EvaluatedGroup[], max = MAX_SAMPLES): ChannelImpactSample[] {
  const ordered = [...groups].filter(group => group.sample_device_id).sort((a, b) => b.device_count - a.device_count)
  const picked: EvaluatedGroup[] = []
  const seenOutcomes = new Set<ChannelImpactOutcome>()
  for (const group of ordered) {
    if (picked.length >= max)
      break
    if (seenOutcomes.has(group.outcome))
      continue
    seenOutcomes.add(group.outcome)
    picked.push(group)
  }
  const setupKey = (group: EvaluatedGroup) => `${group.platform}|${group.version_build}|${group.outcome}`
  const seenSetups = new Set(picked.map(setupKey))
  for (const group of ordered) {
    if (picked.length >= max)
      break
    if (picked.includes(group) || seenSetups.has(setupKey(group)))
      continue
    seenSetups.add(setupKey(group))
    picked.push(group)
  }
  return picked.map(group => ({
    device_id: group.sample_device_id,
    platform: group.platform,
    version_build: group.version_build,
    version_name: group.version_name,
    plugin_version: group.plugin_version,
    is_prod: group.is_prod,
    is_emulator: group.is_emulator,
    last_seen: group.last_seen,
    outcome: group.outcome,
    device_count: group.device_count,
  }))
}

export function summarizeChannelImpact(
  groups: ChannelImpactDeviceGroup[],
  channel: ChannelImpactChannelConfig,
  target: ChannelImpactTarget,
): ChannelImpactSummary {
  const outcomes = emptyOutcomes()
  const evaluated: EvaluatedGroup[] = []
  const natives = new Map<string, { platform: ChannelImpactPlatform, version_build: string, device_count: number, receive: number, byOutcome: Map<ChannelImpactOutcome, number> }>()
  let total = 0
  let receive = 0

  for (const group of groups) {
    const count = Math.max(0, Math.round(group.device_count))
    if (!count)
      continue
    const outcome = evaluateDeviceOutcome(group, channel, target)
    evaluated.push({ ...group, device_count: count, outcome })
    outcomes[outcome] += count
    total += count
    if (isReceivingOutcome(outcome))
      receive += count

    const nativeKey = `${group.platform}|${group.version_build}`
    const native = natives.get(nativeKey) ?? { platform: group.platform, version_build: group.version_build, device_count: 0, receive: 0, byOutcome: new Map() }
    native.device_count += count
    if (isReceivingOutcome(outcome))
      native.receive += count
    native.byOutcome.set(outcome, (native.byOutcome.get(outcome) ?? 0) + count)
    natives.set(nativeKey, native)
  }

  const nativeVersions = [...natives.values()]
    .sort((a, b) => b.device_count - a.device_count || compareNative(a.version_build, b.version_build))
    .slice(0, MAX_NATIVE_VERSIONS)
    .map(native => ({
      platform: native.platform,
      version_build: native.version_build,
      device_count: native.device_count,
      receive: native.receive,
      outcome: [...native.byOutcome.entries()].sort((a, b) => b[1] - a[1])[0][0],
    }))

  return {
    total_devices: total,
    receive,
    outcomes,
    requirement: computeRequirement(channel, target),
    native_versions: nativeVersions,
    samples: pickImpactSamples(evaluated),
  }
}

/** Expected devices in the first wave of a progressive rollout (rounded, never above `receive`). */
export function estimateRolloutReceive(receive: number, percentageBps: number) {
  const bps = Math.min(10000, Math.max(0, Math.round(percentageBps)))
  return Math.min(receive, Math.round((receive * bps) / 10000))
}
