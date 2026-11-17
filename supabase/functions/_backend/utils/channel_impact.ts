import type { SemVer } from '@std/semver'
import { greaterOrEqual, greaterThan, lessThan, tryParse } from '@std/semver'
import { isLegacyChannelSelfStorePluginVersion, usesCurrentEncryptionKeyIdFormat } from './plugin_compatibility.ts'
import { BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7, isDeprecatedPluginVersion } from './utils.ts'

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
export type ChannelImpactUpdatePackage = 'all' | 'zip' | 'delta' | 'zip_from_builtin' | 'delta_from_builtin'

export const CHANNEL_IMPACT_WINDOW_DAYS = 30
/** First plugin version that understands the revert-to-builtin response. */
export const BUILTIN_REVERT_MIN_PLUGIN_VERSION = '6.2.0'
const MAX_SAMPLES = 3
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
  /** Assigned to the channel through channel_devices (console, API or self-assignment), not only reporting it. */
  forced?: boolean
  /** Encryption key id the device reports ('' when none). */
  key_id?: string
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
  /** Private channel without self-assignment: only devices assigned through channel_devices are served. */
  assigned_devices_only: boolean
  /** Download format setting of the channel (zip, delta manifest or both). */
  update_package?: ChannelImpactUpdatePackage | null
}

export type ChannelImpactTarget
  = | { kind: 'bundle', name: string, min_update_version: string | null, key_id?: string | null, has_zip?: boolean }
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
  'blocked_private_channel',
  'blocked_under_native',
  'blocked_platform',
  'blocked_build_type',
  'plugin_too_old',
  'blocked_key_mismatch',
  'blocked_no_bundle',
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
  /** Devices on this native build do not all share `outcome`. */
  mixed: boolean
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

/** Mirrors resolveChannelUpdatePackage in /updates. */
function resolveUpdatePackage(mode: ChannelImpactUpdatePackage | null | undefined, onBuiltin: boolean): 'all' | 'zip' | 'delta' {
  if (mode === 'zip' || mode === 'delta')
    return mode
  if (onBuiltin && mode === 'zip_from_builtin')
    return 'zip'
  if (onBuiltin && mode === 'delta_from_builtin')
    return 'delta'
  return 'all'
}

/**
 * A bundle without a zip (delta-only upload) can only be sent as a delta
 * manifest: /updates answers no_bundle when the channel forces zips or the
 * updater is too old to read manifests.
 */
function canDeliverWithoutZip(device: Pick<ChannelImpactDeviceGroup, 'plugin_version' | 'version_name' | 'version_build'>, channel: ChannelImpactChannelConfig) {
  const plugin = parseVersion(device.plugin_version)
  if (!plugin)
    return true
  const onBuiltin = device.version_name === 'builtin' || device.version_name === device.version_build
  if (resolveUpdatePackage(channel.update_package, onBuiltin) === 'zip')
    return false
  return !isDeprecatedPluginVersion(plugin, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7)
}

type ImpactDevice = Pick<ChannelImpactDeviceGroup, 'platform' | 'version_build' | 'version_name' | 'plugin_version' | 'is_prod' | 'is_emulator' | 'forced' | 'key_id'>

/** What every /updates gate looks at for one device setup and one target. */
interface GateContext {
  device: ImpactDevice
  channel: ChannelImpactChannelConfig
  target: ChannelImpactTarget
  native: SemVer
  plugin: SemVer | null
  /** Semver of the target bundle; null for the store version or a non-semver bundle name. */
  bundle: SemVer | null
}

/** A gate returns the outcome that stops the device, or null to let /updates go on. */
type Gate = (ctx: GateContext) => ChannelImpactOutcome | null

/** Checks /updates runs before the channel config: updater age, delivery format, encryption key, current bundle. */
function deliveryGate({ device, channel, target, plugin }: GateContext): ChannelImpactOutcome | null {
  // /updates rejects every 4.x updater before looking at the channel.
  if (plugin?.major === 4)
    return 'plugin_too_old'
  if (target.kind !== 'bundle')
    return null
  if (target.has_zip === false && !canDeliverWithoutZip(device, channel))
    return 'blocked_no_bundle'
  // /updates refuses an encrypted bundle whose key differs from the device's key
  // (current key id format only) before it even checks whether the device runs it.
  if (target.key_id && device.key_id && device.key_id !== target.key_id && plugin && usesCurrentEncryptionKeyIdFormat(plugin))
    return 'blocked_key_mismatch'
  // Already running the bundle: /updates answers "no new version" before the channel gates.
  return device.version_name === target.name ? 'already_on_target' : null
}

function platformGate({ device, channel }: GateContext): ChannelImpactOutcome | null {
  const enabled: Partial<Record<ChannelImpactPlatform, boolean>> = { ios: channel.ios, android: channel.android, electron: channel.electron }
  const platformEnabled = enabled[device.platform]
  // Devices of an unknown platform pass: /updates has no switch for them.
  return platformEnabled === undefined || platformEnabled ? null : 'blocked_platform'
}

/** The major strategy runs before the private-channel gate in /updates. */
function majorGate({ channel, native, bundle }: GateContext): ChannelImpactOutcome | null {
  return bundle && channel.disable_auto_update === 'major' && bundle.major > native.major ? 'blocked_major' : null
}

function privateChannelGate({ device, channel }: GateContext): ChannelImpactOutcome | null {
  // A private channel without self-assignment only serves devices assigned to it;
  // devices that merely report it get cannot_update_via_private_channel.
  return channel.assigned_devices_only && !device.forced ? 'blocked_private_channel' : null
}

function minorPatchGate({ channel, native, bundle }: GateContext): ChannelImpactOutcome | null {
  if (!bundle)
    return null
  const sameMinor = bundle.major === native.major && bundle.minor === native.minor
  if (channel.disable_auto_update === 'minor' && !sameMinor)
    return 'blocked_minor'
  if (channel.disable_auto_update === 'patch' && !(sameMinor && bundle.patch === native.patch))
    return 'blocked_patch'
  return null
}

function metadataGate({ channel, target, native }: GateContext): ChannelImpactOutcome | null {
  if (target.kind !== 'bundle' || channel.disable_auto_update !== 'version_number')
    return null
  const minUpdate = parseVersion(target.min_update_version)
  if (!minUpdate)
    return 'blocked_misconfigured'
  return greaterThan(minUpdate, native) ? 'blocked_metadata' : null
}

function underNativeGate({ channel, native, bundle }: GateContext): ChannelImpactOutcome | null {
  return bundle && channel.disable_auto_update_under_native && lessThan(bundle, native) ? 'blocked_under_native' : null
}

function buildTypeGate({ device, channel }: GateContext): ChannelImpactOutcome | null {
  // Unknown build flags are treated like the plugin defaults (prod, physical device).
  const buildAllowed = (device.is_prod ?? true) ? channel.allow_prod : channel.allow_dev
  const hardwareAllowed = (device.is_emulator ?? false) ? channel.allow_emulator : channel.allow_device
  return buildAllowed && hardwareAllowed ? null : 'blocked_build_type'
}

/** The /updates gates, in the order /updates applies them (plugin_runtime/utils/update.ts). */
const UPDATE_GATES: readonly Gate[] = [
  deliveryGate,
  platformGate,
  majorGate,
  privateChannelGate,
  minorPatchGate,
  metadataGate,
  underNativeGate,
  buildTypeGate,
]

/** What a device that passed every gate gets. */
function passedOutcome({ device, target, native, plugin, bundle }: GateContext): ChannelImpactOutcome {
  if (target.kind === 'bundle')
    return bundle && lessThan(bundle, native) ? 'receive_below_native' : 'receive'
  // On the store bundle the plugin reports version_name = version_build.
  if (device.version_name === device.version_build)
    return 'already_on_target'
  const minPlugin = parseVersion(BUILTIN_REVERT_MIN_PLUGIN_VERSION)
  if (!plugin || !minPlugin || !greaterOrEqual(plugin, minPlugin))
    return 'plugin_too_old'
  return 'revert_to_builtin'
}

/** Mirrors the strategy, guard, platform and build-type gates of /updates for one device setup. */
export function evaluateDeviceOutcome(
  device: ImpactDevice,
  channel: ChannelImpactChannelConfig,
  target: ChannelImpactTarget,
): ChannelImpactOutcome {
  const native = parseVersion(device.version_build)
  // /updates refuses a missing or non-semver native build before any channel gate.
  if (!native)
    return 'unknown_native'
  const ctx: GateContext = {
    device,
    channel,
    target,
    native,
    plugin: parseVersion(device.plugin_version),
    bundle: target.kind === 'bundle' ? parseVersion(target.name) : null,
  }
  for (const gate of UPDATE_GATES) {
    const outcome = gate(ctx)
    if (outcome)
      return outcome
  }
  return passedOutcome(ctx)
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
  if (!left || !right)
    return a.localeCompare(b)
  if (greaterThan(left, right))
    return -1
  if (lessThan(left, right))
    return 1
  return 0
}

interface EvaluatedGroup extends ChannelImpactDeviceGroup {
  outcome: ChannelImpactOutcome
}

/**
 * Pick up to three real devices that explain the change: the largest setup
 * that gets it, the largest that does not (the main reason others won't),
 * then the largest setup with yet another outcome.
 */
export function pickImpactSamples(groups: EvaluatedGroup[], max = MAX_SAMPLES): ChannelImpactSample[] {
  const ordered = [...groups].filter(group => group.sample_device_id).sort((a, b) => b.device_count - a.device_count)
  const picked: EvaluatedGroup[] = []
  const take = (group: EvaluatedGroup | undefined) => {
    if (group && picked.length < max && !picked.includes(group))
      picked.push(group)
  }
  take(ordered.find(group => isReceivingOutcome(group.outcome)))
  take(ordered.find(group => !isReceivingOutcome(group.outcome) && group.outcome !== 'already_on_target'))
  for (const group of ordered) {
    if (!picked.some(item => item.outcome === group.outcome))
      take(group)
  }
  // Fewer distinct outcomes than slots: show other store builds.
  for (const group of ordered) {
    if (!picked.some(item => item.platform === group.platform && item.version_build === group.version_build))
      take(group)
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
      mixed: native.byOutcome.size > 1,
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

/**
 * Devices whose updater keeps self-assigned channels in the legacy server-side
 * store (old plugins) instead of channel_devices. That store cannot be read per
 * device here, so when the app lets devices pick a channel their real channel
 * is unknown and the preview is an estimate.
 */
export function countLegacySelfAssignmentDevices(groups: ChannelImpactDeviceGroup[]) {
  return groups.reduce((sum, group) => sum + (isLegacyChannelSelfStorePluginVersion(group.plugin_version) ? Math.max(0, Math.round(group.device_count)) : 0), 0)
}

/** Expected devices in the first wave of a progressive rollout (rounded, never above `receive`). */
export function estimateRolloutReceive(receive: number, percentageBps: number) {
  const bps = Math.min(10000, Math.max(0, Math.round(percentageBps)))
  return Math.min(receive, Math.round((receive * bps) / 10000))
}
