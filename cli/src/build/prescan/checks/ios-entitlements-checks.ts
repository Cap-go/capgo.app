// src/build/prescan/checks/ios-entitlements-checks.ts
//
// §2.C — Entitlements / capabilities checks. These resolve the app target's
// configured entitlements file and compare it against the primary app's mapped
// provisioning-profile entitlements, plus pure format checks for
// associated-domains and app-groups. All readers are pure and never throw;
// findings surface only capability KEY names + declared identifiers (no
// credential material — see types.ts Finding doc).
import type { ProfileEntitlements } from '../../mobileprovision-parser'
import type { Finding, PrescanCheck, ScanContext } from '../types'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMobileprovisionDetailedFromBase64 } from '../../mobileprovision-parser'
import { readTextIfExists } from '../gradle'
import { entArray, entBool, entString, readAppEntitlements } from '../ios-entitlements'
import { willUploadToAppStore } from '../upload-intent'
import { plistArrayStrings } from './ios-plist-read'
import { parseProvisioningMap } from './ios-profiles'

function primaryProvisioningProfile(ctx: ScanContext): ReturnType<typeof parseProvisioningMap>[number] | undefined {
  return parseProvisioningMap(ctx).find(profile => profile.bundleId === ctx.appId)
}

const hasPrimaryProfile = (ctx: ScanContext): boolean => primaryProvisioningProfile(ctx) !== undefined
const hasAppEntitlements = (ctx: ScanContext): boolean => readAppEntitlements(ctx.projectDir, ctx.appId) !== null

/**
 * Independent evidence the app actually uses push: the Info.plist declares the
 * `remote-notification` background mode. Used to distinguish a genuine
 * development-vs-app_store push mismatch from the benign default Capacitor
 * `aps-environment=development` leftover that nearly every push-free app carries.
 * Reads only the project Info.plist; never throws.
 */
function appUsesRemoteNotifications(projectDir: string): boolean {
  const p = join(projectDir, 'ios', 'App', 'App', 'Info.plist')
  if (!existsSync(p))
    return false
  try {
    return plistArrayStrings(readFileSync(p, 'utf8'), 'UIBackgroundModes').includes('remote-notification')
  }
  catch {
    return false
  }
}

/** Parse a mapped profile's entitlements; {} when the blob is not a valid profile. */
function profileEntitlementsOf(base64: string): ProfileEntitlements {
  try {
    return parseMobileprovisionDetailedFromBase64(base64).profileEntitlements
  }
  catch {
    return {}
  }
}

// Auto-managed keys the profile always carries / the build pipeline injects.
// aps-environment has its own check (entitlements-aps-environment-vs-mode).
const EXCLUDED_KEYS = new Set([
  'aps-environment',
  'get-task-allow',
  'application-identifier',
])
function isExcludedKey(key: string): boolean {
  return EXCLUDED_KEYS.has(key) || key.endsWith('.team-identifier')
}

// A profile array member that grants every requested member. Profiles store the
// wildcard either as the bare `*`, the unresolved `$(VAR)*` template form, or the
// RESOLVED 10-char-team-prefixed form `<teamid>.*` (e.g. `ABCDE12345.*`) — which is
// what a signed wildcard-App-ID profile actually carries, never the $() variable.
function isWildcardMember(member: string): boolean {
  return member === '*'
    || member === '$(AppIdentifierPrefix)*'
    || /^\$\(\w+\)\*$/.test(member)
    || /^[A-Z0-9]{10}\.\*$/.test(member)
}

// App entitlement array members carry the unresolved Xcode prefix variable
// ($(AppIdentifierPrefix) / $(TeamIdentifierPrefix)), while the profile carries the
// resolved 10-char team prefix. Strip both so the suffixes compare like-for-like.
const APP_PREFIX_VAR_RE = /^\$\((?:AppIdentifierPrefix|TeamIdentifierPrefix)\)/
const RESOLVED_TEAM_PREFIX_RE = /^[A-Z0-9]{10}\./
function entitlementMemberSuffix(member: string): string {
  if (APP_PREFIX_VAR_RE.test(member))
    return member.replace(APP_PREFIX_VAR_RE, '')
  if (RESOLVED_TEAM_PREFIX_RE.test(member))
    return member.replace(RESOLVED_TEAM_PREFIX_RE, '')
  return member
}

/**
 * TOP-LEVEL entitlement keys present in the app entitlements `<dict>`, each
 * tagged with the kind of its sibling value (array vs scalar). When a key's
 * value is a container (`<dict>` / `<array>`), the scan skips past that
 * container's MATCHING close so keys nested inside it are NOT collected —
 * otherwise a nested key would leak into the capability set and feed a false
 * positive into the ERROR-severity entitlements-vs-profile-capability check.
 * Self-closing empty containers (`<dict/>` / `<array/>`) carry no inner keys
 * and need no skip. Pure; never throws.
 */
function appEntitlementKeys(raw: string): { key: string, isArray: boolean }[] {
  const out: { key: string, isArray: boolean }[] = []
  // A key element followed by its value's opening tag (or a self-closing one).
  const keyRe = /<key>([\s\S]*?)<\/key>\s*<(array|string|true|false|dict|integer|real|data|date)(\/)?\s*>/g
  let m = keyRe.exec(raw)
  while (m !== null) {
    const key = m[1].trim()
    const valueTag = m[2]
    const selfClosing = m[3] === '/'
    out.push({ key, isArray: valueTag === 'array' })
    // For a non-empty container value, jump the cursor past its matching close
    // so the next iteration resumes at the following TOP-LEVEL sibling key.
    if (!selfClosing && (valueTag === 'dict' || valueTag === 'array')) {
      const skipTo = matchingClose(raw, valueTag, m.index + m[0].length)
      if (skipTo > keyRe.lastIndex)
        keyRe.lastIndex = skipTo
    }
    m = keyRe.exec(raw)
  }
  return out
}

/**
 * Index just past the `</tag>` that balances the container opened immediately
 * before `from` (one level already open). Falls back to the input length when
 * the container is never closed (malformed), which safely halts the outer scan.
 */
function matchingClose(raw: string, tag: 'dict' | 'array', from: number): number {
  const tagRe = new RegExp(`<${tag}>|</${tag}>`, 'g')
  tagRe.lastIndex = from
  let depth = 1
  for (let t = tagRe.exec(raw); t !== null; t = tagRe.exec(raw)) {
    if (t[0] === `<${tag}>`)
      depth++
    else if (--depth === 0)
      return tagRe.lastIndex
  }
  return raw.length
}

export const entitlementsVsProfileCapability: PrescanCheck = {
  id: 'ios/entitlements-vs-profile-capability',
  platforms: ['ios'],
  appliesTo: ctx => hasPrimaryProfile(ctx) && hasAppEntitlements(ctx),
  async run(ctx): Promise<Finding[]> {
    const app = readAppEntitlements(ctx.projectDir, ctx.appId)
    const profile = primaryProvisioningProfile(ctx)
    if (!app || !profile)
      return []
    const appKeys = appEntitlementKeys(app.raw).filter(k => !isExcludedKey(k.key))
    if (appKeys.length === 0)
      return []

    const findings: Finding[] = []
    for (const { bundleId, base64 } of [profile]) {
      const profileEnt = profileEntitlementsOf(base64)
      for (const { key, isArray } of appKeys) {
        if (isArray) {
          const appMembers = entArray(app.raw, key)
          const profileValue = profileEnt[key]
          const profileMembers = Array.isArray(profileValue)
            ? profileValue
            : typeof profileValue === 'string' ? [profileValue] : []
          if (profileMembers.some(isWildcardMember))
            continue
          // Compare on the prefix-normalized suffix: app members carry the
          // $(AppIdentifierPrefix) variable, profile members the resolved team prefix.
          const profileSuffixes = new Set(profileMembers.map(entitlementMemberSuffix))
          const uncovered = appMembers.filter(member => !profileSuffixes.has(entitlementMemberSuffix(member)))
          if (uncovered.length > 0) {
            findings.push({
              id: 'ios/entitlements-vs-profile-capability',
              severity: 'error',
              title: `Entitlement "${key}" is not fully covered by the provisioning profile for "${bundleId}"`,
              detail: `uncovered ${key} value(s): ${uncovered.join(', ')}`,
              fix: 'Enable the capability for this App ID in the Apple Developer portal, regenerate the profile, and re-save credentials (or remove the unused entitlement)',
            })
          }
        }
        else if (!(key in profileEnt)) {
          findings.push({
            id: 'ios/entitlements-vs-profile-capability',
            severity: 'error',
            title: `Entitlement "${key}" is declared by the app but not granted by the provisioning profile for "${bundleId}"`,
            detail: `missing capability: ${key}`,
            fix: 'Enable the capability for this App ID in the Apple Developer portal, regenerate the profile, and re-save credentials (or remove the unused entitlement)',
          })
        }
      }
    }
    return findings
  },
}

export const apsEnvironmentVsMode: PrescanCheck = {
  id: 'ios/entitlements-aps-environment-vs-mode',
  platforms: ['ios'],
  appliesTo: (ctx) => {
    const app = readAppEntitlements(ctx.projectDir, ctx.appId)
    return app !== null && entString(app.raw, 'aps-environment') !== null && Boolean(ctx.distributionMode)
  },
  async run(ctx): Promise<Finding[]> {
    const app = readAppEntitlements(ctx.projectDir, ctx.appId)
    if (!app)
      return []
    const value = entString(app.raw, 'aps-environment')
    if (value === null)
      return []

    const primaryProfile = primaryProvisioningProfile(ctx)
    const profileValue = primaryProfile
      ? profileEntitlementsOf(primaryProfile.base64)['aps-environment']
      : undefined
    const profileMismatch = typeof profileValue === 'string' && profileValue !== value

    const findings: Finding[] = []
    if (ctx.distributionMode === 'app_store' && value === 'development' && !profileMismatch) {
      // The default Capacitor App.entitlements ships aps-environment=development.
      // On a push-free app this is a benign leftover the cloud builder neither
      // rewrites nor fails the archive on — so it must NOT hard-block an App Store
      // build. Only escalate to a blocking error when there is independent evidence
      // the app genuinely uses push (a remote-notification background mode); the
      // mapped-profile production mismatch is caught separately below as an error.
      const usesPush = appUsesRemoteNotifications(ctx.projectDir)
      findings.push({
        id: 'ios/entitlements-aps-environment-vs-mode',
        severity: usesPush ? 'error' : 'warning',
        title: 'aps-environment is "development" but the build distributes to the App Store / TestFlight',
        detail: usesPush
          ? 'The app declares the remote-notification background mode, so it needs a production push environment for App Store / TestFlight'
          : 'App Store and TestFlight push needs a production environment; this is the default Capacitor leftover and is harmless unless the app uses push notifications',
        fix: 'Set aps-environment=production in App.entitlements and use a production push profile (or remove aps-environment if the app does not use push)',
      })
    }
    else if (ctx.distributionMode === 'ad_hoc' && value === 'production' && !profileMismatch) {
      findings.push({
        id: 'ios/entitlements-aps-environment-vs-mode',
        severity: 'warning',
        title: 'aps-environment is "production" for an ad_hoc build',
        detail: 'ad_hoc builds usually use the development push environment (production is valid but uncommon)',
        fix: 'Use aps-environment=development for ad_hoc unless you intend production APNs',
      })
    }

    // When a provisioning map is present, the profile's aps-environment must agree
    // with the app's declared value.
    if (primaryProfile && profileMismatch) {
      findings.push({
        id: 'ios/entitlements-aps-environment-vs-mode',
        severity: 'error',
        title: `aps-environment differs between App.entitlements and the provisioning profile for "${primaryProfile.bundleId}"`,
        detail: `app: ${value} — profile: ${profileValue}`,
        fix: 'Align aps-environment in App.entitlements with the push profile (or regenerate the profile)',
      })
    }
    return findings
  },
}

// applinks/webcredentials/activitycontinuation/appclips:<domain>[?mode=developer|managed]
const ASSOCIATED_DOMAIN_RE = /^(?:applinks|webcredentials|activitycontinuation|appclips):[a-z0-9.-]+(?:\?mode=(?:developer|managed))?$/i
const ASSOCIATED_DOMAIN_KEY = 'com.apple.developer.associated-domains'

export const associatedDomainsFormat: PrescanCheck = {
  id: 'ios/entitlements-associated-domains-format',
  platforms: ['ios'],
  appliesTo: (ctx) => {
    const app = readAppEntitlements(ctx.projectDir, ctx.appId)
    return app !== null && entArray(app.raw, ASSOCIATED_DOMAIN_KEY).length > 0
  },
  async run(ctx): Promise<Finding[]> {
    const app = readAppEntitlements(ctx.projectDir, ctx.appId)
    if (!app)
      return []
    const bad: string[] = []
    for (const entry of entArray(app.raw, ASSOCIATED_DOMAIN_KEY)) {
      // The managed-wildcard form `service:*` (e.g. applinks:*) is valid.
      if (/^(?:applinks|webcredentials|activitycontinuation|appclips):\*$/i.test(entry))
        continue
      if (!ASSOCIATED_DOMAIN_RE.test(entry))
        bad.push(entry)
    }
    if (bad.length === 0)
      return []
    return [{
      id: 'ios/entitlements-associated-domains-format',
      severity: 'warning',
      title: `${bad.length} associated-domains entr(y/ies) have an invalid format`,
      detail: `invalid: ${bad.join(', ')}`,
      fix: 'Use the "service:domain" form (e.g. applinks:example.com) — no scheme, path, or trailing slash',
    }]
  },
}

const APP_GROUP_KEY = 'com.apple.security.application-groups'
// group.<reverse-dns>: lowercase letters, digits, dots, hyphens; no uppercase/whitespace.
const APP_GROUP_RE = /^group\.[a-z0-9.-]+$/

export const appGroupsFormat: PrescanCheck = {
  id: 'ios/entitlements-app-groups-format',
  platforms: ['ios'],
  appliesTo: (ctx) => {
    const app = readAppEntitlements(ctx.projectDir, ctx.appId)
    return app !== null && entArray(app.raw, APP_GROUP_KEY).length > 0
  },
  async run(ctx): Promise<Finding[]> {
    const app = readAppEntitlements(ctx.projectDir, ctx.appId)
    if (!app)
      return []
    const bad = entArray(app.raw, APP_GROUP_KEY).filter(g => !APP_GROUP_RE.test(g))
    if (bad.length === 0)
      return []
    return [{
      id: 'ios/entitlements-app-groups-format',
      severity: 'warning',
      title: `${bad.length} app group identifier(s) have an invalid format`,
      detail: `invalid: ${bad.join(', ')}`,
      fix: 'Name app groups "group.<reverse-dns>" (lowercase, no whitespace) and register them in the portal',
    }]
  },
}

const AGE_RANGE_PLUGIN = '@capgo/capacitor-age-range'
const DECLARED_AGE_RANGE_KEY = 'com.apple.developer.declared-age-range'

function packageHasDependency(projectDir: string, name: string): boolean {
  const raw = readTextIfExists(join(projectDir, 'package.json'))
  if (raw === null)
    return false
  try {
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>, devDependencies?: Record<string, string> }
    const deps = { ...pkg.devDependencies, ...pkg.dependencies }
    return typeof deps[name] === 'string'
  }
  catch {
    return false
  }
}

export const entitlementsDeclaredAgeRange: PrescanCheck = {
  id: 'ios/entitlements-declared-age-range',
  platforms: ['ios'],
  appliesTo: ctx => packageHasDependency(ctx.projectDir, AGE_RANGE_PLUGIN) && willUploadToAppStore(ctx),
  async run(ctx): Promise<Finding[]> {
    const app = readAppEntitlements(ctx.projectDir, ctx.appId)
    if (app !== null && entBool(app.raw, DECLARED_AGE_RANGE_KEY) === true)
      return []
    return [{
      id: 'ios/entitlements-declared-age-range',
      severity: 'warning',
      title: `${AGE_RANGE_PLUGIN} is installed without the Declared Age Range entitlement`,
      detail: 'iOS 26+ App Store age assurance (Australia, Brazil, Singapore 18+ downloads) requires com.apple.developer.declared-age-range. Missing it, the system dialog fails with "There was an error. Please try later."',
      fix: 'Add com.apple.developer.declared-age-range=<true/> to App.entitlements, enable Declared Age Range on the App ID, and set CODE_SIGN_ENTITLEMENTS.',
    }]
  },
}
