// src/build/prescan/checks/ios-pods-assets.ts
//
// §2.E (Pods / SPM) + §2.F (App icons / assets) of the iOS prescan expansion.
// All checks are LOCAL (read only project files) and never throw - the parsers
// (readContentsJson / readTextIfExists / readPbxproj) all return null/[] on
// missing or malformed input, so a degraded project produces no findings rather
// than a crash. Findings surface only file paths / icon filenames / bundle-id-free
// structure, never credential material.
//
// ── Builder-grounded severity decisions ──────────────────────────────────────
// Verified against the real cloud build:
//   - capgo_builder_new/.github/workflows/github-ios-build.yml (runner shell)
//   - capgo_builder_new/src/fastlaneTemplateIos.ts (the injected Fastfile)
//
// What the cloud build actually does:
//   1. CocoaPods: the `install_pods` lane runs `cocoapods(repo_update: true)`
//      whenever a Podfile is found - it REGENERATES `Pods/` and the `.xcworkspace`.
//      => pods-not-installed and pods-capacitor-missing are NOT hard build-breakers
//         server-side, so both are DOWNGRADED error -> warning.
//   2. SPM: `build_app` (gym -> xcodebuild) RESOLVES Swift Package dependencies
//      during the build; a missing Package.resolved is regenerated on the runner.
//      => spm-package-resolved-missing is DOWNGRADED error -> warning. The builder
//         never runs `npx cap sync`, so Package.swift is not regenerated, but the
//         `/capacitor-swift-pm/` + `.product(Capacitor)` regex is high-FP, so
//         spm-capacitor-dependency-missing is also DOWNGRADED error -> warning.
//   3. AppIcon: `xcodebuild`/`actool` TOLERATE an empty AppIcon.appiconset for
//      ad_hoc/dev exports - an empty set only fails App Store *upload* validation
//      (ITMS-90704). => appicon-empty-or-placeholder is DOWNGRADED error -> warning
//      and UPLOAD-GATED back to error via willUploadToAppStore. A referenced PNG
//      that is MISSING from disk genuinely fails `actool` server-side, so
//      appicon-referenced-file-missing KEEPS error. appicon-marketing-missing stays
//      error but remains upload-gated (its appliesTo is willUploadToAppStore).

import type { Finding, PrescanCheck, ScanContext } from '../types'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appIconSetDir, hasMarketingIcon, readContentsJson } from '../ios-appicon'
import { readMinimumIosDeploymentTarget } from '../ios-pbxsettings'
import { readPbxproj } from '../../pbxproj-parser'
import { readTextIfExists } from '../gradle'

// ── Layout discriminators (spec §2.E) ────────────────────────────────────────
// CocoaPods = ios/App/Podfile present. SPM = ios/App/CapApp-SPM/Package.swift present.
function podfilePath(projectDir: string): string {
  return join(projectDir, 'ios', 'App', 'Podfile')
}

function packageSwiftPath(projectDir: string): string {
  return join(projectDir, 'ios', 'App', 'CapApp-SPM', 'Package.swift')
}

function hasPodfile(ctx: ScanContext): boolean {
  return existsSync(podfilePath(ctx.projectDir))
}

function hasMacOSPodfile(ctx: ScanContext): boolean {
  return ctx.hostPlatform === 'darwin' && hasPodfile(ctx)
}

function hasPackageSwift(ctx: ScanContext): boolean {
  return existsSync(packageSwiftPath(ctx.projectDir))
}

function pbxContent(ctx: ScanContext): string | null {
  return readPbxproj(ctx.projectDir)
}

// willUploadToAppStore is re-implemented locally to avoid a circular import path
// concern; mirror upload-intent.ts exactly (iOS + app_store mode default + full
// ASC triplet). Kept tiny and in-sync with upload-intent.willUploadToAppStore.
function uploading(ctx: ScanContext): boolean {
  if (ctx.platform !== 'ios')
    return false
  const mode = ctx.distributionMode ?? 'app_store'
  if (mode !== 'app_store')
    return false
  const c = ctx.credentials
  return Boolean(c?.APPLE_KEY_ID && c?.APPLE_ISSUER_ID && c?.APPLE_KEY_CONTENT)
}

// ── §2.E Pods ─────────────────────────────────────────────────────────────────

/**
 * Podfile present but `Pods/` or `App.xcworkspace` missing. The cloud builder
 * runs `pod install` (regenerating both), so this is a WARNING, not an error -
 * it slows the first build and breaks local Xcode opens, but the server recovers.
 */
export const podsNotInstalled: PrescanCheck = {
  id: 'ios/pods-not-installed',
  platforms: ['ios'],
  appliesTo: hasMacOSPodfile,
  async run(ctx): Promise<Finding[]> {
    const appDir = join(ctx.projectDir, 'ios', 'App')
    const podsDir = existsSync(join(appDir, 'Pods'))
    const workspace = existsSync(join(appDir, 'App.xcworkspace'))
    if (podsDir && workspace)
      return []

    const missing: string[] = []
    if (!podsDir)
      missing.push('ios/App/Pods')
    if (!workspace)
      missing.push('ios/App/App.xcworkspace')

    return [{
      id: 'ios/pods-not-installed',
      severity: 'warning',
      title: 'CocoaPods is not installed (missing Pods/ or App.xcworkspace)',
      detail: `A Podfile exists but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing. The cloud build runs pod install and recovers, but local Xcode builds will fail.`,
      fix: 'Run `npx cap sync ios` (or `pod install`) and commit Pods/ + App.xcworkspace.',
    }]
  },
}

/** Podfile present but Podfile.lock absent - non-reproducible pod resolution. */
export const podsLockMissing: PrescanCheck = {
  id: 'ios/pods-lock-missing',
  platforms: ['ios'],
  appliesTo: hasMacOSPodfile,
  async run(ctx): Promise<Finding[]> {
    if (readTextIfExists(join(ctx.projectDir, 'ios', 'App', 'Podfile.lock')) !== null)
      return []
    return [{
      id: 'ios/pods-lock-missing',
      severity: 'warning',
      title: 'Podfile.lock is missing - pod versions are not pinned',
      detail: 'Without Podfile.lock the cloud build resolves pod versions fresh, which can drift from your local versions.',
      fix: 'Run `pod install` and commit Podfile.lock.',
    }]
  },
}

/**
 * Podfile does not wire the Capacitor pod. `pod install` cannot inject a missing
 * declaration, but the standard Capacitor Podfile uses the `capacitor_pods`
 * helper / `require_relative` rather than a literal `pod 'Capacitor'`, so the
 * literal-match heuristic is high false-positive. WARNING, not error.
 */
export const podsCapacitorMissing: PrescanCheck = {
  id: 'ios/pods-capacitor-missing',
  platforms: ['ios'],
  appliesTo: hasPodfile,
  async run(ctx): Promise<Finding[]> {
    const raw = readTextIfExists(podfilePath(ctx.projectDir))
    if (raw === null)
      return []
    // Match a literal `pod 'Capacitor'` / `pod "Capacitor"` OR the standard
    // capacitor_pods helper (require_relative .../@capacitor/ios or capacitor_pods).
    const wiresCapacitor
      = /pod\s+['"]Capacitor['"]/.test(raw)
        || /capacitor_pods/.test(raw)
        || /@capacitor\/ios/.test(raw)
    if (wiresCapacitor)
      return []
    return [{
      id: 'ios/pods-capacitor-missing',
      severity: 'warning',
      title: 'Podfile does not appear to wire the Capacitor pod',
      detail: 'No `pod \'Capacitor\'`, `capacitor_pods` helper, or `@capacitor/ios` reference was found. If this is intentional (custom pod names) you can ignore this.',
      fix: 'Run `npx cap sync ios` then `pod install`.',
    }]
  },
}

// ── §2.E SPM ────────────────────────────────────────────────────────────────

/**
 * SPM project with no Package.resolved in either known location. `build_app`
 * (xcodebuild) resolves packages during the build, so this is a WARNING - a
 * committed Package.resolved just makes resolution reproducible and faster.
 */
export const spmPackageResolvedMissing: PrescanCheck = {
  id: 'ios/spm-package-resolved-missing',
  platforms: ['ios'],
  appliesTo: hasPackageSwift,
  async run(ctx): Promise<Finding[]> {
    const xcodeprojResolved = join(
      ctx.projectDir,
      'ios',
      'App',
      'App.xcodeproj',
      'project.xcworkspace',
      'xcshareddata',
      'swiftpm',
      'Package.resolved',
    )
    const capAppResolved = join(ctx.projectDir, 'ios', 'App', 'CapApp-SPM', 'Package.resolved')
    if (existsSync(xcodeprojResolved) || existsSync(capAppResolved))
      return []
    return [{
      id: 'ios/spm-package-resolved-missing',
      severity: 'warning',
      title: 'Swift Package Manager Package.resolved is missing',
      detail: 'No Package.resolved found under the xcodeproj or CapApp-SPM. The cloud build resolves packages during build_app, but committing Package.resolved pins versions for reproducible builds.',
      fix: 'Run `xcodebuild -resolvePackageDependencies` (or open in Xcode) and commit Package.resolved.',
    }]
  },
}

/**
 * Package.swift does not declare the capacitor-swift-pm dependency / the
 * Capacitor product. The builder never runs `cap sync`, but Package.swift is
 * CLI-managed ("DO NOT MODIFY") and the regex is high false-positive on valid
 * variants, so this is a WARNING, not an error.
 */
export const spmCapacitorDependencyMissing: PrescanCheck = {
  id: 'ios/spm-capacitor-dependency-missing',
  platforms: ['ios'],
  appliesTo: hasPackageSwift,
  async run(ctx): Promise<Finding[]> {
    const raw = readTextIfExists(packageSwiftPath(ctx.projectDir))
    if (raw === null)
      return []
    const hasPackage = /capacitor-swift-pm/.test(raw)
    const hasProduct = /\.product\(\s*name:\s*['"]Capacitor['"]/.test(raw)
    if (hasPackage && hasProduct)
      return []
    return [{
      id: 'ios/spm-capacitor-dependency-missing',
      severity: 'warning',
      title: 'Package.swift does not declare the Capacitor SPM dependency',
      detail: 'Expected a capacitor-swift-pm package dependency and a `.product(name: "Capacitor", ...)` target dependency. If your project uses a non-standard layout you can ignore this.',
      fix: 'Run `npx cap sync ios` to regenerate Package.swift.',
    }]
  },
}

// ── §2.F App icons / assets ───────────────────────────────────────────────────

/**
 * AppIcon.appiconset directory missing, Contents.json missing/malformed, or no
 * icon images declared. The directory-missing and malformed-Contents cases are
 * always errors (the asset catalog is structurally broken). The "no images"
 * case is a WARNING by default (actool tolerates it for ad_hoc/dev) and
 * ESCALATES to error when uploading to the App Store (ITMS-90704 blocks upload).
 */
export const appiconEmptyOrPlaceholder: PrescanCheck = {
  id: 'ios/appicon-empty-or-placeholder',
  platforms: ['ios'],
  async run(ctx): Promise<Finding[]> {
    const dir = appIconSetDir(ctx.projectDir, pbxContent(ctx) ?? undefined)
    if (!existsSync(dir)) {
      return [{
        id: 'ios/appicon-empty-or-placeholder',
        severity: 'error',
        title: 'AppIcon.appiconset is missing',
        detail: `Expected an app-icon asset set at ${dir.replace(ctx.projectDir, '.')} but the directory does not exist.`,
        fix: 'Run `npx @capacitor/assets generate` (or add the icon set in Xcode).',
      }]
    }

    const c = readContentsJson(join(dir, 'Contents.json'))
    if (c === null) {
      return [{
        id: 'ios/appicon-empty-or-placeholder',
        severity: 'error',
        title: 'AppIcon Contents.json is missing or malformed',
        detail: 'The app-icon Contents.json could not be parsed as JSON.',
        fix: 'Regenerate the icon set (`npx @capacitor/assets generate`) or fix the malformed Contents.json.',
      }]
    }

    const hasImage = (c.images ?? []).some(i => i.filename?.trim())
    if (hasImage)
      return []

    // No icon images: warning normally, error when it would block an upload.
    return [{
      id: 'ios/appicon-empty-or-placeholder',
      severity: uploading(ctx) ? 'error' : 'warning',
      title: 'AppIcon.appiconset declares no icon images',
      detail: uploading(ctx)
        ? 'The icon set has no images - App Store upload will reject it (ITMS-90704).'
        : 'The icon set has no images. The build tolerates this for ad_hoc/development, but App Store upload would reject it.',
      fix: 'Run `npx @capacitor/assets generate` so the set has at least the 1024x1024 icon.',
    }]
  },
}

/**
 * A Contents.json image entry references a filename that is missing from disk.
 * `actool` FAILS server-side in this case, so this KEEPS error severity.
 */
export const appiconReferencedFileMissing: PrescanCheck = {
  id: 'ios/appicon-referenced-file-missing',
  platforms: ['ios'],
  appliesTo(ctx): boolean {
    const dir = appIconSetDir(ctx.projectDir, readPbxproj(ctx.projectDir) ?? undefined)
    return readContentsJson(join(dir, 'Contents.json')) !== null
  },
  async run(ctx): Promise<Finding[]> {
    const dir = appIconSetDir(ctx.projectDir, pbxContent(ctx) ?? undefined)
    const c = readContentsJson(join(dir, 'Contents.json'))
    if (c === null)
      return []

    const missing: string[] = []
    for (const image of c.images ?? []) {
      const filename = image.filename?.trim()
      if (!filename)
        continue
      if (!existsSync(join(dir, filename)))
        missing.push(filename)
    }
    if (missing.length === 0)
      return []

    return [{
      id: 'ios/appicon-referenced-file-missing',
      severity: 'error',
      title: 'AppIcon Contents.json references icon file(s) missing from disk',
      detail: `actool will fail the build: missing ${missing.join(', ')}.`,
      fix: 'Regenerate the icons (`npx @capacitor/assets generate`) or commit the referenced PNG(s).',
    }]
  },
}

/**
 * App Store marketing icon (1024x1024 / role=marketing) missing. Upload-gated:
 * ad_hoc/dev builds do not need it, but App Store upload requires it
 * (ITMS-90704). KEEPS error severity.
 */
export const appiconMarketingMissing: PrescanCheck = {
  id: 'ios/appicon-marketing-missing',
  platforms: ['ios'],
  appliesTo: uploading,
  async run(ctx): Promise<Finding[]> {
    const dir = appIconSetDir(ctx.projectDir, pbxContent(ctx) ?? undefined)
    const c = readContentsJson(join(dir, 'Contents.json'))
    // A missing/empty set is owned by appicon-empty-or-placeholder; this check
    // only fires when a set exists but lacks the marketing icon specifically.
    if (c === null)
      return []
    if (hasMarketingIcon(c))
      return []
    return [{
      id: 'ios/appicon-marketing-missing',
      severity: 'error',
      title: 'App Store marketing icon (1024x1024) is missing',
      detail: 'App Store upload requires a 1024x1024 marketing icon in the AppIcon set (ITMS-90704).',
      fix: 'Add a 1024x1024 PNG (no alpha) marketing icon and reference it in Contents.json.',
    }]
  },
}

// ── §2.F SPM deployment-target consistency ─────────────────────────────────────

const SPM_MIN_RE = /\.iOS\(\.v(\d+)\)/

/**
 * SPM project where the pbxproj IPHONEOS_DEPLOYMENT_TARGET is LOWER than the
 * Package.swift platform minimum (`.iOS(.vN)`) - the dangerous direction: the
 * package requires a newer floor than the app builds against. Warning only;
 * skipped entirely when IPHONEOS_DEPLOYMENT_TARGET is absent (inherited/unknown).
 */
export const spmDeploymentTargetConsistency: PrescanCheck = {
  id: 'ios/spm-deployment-target-consistency',
  platforms: ['ios'],
  appliesTo(ctx): boolean {
    if (!hasPackageSwift(ctx))
      return false
    const pbx = readPbxproj(ctx.projectDir)
    if (pbx === null)
      return false
    return readMinimumIosDeploymentTarget(pbx) !== null
  },
  async run(ctx): Promise<Finding[]> {
    const pbx = pbxContent(ctx)
    if (pbx === null)
      return []
    const pbxTarget = readMinimumIosDeploymentTarget(pbx)
    if (pbxTarget === null)
      return []

    const packageSwift = readTextIfExists(packageSwiftPath(ctx.projectDir))
    if (packageSwift === null)
      return []
    const m = packageSwift.match(SPM_MIN_RE)
    if (!m)
      return []
    const spmMin = Number.parseFloat(m[1])
    if (Number.isNaN(spmMin) || pbxTarget >= spmMin)
      return []

    return [{
      id: 'ios/spm-deployment-target-consistency',
      severity: 'warning',
      title: 'IPHONEOS_DEPLOYMENT_TARGET is below the Package.swift iOS minimum',
      detail: `The Xcode app target builds for iOS ${pbxTarget} but Package.swift requires iOS ${spmMin} (.iOS(.v${spmMin})).`,
      fix: `Raise IPHONEOS_DEPLOYMENT_TARGET to >= ${spmMin}, or run \`npx cap sync ios\`.`,
    }]
  },
}
