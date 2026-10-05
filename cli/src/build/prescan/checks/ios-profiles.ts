// src/build/prescan/checks/ios-profiles.ts
import type { MobileprovisionDetail } from '../../mobileprovision-parser'
import type { Finding, PrescanCheck, ScanContext } from '../types'
import { analyzeProvisioningCoverage, parseProvisioningMap as parseStoredProvisioningMap, wildcardBundleMatches } from '../../ios-provisioning-map'
import { parseMobileprovisionDetailedFromBase64 } from '../../mobileprovision-parser'
import { openP12 } from './ios-certs'

/**
 * One entry of CAPGO_IOS_PROVISIONING_MAP. The serialized shape (produced by
 * buildProvisioningMap in src/build/credentials-command.ts) is
 * `{ [bundleId]: { profile: base64, name: string } }` — keyed by the bundle id
 * the profile is assigned to cover.
 */
export interface MappedProfile {
  /** bundle id this profile is assigned to cover */
  bundleId: string
  /** base64-encoded .mobileprovision content */
  base64: string
  /** profile display name extracted at save time */
  name?: string
}

export function parseProvisioningMap(ctx: ScanContext): MappedProfile[] {
  const raw = ctx.credentials?.CAPGO_IOS_PROVISIONING_MAP
  if (!raw)
    return []
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (!obj || typeof obj !== 'object' || Array.isArray(obj))
      return []
    const entries: MappedProfile[] = []
    for (const [bundleId, value] of Object.entries(obj)) {
      if (typeof value === 'string')
        entries.push({ bundleId, base64: value })
      else if (value && typeof value === 'object' && typeof (value as { profile?: unknown }).profile === 'string') {
        const entry = value as { profile: string, name?: string }
        entries.push({ bundleId, base64: entry.profile, name: entry.name })
      }
    }
    return entries
  }
  catch {
    return []
  }
}

/** Parse a profile's embedded plist; null when the blob is not a valid mobileprovision. */
function tryParseDetail(base64: string): MobileprovisionDetail | null {
  try {
    return parseMobileprovisionDetailedFromBase64(base64)
  }
  catch {
    return null
  }
}

const THIRTY_DAYS_MS = 30 * 86_400_000
const hasMap = (ctx: ScanContext) => parseProvisioningMap(ctx).length > 0

export const profileExpiry: PrescanCheck = {
  id: 'ios/profile-expiry',
  platforms: ['ios'],
  appliesTo: hasMap,
  async run(ctx): Promise<Finding[]> {
    const findings: Finding[] = []
    for (const { bundleId, base64 } of parseProvisioningMap(ctx)) {
      const detail = tryParseDetail(base64)
      if (!detail?.expirationDate)
        continue
      const left = new Date(detail.expirationDate).getTime() - Date.now()
      if (left <= 0) {
        findings.push({
          id: 'ios/profile-expiry',
          severity: 'error',
          title: `Provisioning profile for "${bundleId}" expired on ${detail.expirationDate.slice(0, 10)}`,
          fix: 'Regenerate the profile in the Apple Developer portal and re-save credentials',
        })
      }
      else if (left < THIRTY_DAYS_MS) {
        findings.push({
          id: 'ios/profile-expiry',
          severity: 'warning',
          title: `Provisioning profile for "${bundleId}" expires in ${Math.ceil(left / 86_400_000)} day(s)`,
        })
      }
    }
    return findings
  },
}

function bundleMatches(profileBundleId: string, appBundleId: string): boolean {
  return profileBundleId === appBundleId || wildcardBundleMatches(profileBundleId, appBundleId)
}

export const profileBundleMatch: PrescanCheck = {
  id: 'ios/profile-bundle-match',
  platforms: ['ios'],
  appliesTo: hasMap,
  async run(ctx): Promise<Finding[]> {
    const findings: Finding[] = []
    for (const { bundleId, base64 } of parseProvisioningMap(ctx)) {
      const info = tryParseDetail(base64)
      if (info?.bundleId && !bundleMatches(info.bundleId, bundleId)) {
        findings.push({
          id: 'ios/profile-bundle-match',
          severity: 'error',
          title: `Provisioning profile mapped to "${bundleId}" is for a different bundle id`,
          detail: `profile: ${info.bundleId} — assigned to: ${bundleId}`,
          fix: 'Use a profile generated for this bundle id (or a wildcard profile)',
        })
      }
    }
    return findings
  },
}

export const profileTypeVsMode: PrescanCheck = {
  id: 'ios/profile-type-vs-mode',
  platforms: ['ios'],
  appliesTo: ctx => hasMap(ctx) && Boolean(ctx.distributionMode),
  async run(ctx): Promise<Finding[]> {
    const findings: Finding[] = []
    for (const { bundleId, base64 } of parseProvisioningMap(ctx)) {
      const detail = tryParseDetail(base64)
      if (!detail || detail.profileType === 'unknown')
        continue
      if (detail.profileType !== ctx.distributionMode) {
        findings.push({
          id: 'ios/profile-type-vs-mode',
          severity: 'error',
          title: `Profile for "${bundleId}" is ${detail.profileType} but the build requests ${ctx.distributionMode}`,
          fix: ctx.distributionMode === 'app_store'
            ? 'Generate an App Store distribution profile, or build with --ios-distribution ad_hoc'
            : 'Generate an Ad Hoc profile, or switch --ios-distribution',
        })
      }
    }
    return findings
  },
}

export const certProfilePairing: PrescanCheck = {
  id: 'ios/cert-profile-pairing',
  platforms: ['ios'],
  appliesTo: ctx => hasMap(ctx) && Boolean(ctx.credentials?.BUILD_CERTIFICATE_BASE64),
  async run(ctx): Promise<Finding[]> {
    let sha1: string
    try {
      sha1 = openP12(ctx.credentials!.BUILD_CERTIFICATE_BASE64, ctx.credentials!.P12_PASSWORD ?? '').sha1
    }
    catch {
      return [] // ios/p12-opens owns that failure
    }
    const findings: Finding[] = []
    for (const { bundleId, base64 } of parseProvisioningMap(ctx)) {
      const detail = tryParseDetail(base64)
      if (!detail || detail.certificateSha1s.length === 0)
        continue
      if (!detail.certificateSha1s.includes(sha1)) {
        findings.push({
          id: 'ios/cert-profile-pairing',
          severity: 'error',
          title: `Your signing certificate is not included in the provisioning profile for "${bundleId}"`,
          detail: `cert sha1 ${sha1} not in [${detail.certificateSha1s.join(', ')}]`,
          fix: 'Regenerate the profile selecting this distribution certificate, then re-save credentials',
        })
      }
    }
    return findings
  },
}

export const targetsCovered: PrescanCheck = {
  id: 'ios/targets-covered',
  platforms: ['ios'],
  appliesTo: ctx => ctx.credentials?.CAPGO_IOS_PROVISIONING_MAP !== undefined,
  async run(ctx): Promise<Finding[]> {
    let map
    try {
      map = parseStoredProvisioningMap(ctx.credentials?.CAPGO_IOS_PROVISIONING_MAP)
    }
    catch (error) {
      return [{
        id: 'ios/targets-covered',
        severity: 'error',
        title: 'Saved iOS provisioning profile map cannot be used',
        detail: error instanceof Error ? error.message : 'The saved provisioning profile map is invalid',
        fix: 'Save or update the iOS provisioning profile map before building',
      }]
    }
    const { findSignableTargets, readPbxproj } = await import('../../pbxproj-parser')
    const pbx = readPbxproj(ctx.projectDir)
    if (!pbx)
      return []
    const targets = findSignableTargets(pbx)
    const coverage = analyzeProvisioningCoverage(targets, map)
    const wildcardOwned = new Set([
      ...(coverage.wildcardReuse?.targets ?? []),
      ...coverage.wildcardConflict,
    ].map(target => target.bundleId))
    const missing = coverage.missing.filter(target => !wildcardOwned.has(target.bundleId))
    if (missing.length === 0)
      return []
    const missingCount = missing.reduce((count, target) => count + target.targetNames.length, 0)
    const hasMultipleTargets = targets.filter(target => target.bundleId).length > 1
    return [{
      id: 'ios/targets-covered',
      severity: 'error',
      title: `${missingCount} signable target(s) have no provisioning profile mapped`,
      detail: `uncovered: ${missing.flatMap(target => target.targetNames.map(name => `${name} (${target.bundleId})`)).join(', ')}`,
      fix: hasMultipleTargets
        ? 'Run npx @capgo/cli@latest build credentials ios-provisioning to set up every target'
        : 'Add --ios-provisioning-profile "bundleId=/path/to/profile.mobileprovision" and re-save credentials',
    }]
  },
}

export const wildcardProfileTargets: PrescanCheck = {
  id: 'ios/wildcard-profile-targets',
  platforms: ['ios'],
  appliesTo: ctx => ctx.credentials?.CAPGO_IOS_PROVISIONING_MAP !== undefined,
  async run(ctx): Promise<Finding[]> {
    let map
    try {
      map = parseStoredProvisioningMap(ctx.credentials?.CAPGO_IOS_PROVISIONING_MAP)
    }
    catch {
      return [] // ios/targets-covered owns malformed and invalid saved maps
    }
    const { findSignableTargets, readPbxproj } = await import('../../pbxproj-parser')
    const pbx = readPbxproj(ctx.projectDir)
    if (!pbx)
      return []
    const coverage = analyzeProvisioningCoverage(findSignableTargets(pbx), map)
    if (coverage.wildcardConflict.length > 0) {
      return [{
        id: 'ios/wildcard-profile-targets',
        severity: 'error',
        title: 'Sorry, multiple matching wildcard provisioning profiles are not supported',
        detail: `targets: ${coverage.wildcardConflict.map(target => `${target.targetNames.join('/')} (${target.bundleId})`).join(', ')}`,
        fix: 'Remove or replace the conflicting wildcard profiles in the saved map, then retry',
      }]
    }
    if (!coverage.wildcardReuse)
      return []
    return [{
      id: 'ios/wildcard-profile-targets',
      severity: 'error',
      title: `${coverage.wildcardReuse.targets.length} target bundle id(s) can reuse a saved wildcard provisioning profile`,
      detail: `targets: ${coverage.wildcardReuse.targets.map(target => `${target.targetNames.join('/')} (${target.bundleId})`).join(', ')}`,
      fix: 'Run npx @capgo/cli@latest build credentials ios-provisioning to confirm and update the map',
    }]
  },
}
