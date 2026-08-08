import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export interface MobileprovisionInfo {
  name: string
  uuid: string
  applicationIdentifier: string
  bundleId: string
}

/**
 * Detail returned by {@link parseMobileprovisionDetailed} — extends
 * {@link MobileprovisionInfo} with team/expiry/profile-type metadata and the
 * SHA1 of each developer certificate embedded in the profile.
 *
 * The SHA1 list enables matching a profile against a Keychain identity
 * returned by `security find-identity` (which reports identities by the same
 * SHA1 hash).
 */
export interface MobileprovisionDetail extends MobileprovisionInfo {
  /** Apple Team ID (10-char alphanumeric) — empty string if not present */
  teamId: string
  /** ISO timestamp string from the profile's ExpirationDate, or empty string */
  expirationDate: string
  /** High-level profile type derived from the profile's flags */
  profileType: 'app_store' | 'ad_hoc' | 'development' | 'enterprise' | 'unknown'
  /** SHA1 (40-char lowercase hex) of each DeveloperCertificate embedded in the profile */
  certificateSha1s: string[]
  /**
   * The capability-bearing keys parsed from the profile's `<key>Entitlements</key>`
   * dict, keyed by entitlement name. String/bool entitlements map to their value;
   * array entitlements (application-groups, associated-domains, keychain-access-groups,
   * iCloud container ids, etc.) map to the list of `<string>` members. Only keys
   * actually present in the profile are included, so a caller can both test
   * presence (`key in profileEntitlements`) and read the granted value/members.
   * No credential material is included — these are capability KEY names + their
   * declared identifiers, the same data the entitlement-coverage checks surface.
   */
  profileEntitlements: ProfileEntitlements
}

export type ProfileEntitlementValue = string | string[] | boolean
export type ProfileEntitlements = Record<string, ProfileEntitlementValue>

export function parseMobileprovision(filePath: string): MobileprovisionInfo {
  const data = readFileSync(filePath)
  return parseMobileprovisionBuffer(data, filePath)
}

export function parseMobileprovisionFromBase64(base64Content: string): MobileprovisionInfo {
  const data = Buffer.from(base64Content, 'base64')
  return parseMobileprovisionBuffer(data, '<base64 input>')
}

/**
 * Parse a mobileprovision file and return enriched metadata including:
 *   - team ID
 *   - expiration date
 *   - profile type (app_store / ad_hoc / development / enterprise)
 *   - SHA1 of each embedded developer certificate (used for cert↔profile matching)
 */
export function parseMobileprovisionDetailed(filePath: string): MobileprovisionDetail {
  const data = readFileSync(filePath)
  return parseMobileprovisionBufferDetailed(data, filePath)
}

/** Base64 variant of {@link parseMobileprovisionDetailed} (profiles stored in CAPGO_IOS_PROVISIONING_MAP). */
export function parseMobileprovisionDetailedFromBase64(base64Content: string): MobileprovisionDetail {
  const data = Buffer.from(base64Content, 'base64')
  return parseMobileprovisionBufferDetailed(data, '<base64 input>')
}

function parseMobileprovisionBuffer(data: Buffer, source: string): MobileprovisionInfo {
  const xmlStartMarker = '<?xml'
  const xmlEndMarker = '</plist>'
  const xmlStartIdx = data.indexOf(xmlStartMarker)
  const xmlEndIdx = xmlStartIdx !== -1 ? data.indexOf(xmlEndMarker, xmlStartIdx) : -1

  if (xmlStartIdx === -1 || xmlEndIdx === -1 || xmlEndIdx <= xmlStartIdx) {
    throw new Error(`No embedded plist found in mobileprovision file: ${source}`)
  }

  const plistXml = data.slice(xmlStartIdx, xmlEndIdx + xmlEndMarker.length).toString('utf-8')

  const name = extractPlistValue(plistXml, 'Name')
  if (!name) {
    throw new Error(`Mobileprovision file missing required 'Name' key: ${source}`)
  }

  const uuid = extractPlistValue(plistXml, 'UUID') || ''
  const applicationIdentifier = extractNestedPlistValue(plistXml, 'Entitlements', 'application-identifier') || ''

  const dotIndex = applicationIdentifier.indexOf('.')
  const bundleId = dotIndex !== -1 ? applicationIdentifier.slice(dotIndex + 1) : applicationIdentifier

  return { name, uuid, applicationIdentifier, bundleId }
}

/**
 * Buffer-based variant of {@link parseMobileprovisionDetailed} — parses the raw
 * .mobileprovision bytes directly instead of reading a path. Used by the iOS
 * onboarding engine's import-provide-profile-path effect, which reads the file
 * via its injected `readFile` dep (so the IO stays at the boundary) and parses
 * the returned Buffer here. `source` is a label used only in error messages.
 */
export function parseMobileprovisionBufferDetailed(data: Buffer, source = '<buffer input>'): MobileprovisionDetail {
  const base = parseMobileprovisionBuffer(data, source)

  const xmlStartMarker = '<?xml'
  const xmlEndMarker = '</plist>'
  const xmlStartIdx = data.indexOf(xmlStartMarker)
  const xmlEndIdx = data.indexOf(xmlEndMarker, xmlStartIdx)
  const plistXml = data.slice(xmlStartIdx, xmlEndIdx + xmlEndMarker.length).toString('utf-8')

  const teamId = extractTeamIdFromPlist(plistXml)
  const expirationDate = extractPlistValue(plistXml, 'ExpirationDate', 'date') || ''
  const profileType = deriveProfileType(plistXml)
  const certificateSha1s = extractCertificateSha1s(plistXml)
  const profileEntitlements = extractProfileEntitlements(plistXml)

  return {
    ...base,
    teamId,
    expirationDate,
    profileType,
    certificateSha1s,
    profileEntitlements,
  }
}

/**
 * TeamIdentifier is an array; we take the first entry. Falls back to empty
 * string if TeamIdentifier is missing.
 */
function extractTeamIdFromPlist(xml: string): string {
  const arrayMatch = xml.match(/<key>TeamIdentifier<\/key>\s*<array>([\s\S]*?)<\/array>/)
  if (arrayMatch) {
    const stringMatch = arrayMatch[1].match(/<string>([^<]+)<\/string>/)
    if (stringMatch)
      return stringMatch[1]
  }
  return ''
}

/**
 * Derive profile type from plist flags:
 *   - ProvisionsAllDevices=true → enterprise
 *   - ProvisionedDevices present + get-task-allow=true → development
 *   - ProvisionedDevices present (no get-task-allow) → ad_hoc
 *   - else → app_store
 */
function deriveProfileType(xml: string): MobileprovisionDetail['profileType'] {
  const provisionsAllDevices = /<key>ProvisionsAllDevices<\/key>\s*<true\s*\/>/.test(xml)
  if (provisionsAllDevices)
    return 'enterprise'

  const hasProvisionedDevices = /<key>ProvisionedDevices<\/key>\s*<array>/.test(xml)
  // get-task-allow=true inside Entitlements is the dev indicator
  const hasGetTaskAllowTrue = /<key>get-task-allow<\/key>\s*<true\s*\/>/.test(xml)

  if (hasProvisionedDevices) {
    if (hasGetTaskAllowTrue)
      return 'development'
    return 'ad_hoc'
  }

  return 'app_store'
}

/**
 * Extract SHA1 of every DeveloperCertificate in the profile.
 * The plist stores certs as base64-encoded DER inside a <data> element.
 *
 * SECURITY NOTE on SHA1: this is NOT a security primitive. macOS itself
 * reports code-signing identities as cert-DER SHA1 (via `security
 * find-identity`), and we have to use the same hash to match a profile's
 * embedded certs against a Keychain identity. SHA1 here is a non-secret
 * identifier, not a message digest protecting any data. CodeQL's "weak
 * cryptographic algorithm" rule is suppressed for this reason.
 */
function extractCertificateSha1s(xml: string): string[] {
  const arrayMatch = xml.match(/<key>DeveloperCertificates<\/key>\s*<array>([\s\S]*?)<\/array>/)
  if (!arrayMatch)
    return []

  const sha1s: string[] = []
  for (const match of arrayMatch[1].matchAll(/<data>([\s\S]*?)<\/data>/g)) {
    const base64 = match[1].replace(/\s+/g, '')
    if (!base64)
      continue
    try {
      const der = Buffer.from(base64, 'base64')
      // lgtm[js/weak-cryptographic-algorithm] SHA1 required for compatibility
      // with `security find-identity` output — see comment above.
      const sha1 = createHash('sha1').update(der).digest('hex').toLowerCase()
      sha1s.push(sha1)
    }
    catch {
      // Skip malformed entries silently — partial matches are still useful
    }
  }
  return sha1s
}

// Auto-managed entitlement keys the profile always carries; never surfaced as
// capabilities (the coverage checks exclude the same set on the app side).
function isAutoManagedEntitlementKey(key: string): boolean {
  return key === 'application-identifier' || key.endsWith('.team-identifier')
}

/** `<string>` children of `<array>...</array>` block text. */
function arrayStringMembers(arrayXml: string): string[] {
  return Array.from(arrayXml.matchAll(/<string>([\s\S]*?)<\/string>/g), m => m[1].trim())
}

/**
 * Parse the capability keys from the profile's first `<key>Entitlements</key>`
 * dict (one-level capture, mirroring extractNestedPlistValue). EVERY key present
 * in the dict is read generically by its sibling value tag (string / bool / array),
 * so the profile side is symmetric with the app side — a granted capability outside
 * any fixed allowlist is recorded, not silently treated as "missing" (which would
 * false-positive in the entitlements-vs-profile coverage check). Auto-managed keys
 * (application-identifier, *.team-identifier) are skipped. Only keys actually present
 * are added, so a missing capability is absent (not a false value). Never throws —
 * returns {} when there is no Entitlements dict.
 */
function extractProfileEntitlements(xml: string): ProfileEntitlements {
  const dict = xml.match(/<key>Entitlements<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1]
  if (dict === undefined)
    return {}
  const out: ProfileEntitlements = {}
  // Each <key>K</key> followed by its value: a self-closing <true/>/<false/>, an
  // <array>...</array> (non-greedy, first close wins), or a scalar <tag>V</tag>.
  const re = /<key>([\s\S]*?)<\/key>\s*(?:<(true|false)\s*\/>|<array>([\s\S]*?)<\/array>|<([a-z]+)>([\s\S]*?)<\/\4>)/g
  for (const m of dict.matchAll(re)) {
    const key = m[1].trim()
    if (key in out || isAutoManagedEntitlementKey(key))
      continue
    if (m[2] !== undefined)
      out[key] = m[2] === 'true'
    else if (m[3] !== undefined)
      out[key] = arrayStringMembers(m[3])
    else if (m[4] === 'string')
      out[key] = m[5].trim()
    // Other scalar kinds (integer/real/date/data) are not capability-bearing and
    // are intentionally not surfaced; their presence is still implied by the key.
    else
      out[key] = m[5].trim()
  }
  return out
}

function extractPlistValue(xml: string, key: string, valueTag: string = 'string'): string | null {
  const tag = escapeRegex(valueTag)
  const regex = new RegExp(`<key>${escapeRegex(key)}</key>\\s*<${tag}>([^<]*)</${tag}>`)
  const match = xml.match(regex)
  return match ? match[1] : null
}

function extractNestedPlistValue(xml: string, dictKey: string, valueKey: string): string | null {
  const dictKeyRegex = new RegExp(`<key>${escapeRegex(dictKey)}</key>\\s*<dict>([\\s\\S]*?)</dict>`)
  const dictMatch = xml.match(dictKeyRegex)
  if (!dictMatch)
    return null
  return extractPlistValue(dictMatch[1], valueKey)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
