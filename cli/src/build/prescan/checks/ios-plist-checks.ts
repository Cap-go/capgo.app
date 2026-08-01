// src/build/prescan/checks/ios-plist-checks.ts
//
// §2.A Info.plist / App Store checks. All local (read only project files), all
// gated on the Capacitor Info.plist existing at ios/App/App/Info.plist. Every
// value-format check pipes the plist value through resolvePlistValue first, so a
// `$(VAR)` build-variable reference is substituted from the pbxproj (the single
// biggest false-positive guard) — and a still-unresolved `$()` is treated as
// "skip / cannot judge", never a finding.
//
// Finding.id is always the check id (findings never invent per-finding ids).
// detail/title/fix are printed and serialized to --json: these checks read only
// non-credential project files, so no credential material can leak.
import type { Finding, PrescanCheck, ScanContext } from '../types'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPbxproj } from '../../pbxproj-parser'
import { readBuildSetting, resolvePlistValue } from '../ios-pbxsettings'
import { willUploadToAppStore } from '../upload-intent'
import {
  plistArrayStrings,
  plistBool,
  plistDictBlock,
  plistHasKey,
  plistString,
} from './ios-plist-read'

const INFO_PLIST_REL = ['ios', 'App', 'App', 'Info.plist']

/** The Capacitor Info.plist path, or null when it is absent (non-standard layout). */
function infoPlistPath(projectDir: string): string | null {
  const p = join(projectDir, ...INFO_PLIST_REL)
  return existsSync(p) ? p : null
}

/** Read the Info.plist text, or null when absent / unreadable (never throws). */
function readInfoPlist(projectDir: string): string | null {
  const p = infoPlistPath(projectDir)
  if (!p)
    return null
  try {
    return readFileSync(p, 'utf8')
  }
  catch {
    return null
  }
}

/** pbxproj text for the project, or '' when none — '' makes every $() unresolvable (=> skip). */
function pbx(projectDir: string): string {
  return readPbxproj(projectDir) ?? ''
}

const hasInfoPlist = (ctx: ScanContext) => infoPlistPath(ctx.projectDir) !== null

/** A clean `$(VAR)` / `${VAR}` reference that resolvePlistValue could not resolve. */
function isUnresolvedRef(value: string): boolean {
  return value.startsWith('$(') || value.startsWith('${')
}

/**
 * `ctx.config.server` is reachable through the schema's `.passthrough()` but is
 * typed `unknown`, so read its dev-server signals defensively. Returns whether a
 * live dev server (cleartext flag or a configured url) is still wired in.
 */
function hasDevServerConfig(ctx: ScanContext): boolean {
  const server = (ctx.config as { server?: unknown } | undefined)?.server
  if (server === null || typeof server !== 'object')
    return false
  const s = server as { url?: unknown, cleartext?: unknown }
  return s.cleartext === true || (typeof s.url === 'string' && s.url.length > 0)
}

const MARKETING_VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/
const BUILD_VERSION_RE = /^\d+(?:\.\d+){0,2}$/
// Reverse-DNS, >=2 segments, no space/underscore/wildcard.
const BUNDLE_ID_RE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+$/i

const ORIENTATIONS = [
  'UIInterfaceOrientationPortrait',
  'UIInterfaceOrientationPortraitUpsideDown',
  'UIInterfaceOrientationLandscapeLeft',
  'UIInterfaceOrientationLandscapeRight',
]
const ORIENTATION_SET = new Set(ORIENTATIONS)

const BACKGROUND_MODES = new Set([
  'audio',
  'location',
  'voip',
  'fetch',
  'remote-notification',
  'processing',
  'bluetooth-central',
  'bluetooth-peripheral',
  'external-accessory',
  'newsstand-content',
])

export const plistBundleIdFormat: PrescanCheck = {
  id: 'ios/plist-bundle-id-format',
  platforms: ['ios'],
  appliesTo: hasInfoPlist,
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    const v = plistString(raw, 'CFBundleIdentifier')
    if (v === null) {
      return [{
        id: 'ios/plist-bundle-id-format',
        severity: 'error',
        title: 'Info.plist has no CFBundleIdentifier',
        fix: 'Set a valid reverse-DNS PRODUCT_BUNDLE_IDENTIFIER (no spaces, underscores, or wildcards).',
      }]
    }
    const r = resolvePlistValue(v, pbx(ctx.projectDir))
    if (isUnresolvedRef(r))
      return [] // build-variable with no pbxproj match — cannot judge
    if (!BUNDLE_ID_RE.test(r)) {
      return [{
        id: 'ios/plist-bundle-id-format',
        severity: 'error',
        title: `Invalid bundle identifier "${r}"`,
        detail: 'Bundle ids must be reverse-DNS (≥2 dot-separated segments) with no spaces, underscores, or wildcards.',
        fix: 'Set a valid reverse-DNS PRODUCT_BUNDLE_IDENTIFIER (no spaces, underscores, or wildcards).',
      }]
    }
    return []
  },
}

export const plistVersionShortFormat: PrescanCheck = {
  id: 'ios/plist-version-short-format',
  platforms: ['ios'],
  appliesTo: hasInfoPlist,
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    const v = plistString(raw, 'CFBundleShortVersionString')
    if (v === null)
      return [] // presence owned by ios/infoplist-sanity (see spec §5)
    const r = resolvePlistValue(v, pbx(ctx.projectDir))
    if (isUnresolvedRef(r))
      return []
    if (!MARKETING_VERSION_RE.test(r)) {
      return [{
        id: 'ios/plist-version-short-format',
        severity: 'error',
        title: `CFBundleShortVersionString "${r}" is not a valid version (ITMS-90060)`,
        detail: 'The marketing version must be two or three dot-separated integers (e.g. 1.4 or 1.4.2) — no letters or pre-release suffixes.',
        fix: 'Set MARKETING_VERSION to two or three dot-separated integers (e.g. 1.4.2).',
      }]
    }
    return []
  },
}

export const plistVersionBuildFormat: PrescanCheck = {
  id: 'ios/plist-version-build-format',
  platforms: ['ios'],
  appliesTo: hasInfoPlist,
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    const v = plistString(raw, 'CFBundleVersion')
    if (v === null)
      return []
    const r = resolvePlistValue(v, pbx(ctx.projectDir))
    if (isUnresolvedRef(r))
      return []
    if (!BUILD_VERSION_RE.test(r)) {
      return [{
        id: 'ios/plist-version-build-format',
        severity: 'error',
        title: `CFBundleVersion "${r}" is not a valid build number`,
        detail: 'The build number must be numeric, ≤3 dot-separated integers (e.g. 42 or 1.4.42).',
        fix: 'Set CURRENT_PROJECT_VERSION numeric, ≤3 integers (e.g. 42 or 1.4.42).',
      }]
    }
    return []
  },
}

export const plistEncryptionCompliance: PrescanCheck = {
  id: 'ios/plist-encryption-compliance',
  platforms: ['ios'],
  appliesTo: ctx => hasInfoPlist(ctx) && willUploadToAppStore(ctx),
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    if (plistHasKey(raw, 'ITSAppUsesNonExemptEncryption'))
      return [] // present (either value) — do NOT assert which value is correct
    return [{
      id: 'ios/plist-encryption-compliance',
      severity: 'warning',
      title: 'Info.plist is missing ITSAppUsesNonExemptEncryption',
      detail: 'Without this key, App Store Connect shows a "Missing Compliance" prompt on every upload.',
      fix: 'Add ITSAppUsesNonExemptEncryption=<false/> (correct for most Capacitor apps) to stop the per-upload Missing Compliance prompt.',
    }]
  },
}

export const plistAtsArbitraryLoads: PrescanCheck = {
  id: 'ios/plist-ats-arbitrary-loads',
  platforms: ['ios'],
  appliesTo: hasInfoPlist,
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    const dict = plistDictBlock(raw, 'NSAppTransportSecurity')
    if (dict === null)
      return []
    if (plistBool(dict, 'NSAllowsArbitraryLoads') !== true)
      return []
    // Escalate to error only when an upload is intended AND a dev server config
    // is still wired in (cleartext or a live server.url) — that combination ships
    // arbitrary-loads to production.
    const escalate = willUploadToAppStore(ctx) && hasDevServerConfig(ctx)
    return [{
      id: 'ios/plist-ats-arbitrary-loads',
      severity: escalate ? 'error' : 'warning',
      title: 'NSAllowsArbitraryLoads is enabled (App Transport Security disabled)',
      detail: escalate
        ? 'Uploading with arbitrary loads enabled and a dev server (cleartext / server.url) still configured ships an insecure release.'
        : 'NSAllowsArbitraryLoads disables App Transport Security for all hosts.',
      fix: 'Remove NSAllowsArbitraryLoads (or set <false/>); use scoped NSExceptionDomains; remove server.url/cleartext before release.',
    }]
  },
}

export const plistLaunchStoryboard: PrescanCheck = {
  id: 'ios/plist-launch-storyboard',
  platforms: ['ios'],
  appliesTo: hasInfoPlist,
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    const ok = plistHasKey(raw, 'UILaunchStoryboardName') || plistHasKey(raw, 'UILaunchScreen')
    if (ok)
      return []
    return [{
      id: 'ios/plist-launch-storyboard',
      severity: 'error',
      title: 'Info.plist declares no launch screen (ITMS-90475/90096)',
      detail: 'App Store upload requires a launch storyboard or a UILaunchScreen dictionary.',
      fix: 'Add UILaunchStoryboardName=LaunchScreen (Capacitor default) or a UILaunchScreen dict.',
    }]
  },
}

export const plistOrientationsMultitasking: PrescanCheck = {
  id: 'ios/plist-orientations-multitasking',
  platforms: ['ios'],
  appliesTo(ctx) {
    if (!hasInfoPlist(ctx))
      return false
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return false
    // Full-screen-only iPad apps are exempt from the multitasking orientation rule.
    if (plistBool(raw, 'UIRequiresFullScreen') === true)
      return false
    const family = readBuildSetting(pbx(ctx.projectDir), 'TARGETED_DEVICE_FAMILY')
    if (family === null)
      return false
    // family is a comma list like "1,2"; iPad multitasking only matters when "2" is present.
    return family.split(',').map(s => s.trim()).includes('2')
  },
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    // Scope STRICTLY to the ~ipad array (the iPhone array is intentionally allowed
    // to omit PortraitUpsideDown and would false-positive). Fall back to the
    // non-suffixed array only when the ~ipad key is entirely absent.
    let ipad = plistArrayStrings(raw, 'UISupportedInterfaceOrientations~ipad')
    if (!plistHasKey(raw, 'UISupportedInterfaceOrientations~ipad'))
      ipad = plistArrayStrings(raw, 'UISupportedInterfaceOrientations')
    const present = new Set(ipad)
    const missing = ORIENTATIONS.filter(o => !present.has(o))
    if (missing.length === 0)
      return []
    return [{
      id: 'ios/plist-orientations-multitasking',
      severity: 'warning',
      title: `iPad multitasking requires all four orientations — missing ${missing.join(', ')} (ITMS-90474)`,
      detail: 'An iPad-capable app that supports multitasking must declare all four interface orientations for iPad.',
      fix: 'Add all four orientations to UISupportedInterfaceOrientations~ipad, or add UIRequiresFullScreen=<true/>.',
    }]
  },
}

export const plistOrientationsPresent: PrescanCheck = {
  id: 'ios/plist-orientations-present',
  platforms: ['ios'],
  appliesTo: hasInfoPlist,
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    const arr = plistArrayStrings(raw, 'UISupportedInterfaceOrientations')
    if (arr.length === 0) {
      return [{
        id: 'ios/plist-orientations-present',
        severity: 'warning',
        title: 'Info.plist declares no UISupportedInterfaceOrientations',
        detail: 'Declare at least one supported interface orientation for iPhone.',
        fix: 'Declare ≥1 valid UIInterfaceOrientation* value.',
      }]
    }
    const bad = arr.find(o => !ORIENTATION_SET.has(o))
    if (bad !== undefined) {
      return [{
        id: 'ios/plist-orientations-present',
        severity: 'warning',
        title: `Invalid interface orientation "${bad}"`,
        detail: 'Each entry must be one of UIInterfaceOrientationPortrait, PortraitUpsideDown, LandscapeLeft, LandscapeRight.',
        fix: 'Declare ≥1 valid UIInterfaceOrientation* value.',
      }]
    }
    return []
  },
}

export const plistDisplayName: PrescanCheck = {
  id: 'ios/plist-display-name',
  platforms: ['ios'],
  appliesTo: hasInfoPlist,
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    const pbxContent = pbx(ctx.projectDir)
    // A resolved value is "good" only when it is a non-empty literal (not a
    // still-unresolved $() reference).
    const resolved = (key: string): string | null => {
      const v = plistString(raw, key)
      if (v === null)
        return null
      const r = resolvePlistValue(v, pbxContent)
      if (isUnresolvedRef(r) || r.trim() === '')
        return null
      return r
    }
    if (resolved('CFBundleDisplayName') !== null || resolved('CFBundleName') !== null)
      return []
    return [{
      id: 'ios/plist-display-name',
      severity: 'warning',
      title: 'Info.plist has no resolvable app display name',
      detail: 'Neither CFBundleDisplayName nor CFBundleName resolves to a non-empty value.',
      fix: 'Set CFBundleDisplayName or ensure PRODUCT_NAME resolves.',
    }]
  },
}

const LOCATION_USAGE_KEYS = [
  'NSLocationWhenInUseUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSLocationAlwaysUsageDescription',
  'NSLocationUsageDescription',
]

export const plistBackgroundModesSanity: PrescanCheck = {
  id: 'ios/plist-background-modes-sanity',
  platforms: ['ios'],
  appliesTo(ctx) {
    if (!hasInfoPlist(ctx))
      return false
    const raw = readInfoPlist(ctx.projectDir)
    return raw !== null && plistHasKey(raw, 'UIBackgroundModes')
  },
  async run(ctx): Promise<Finding[]> {
    const raw = readInfoPlist(ctx.projectDir)
    if (raw === null)
      return []
    const modes = plistArrayStrings(raw, 'UIBackgroundModes')
    const findings: Finding[] = []
    // (a) unknown tokens — structural sanity, never a hard error.
    const invalid = modes.filter(m => !BACKGROUND_MODES.has(m))
    if (invalid.length > 0) {
      findings.push({
        id: 'ios/plist-background-modes-sanity',
        severity: 'warning',
        title: `Unknown UIBackgroundModes value(s): ${invalid.join(', ')}`,
        detail: 'Background modes must be one of Apple\'s documented UIBackgroundModes tokens.',
        fix: 'Remove unused background modes; add matching usage strings/capabilities.',
      })
    }
    // (b) location mode without a usage string — Guideline 2.5.4. Gate to upload.
    if (modes.includes('location') && willUploadToAppStore(ctx)) {
      const hasUsage = LOCATION_USAGE_KEYS.some(k => plistHasKey(raw, k))
      if (!hasUsage) {
        findings.push({
          id: 'ios/plist-background-modes-sanity',
          severity: 'warning',
          title: 'UIBackgroundModes declares "location" without a location usage description (Guideline 2.5.4)',
          detail: 'App Review rejects background location without an NSLocation*UsageDescription string.',
          fix: 'Add the matching NSLocation*UsageDescription, or remove the location background mode.',
        })
      }
    }
    return findings
  },
}
