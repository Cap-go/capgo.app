// src/build/onboarding/bundle-id-detector.ts
//
// Detect the iOS bundle ID for Apple-side operations (cert/profile lookup,
// provisioning_map keys). Falls back to capacitor.config.appId only when the
// pbxproj / Info.plist sources can't be read.
//
// We split this off from the existing pbxproj-parser.ts because that module
// returns ALL signable targets (multi-target apps with extensions) and the
// onboarding flow only cares about the main app's bundle ID for the Apple-side
// bundle-id resolution (redirectIfMismatch / verify-app). Routing through one
// mainline-target helper keeps the detection deterministic.
//
// Release is AUTHORITATIVE: the Release-config bundle ID is the build ID used
// for every Apple-side comparison and gate. We never silently substitute a
// Debug value when a Release config exists. The Debug value is still exposed
// (alongside a `debugReleaseDiffer` flag) so callers can print an awareness
// note when Debug ≠ Release — but it is never used to gate.
//
// All sources are read as plain text. project.pbxproj is a NeXT-step plist
// (mostly regex-friendly) and Info.plist is XML — we use simple regexes
// rather than pulling in a plist parser, matching the conservative approach
// already taken in src/app/updateProbe.ts.

import { readFileSync } from 'node:fs'

import { findSignableTargets, findXcodeProject } from '../pbxproj-parser.js'

export type BundleIdSource = 'pbxproj-release' | 'pbxproj-debug' | 'pbxproj-fallback' | 'plist' | 'capacitor-config'

export interface BundleIdCandidate {
  value: string
  source: BundleIdSource
  /** Short human-readable label for the picker, e.g. "project.pbxproj (Release)". */
  label: string
}

export interface DetectedBundleIds {
  /** PRODUCT_BUNDLE_IDENTIFIER from project.pbxproj, preferring Release config. */
  pbxproj: BundleIdCandidate | null
  /** Xcode application target whose bundle id exactly matches the detected project id. */
  iosTarget: string | null
  /**
   * The Debug-config PRODUCT_BUNDLE_IDENTIFIER from project.pbxproj, when a
   * literal value exists. Exposed for the awareness note only — never used to
   * gate. Null when no Debug-config literal value is present.
   */
  debug: BundleIdCandidate | null
  /**
   * Info.plist CFBundleIdentifier when it's a literal value (not the common
   * `$(PRODUCT_BUNDLE_IDENTIFIER)` placeholder, which we drop because it
   * adds nothing the pbxproj source doesn't already cover).
   */
  plist: BundleIdCandidate | null
  /** capacitor.config.ts/json's appId — always present (it's a required arg). */
  capacitor: BundleIdCandidate
  /**
   * The best-guess Apple-side bundle ID, picked in priority order:
   * pbxproj-release > pbxproj-fallback > plist > capacitor. Returned for
   * convenience so callers don't have to re-implement the precedence.
   */
  recommended: BundleIdCandidate
  /**
   * True when the recommended value differs from capacitor.config.appId.
   * Used by redirectIfMismatch to decide whether to adopt the Release id —
   * when they match, capacitor.config.appId is already the build id.
   */
  mismatch: boolean
  /**
   * True only when BOTH a Release-config and a Debug-config literal bundle id
   * were found AND they differ. Drives the "Debug ≠ Release" awareness note;
   * never gates. False when either value is missing or they match.
   */
  debugReleaseDiffer: boolean
  /**
   * True when a Release-config PRODUCT_BUNDLE_IDENTIFIER was resolved from
   * pbxproj. When false, the authoritative build ID could not be determined
   * from Release and callers should warn/skip gating rather than gate on a
   * Debug or plist fallback.
   */
  releaseResolved: boolean
  /**
   * Deduplicated, ordered list of candidates ready to render as Select
   * options. Empty list is impossible (capacitor is always included).
   */
  candidates: BundleIdCandidate[]
}

interface PbxprojBundleId {
  value: string
  configName: string
}

/**
 * Collect every `{config, value}` PRODUCT_BUNDLE_IDENTIFIER pair from pbxproj
 * content, skipping `$(...)` variable references. Shared by the Release-first
 * resolver and the Debug exposer so the regex lives in one place.
 */
function collectPbxprojBundleIds(pbxprojContent: string): PbxprojBundleId[] {
  if (!pbxprojContent)
    return []

  // Look for XCBuildConfiguration blocks (one level of nested braces tolerated
  // for `buildSettings = { ... }`). Each block has a `name = Release;` and
  // a `PRODUCT_BUNDLE_IDENTIFIER = "...";` somewhere inside.
  //
  // Capacitor app extensions (e.g. NotificationServiceExtension) have their
  // own PRODUCT_BUNDLE_IDENTIFIER in the same pbxproj — typically a child
  // of the main bundle id (com.example.app.notif). We prefer the main app
  // target by looking for a configuration block whose containing pbxproj
  // section has a target name containing "App" (the Capacitor default).
  // Since we don't have target context here, we settle for the heuristic
  // "shortest bundle id" — the parent is always a prefix of any child.

  const buildConfigRegex = /\w+\s*\/\*[^*]*\*\/\s*=\s*\{[^{}]*(?:\{[^}]*\}[^{}]*)*\}/g
  const candidates: PbxprojBundleId[] = []

  for (const match of pbxprojContent.matchAll(buildConfigRegex)) {
    const block = match[0]
    if (!block.includes('XCBuildConfiguration'))
      continue
    const nameMatch = block.match(/name\s*=\s*("[^"]*"|[^;\s]+)\s*;/)
    const bundleIdMatch = block.match(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";\s]+)"?\s*;/)
    if (!nameMatch || !bundleIdMatch)
      continue
    const configName = nameMatch[1].replace(/^"|"$/g, '')
    const value = bundleIdMatch[1]
    // Skip pbxproj variable references like $(PRODUCT_BUNDLE_IDENTIFIER:rfc1034identifier)
    if (value.includes('$('))
      continue
    candidates.push({ value, configName })
  }

  return candidates
}

/**
 * Pick the shortest bundle id among the entries for a given config name.
 * The main app target is always a prefix of (so shorter than) any extension
 * sharing that config, so "shortest = main target" is the deterministic pick.
 */
function shortestForConfig(candidates: PbxprojBundleId[], configName: string): PbxprojBundleId | undefined {
  return candidates
    .filter(c => c.configName === configName)
    .sort((a, b) => a.value.length - b.value.length)[0]
}

/**
 * Parse `PRODUCT_BUNDLE_IDENTIFIER = "..."` lines from pbxproj content,
 * returning the Release and Debug candidates separately.
 *
 * Release is authoritative: when ANY Release-config value exists, `release`
 * is populated and `releaseResolved` is true. The Debug value (when present)
 * is returned alongside via `debug` for the awareness note — it is never
 * promoted to `release`.
 *
 * When no Release config exists, `release` is null and `releaseResolved` is
 * false so callers can detect the no-Release case.
 */
export function parsePbxprojBundleIds(pbxprojContent: string): {
  release: BundleIdCandidate | null
  debug: BundleIdCandidate | null
  releaseResolved: boolean
} {
  const candidates = collectPbxprojBundleIds(pbxprojContent)

  const releaseEntry = shortestForConfig(candidates, 'Release')
  const debugEntry = shortestForConfig(candidates, 'Debug')

  const release: BundleIdCandidate | null = releaseEntry
    ? {
        value: releaseEntry.value,
        source: 'pbxproj-release',
        label: 'project.pbxproj (Release config)',
      }
    : null

  const debug: BundleIdCandidate | null = debugEntry
    ? {
        value: debugEntry.value,
        source: 'pbxproj-debug',
        label: 'project.pbxproj (Debug config)',
      }
    : null

  return { release, debug, releaseResolved: release !== null }
}

/**
 * Parse `PRODUCT_BUNDLE_IDENTIFIER = "..."` lines from pbxproj content.
 * Returns the Release-config value if present, else the shortest non-Release
 * value as a `pbxproj-fallback`. Returns null when no bundle id can be
 * extracted.
 *
 * Release stays authoritative here: a Release value is never overridden by a
 * Debug value. The no-Release fallback is preserved for backward
 * compatibility — callers that need to distinguish "Release resolved" from
 * "fell back to Debug" should use `parsePbxprojBundleIds` (or the
 * `releaseResolved` flag on `detectIosBundleIds`).
 *
 * Looks like a re-implementation of pbxproj-parser.ts's resolveBundleId, but
 * that one needs an XCConfigurationList id (it walks from a target). This
 * one needs to work standalone given only the file contents — so it
 * collects all PRODUCT_BUNDLE_IDENTIFIER values, groups by adjacent
 * `name = Release`/`name = Debug` markers, and prefers Release. Less
 * accurate for multi-target projects but good enough for the "what should
 * we pre-fill" use case here.
 */
export function parsePbxprojBundleId(pbxprojContent: string): BundleIdCandidate | null {
  const { release } = parsePbxprojBundleIds(pbxprojContent)
  if (release)
    return release

  // No Release config — fall back to the shortest value at any (non-Release)
  // level so we still pre-fill something. releaseResolved stays false via
  // parsePbxprojBundleIds/detectIosBundleIds so callers can detect this.
  const candidates = collectPbxprojBundleIds(pbxprojContent)
  if (candidates.length === 0)
    return null

  const fallback = candidates.slice().sort((a, b) => a.value.length - b.value.length)[0]
  return {
    value: fallback.value,
    source: 'pbxproj-fallback',
    label: `project.pbxproj (${fallback.configName} config)`,
  }
}

/**
 * Parse Info.plist's CFBundleIdentifier from raw XML.
 * Returns null when the file is empty, when CFBundleIdentifier is absent,
 * or when it's a `$(PRODUCT_BUNDLE_IDENTIFIER)` variable reference (we drop
 * the placeholder so the picker doesn't list a non-actionable option).
 */
export function parseInfoPlistBundleId(plistContent: string): BundleIdCandidate | null {
  if (!plistContent)
    return null
  const match = plistContent.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)
  if (!match)
    return null
  const value = match[1].trim()
  if (!value || value.includes('$('))
    return null
  return {
    value,
    source: 'plist',
    label: 'Info.plist (CFBundleIdentifier)',
  }
}

/**
 * Read project.pbxproj and Info.plist from the iOS dir and return all
 * available bundle id candidates, plus the recommended one and a
 * mismatch flag.
 *
 * Filesystem reads are best-effort — when either file is missing or
 * unreadable, we silently skip that source. The capacitor candidate is
 * always present.
 */
export function detectIosBundleIds(opts: {
  /** Project root (typically `process.cwd()`). */
  cwd: string
  /** Subdirectory under cwd holding the iOS project (typically "ios"). */
  iosDir: string
  /** Bundle id read from capacitor.config.ts/json — always known. */
  capacitorAppId: string
}): DetectedBundleIds {
  const { cwd, iosDir, capacitorAppId } = opts

  const capacitor: BundleIdCandidate = {
    value: capacitorAppId,
    source: 'capacitor-config',
    label: 'capacitor.config.ts (appId)',
  }

  let pbxproj: BundleIdCandidate | null = null
  let iosTarget: string | null = null
  let debug: BundleIdCandidate | null = null
  let releaseResolved = false
  let plist: BundleIdCandidate | null = null

  // pbxproj — use the existing finder so we agree with the rest of the CLI
  // on what counts as the canonical iOS project location.
  const pbxprojPath = findXcodeProject(`${cwd}/${iosDir}`) ?? findXcodeProject(cwd)
  if (pbxprojPath) {
    try {
      const content = readFileSync(pbxprojPath, 'utf-8')
      // Release is authoritative; Debug is exposed alongside for the note.
      const parsed = parsePbxprojBundleIds(content)
      debug = parsed.debug
      releaseResolved = parsed.releaseResolved
      // Keep the public `pbxproj` field on the existing precedence: Release
      // when resolved, else the fallback (which parsePbxprojBundleId derives
      // without ever promoting Debug over a Release value).
      pbxproj = parsed.release ?? parsePbxprojBundleId(content)
      if (pbxproj) {
        iosTarget = findSignableTargets(content).find(target =>
          target.productType === 'com.apple.product-type.application'
          && target.bundleId === pbxproj?.value,
        )?.name ?? null
      }
    }
    catch {
      // unreadable — silently skip
    }
  }

  // Info.plist — most Capacitor templates put it at ios/App/App/Info.plist.
  // We try that path first; absence is fine (Info.plist is a weaker source
  // than pbxproj anyway).
  const plistPaths = [
    `${cwd}/${iosDir}/App/App/Info.plist`,
    `${cwd}/${iosDir}/App/Info.plist`,
  ]
  for (const path of plistPaths) {
    try {
      const content = readFileSync(path, 'utf-8')
      plist = parseInfoPlistBundleId(content)
      if (plist)
        break
    }
    catch {
      // missing — try the next candidate path
    }
  }

  // Build a deduplicated candidate list (priority-first); recommended[0] is the
  // authoritative Release id. Retained as a detector API field.
  const seen = new Set<string>()
  const ordered: BundleIdCandidate[] = []
  for (const c of [pbxproj, plist, capacitor]) {
    if (!c || seen.has(c.value))
      continue
    seen.add(c.value)
    ordered.push(c)
  }

  const recommended = ordered[0]
  const mismatch = recommended.value !== capacitor.value

  // Debug ≠ Release awareness flag: only meaningful when BOTH literal values
  // exist. Compare against the authoritative Release value, not the fallback.
  const debugReleaseDiffer
    = releaseResolved && debug !== null && pbxproj !== null && debug.value !== pbxproj.value

  return {
    pbxproj,
    iosTarget,
    debug,
    plist,
    capacitor,
    recommended,
    mismatch,
    debugReleaseDiffer,
    releaseResolved,
    candidates: ordered,
  }
}
