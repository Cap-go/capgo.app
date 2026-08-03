import { parseRange, rangeIntersects } from '@std/semver'

export interface NativePackage {
  name: string
  version: string
  requested_version?: string
  ios_checksum?: string
  android_checksum?: string
}

export type IncompatibilityReason
  = | 'new_plugin'
    | 'removed_plugin'
    | 'version_mismatch'
    | 'requested_version_changed'
    | 'ios_code_changed'
    | 'android_code_changed'
    | 'both_platforms_changed'
    | 'platform_checksum_metadata_changed'

export type PackageStatus = 'added' | 'removed' | 'changed' | 'unchanged'

export interface PackageComparison {
  name: string
  candidateVersion?: string
  baselineVersion?: string
  candidateRequestedVersion?: string
  baselineRequestedVersion?: string
  candidateIosChecksum?: string
  baselineIosChecksum?: string
  candidateAndroidChecksum?: string
  baselineAndroidChecksum?: string
  status: PackageStatus
  compatible: boolean
  reasons: IncompatibilityReason[]
  /**
   * True when iOS and/or Android checksum fields exist on only one side.
   * Common when switching Capgo CLI versions: older CLIs did not record them.
   * Still surfaced as incompatible so a real native bump in the same upload is not hidden;
   * the console warns it may be a CLI false alarm.
   */
  platformChecksumMetadataChanged: boolean
}

export interface CompatibilitySummary {
  compatible: boolean
  incompatibleCount: number
  offenders: string[]
}

export interface DeploymentHistoryEntry {
  id: number
  version_id: number
  deployed_at: string | null
  created_at?: string | null
}

export interface DeploymentPair {
  current: DeploymentHistoryEntry
  previous: DeploymentHistoryEntry
}

const STATUS_ORDER: Record<PackageStatus, number> = {
  changed: 0,
  added: 1,
  removed: 2,
  unchanged: 3,
}

function versionsIntersect(candidate: string, baseline: string): boolean {
  try {
    return rangeIntersects(parseRange(candidate), parseRange(baseline))
  }
  catch {
    return false
  }
}

/** Empty / whitespace checksums are treated as absent (legacy / partial metadata). */
export function hasPlatformChecksum(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Detects CLI metadata shape drift: platform checksums present on only one side.
 * Older Capgo CLIs omitted `ios_checksum` / `android_checksum`; newer ones record them.
 */
export function didPlatformChecksumMetadataChange(
  candidate: NativePackage | undefined,
  baseline: NativePackage | undefined,
): boolean {
  if (!candidate || !baseline)
    return false
  const iosOneSided = hasPlatformChecksum(candidate.ios_checksum) !== hasPlatformChecksum(baseline.ios_checksum)
  const androidOneSided = hasPlatformChecksum(candidate.android_checksum) !== hasPlatformChecksum(baseline.android_checksum)
  return iosOneSided || androidOneSided
}

function getIncompatibilityReasons(
  candidate: NativePackage | undefined,
  baseline: NativePackage | undefined,
): IncompatibilityReason[] {
  if (!candidate)
    return []

  if (!baseline)
    return ['new_plugin']

  const reasons: IncompatibilityReason[] = []

  if (!versionsIntersect(candidate.version, baseline.version))
    reasons.push('version_mismatch')

  if (candidate.requested_version && baseline.requested_version && candidate.requested_version.trim() !== baseline.requested_version.trim())
    reasons.push('requested_version_changed')

  // Compare checksums only when both sides recorded them.
  const iosChanged = hasPlatformChecksum(candidate.ios_checksum) && hasPlatformChecksum(baseline.ios_checksum) && candidate.ios_checksum !== baseline.ios_checksum
  const androidChanged = hasPlatformChecksum(candidate.android_checksum) && hasPlatformChecksum(baseline.android_checksum) && candidate.android_checksum !== baseline.android_checksum

  if (iosChanged && androidChanged)
    reasons.push('both_platforms_changed')
  else if (iosChanged)
    reasons.push('ios_code_changed')
  else if (androidChanged)
    reasons.push('android_code_changed')

  // One-sided iOS/Android checksum fields: still incompatible so we never silently
  // pass a same-version native bump that rode along with a CLI metadata change.
  // The dashboard warns this may be a Capgo CLI false alarm.
  if (didPlatformChecksumMetadataChange(candidate, baseline))
    reasons.push('platform_checksum_metadata_changed')

  return reasons
}

function statusFor(
  candidate: NativePackage | undefined,
  baseline: NativePackage | undefined,
  reasons: readonly IncompatibilityReason[],
): PackageStatus {
  if (candidate && !baseline)
    return 'added'
  if (!candidate && baseline)
    return 'removed'
  if (candidate && baseline && (candidate.version !== baseline.version || reasons.length > 0))
    return 'changed'
  return 'unchanged'
}

function isIncompatibleReason(reason: IncompatibilityReason) {
  return reason !== 'requested_version_changed'
}

export function compareNativePackages(
  candidatePackages: readonly NativePackage[],
  baselinePackages: readonly NativePackage[],
): PackageComparison[] {
  const candidateMap = new Map(candidatePackages.map(pkg => [pkg.name, pkg]))
  const baselineMap = new Map(baselinePackages.map(pkg => [pkg.name, pkg]))
  const names = new Set<string>([...candidateMap.keys(), ...baselineMap.keys()])

  return [...names].map((name): PackageComparison => {
    const candidate = candidateMap.get(name)
    const baseline = baselineMap.get(name)
    const reasons = getIncompatibilityReasons(candidate, baseline)
    return {
      name,
      candidateVersion: candidate?.version,
      baselineVersion: baseline?.version,
      candidateRequestedVersion: candidate?.requested_version,
      baselineRequestedVersion: baseline?.requested_version,
      candidateIosChecksum: candidate?.ios_checksum,
      baselineIosChecksum: baseline?.ios_checksum,
      candidateAndroidChecksum: candidate?.android_checksum,
      baselineAndroidChecksum: baseline?.android_checksum,
      status: statusFor(candidate, baseline, reasons),
      compatible: !reasons.some(isIncompatibleReason),
      reasons,
      platformChecksumMetadataChanged: didPlatformChecksumMetadataChange(candidate, baseline),
    }
  }).sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    return byStatus === 0 ? a.name.localeCompare(b.name) : byStatus
  })
}

export function summarizeBundleCompatibility(comparisons: readonly PackageComparison[]): CompatibilitySummary {
  const offenders = comparisons.filter(entry => !entry.compatible).map(entry => entry.name)
  return {
    compatible: offenders.length === 0,
    incompatibleCount: offenders.length,
    offenders,
  }
}

/** True when any package shows one-sided iOS/Android checksum metadata (CLI shape drift). */
export function hasPlatformChecksumMetadataDrift(comparisons: readonly PackageComparison[]): boolean {
  return comparisons.some(entry => entry.platformChecksumMetadataChanged)
}

export function selectCurrentDeploymentPair(
  deployments: readonly DeploymentHistoryEntry[],
  currentVersionId: number,
): DeploymentPair | undefined {
  const currentIndex = deployments.findIndex(row => row.version_id === currentVersionId)
  if (currentIndex < 0)
    return undefined

  const current = deployments[currentIndex]
  const previous = deployments[currentIndex + 1]
  if (!previous)
    return undefined

  return { current, previous }
}
