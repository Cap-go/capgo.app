// src/build/prescan/checks/ios-xcode.ts
//
// §2.B "Xcode project / build settings" prescan checks. All local (read only
// the project's pbxproj). They build on the scalar build-setting readers in
// ios-pbxsettings (readBuildSetting / readBuildConfigs / readTargetConfigs),
// the signable-target walk in pbxproj-parser, the shared capacitorMajor, and
// willUploadToAppStore for upload-aware severity.
//
// FP guards baked in (see the spec §0 ground-truth facts):
//   - signing-team is SUPPRESSED entirely when a provisioning map is present
//     (the cloud builder injects the team + switches to managed-manual signing).
//   - every "value below floor / bad value" check only flags a PRESENT scalar;
//     an ABSENT key means "inherited/unknown" and is skipped (no finding),
//     because build-setting inheritance / xcconfig is not resolved here.
import type { PbxTarget } from '../../pbxproj-parser'
import type { Finding, PrescanCheck, ScanContext } from '../types'
import { findSignableTargets, readPbxproj } from '../../pbxproj-parser'
import { capacitorMajor } from '../capacitor-version'
import { readBuildConfigs, readMinimumIosDeploymentTarget, readTargetConfigs } from '../ios-pbxsettings'
import { willUploadToAppStore } from '../upload-intent'
import { parseProvisioningMap } from './ios-profiles'

const APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application'

/** pbxproj content for the project, or null when no Xcode project is found. */
function pbxOf(ctx: ScanContext): string | null {
  return readPbxproj(ctx.projectDir)
}

/** Application-product-type targets only (extensions/watch apps excluded). */
function appTargets(pbxContent: string): PbxTarget[] {
  return findSignableTargets(pbxContent).filter(t => t.productType === APPLICATION_PRODUCT_TYPE)
}

// ── ios/xcode-deployment-target-capacitor ────────────────────────────────────

// Build-breaking deployment-target floor per Capacitor major. Mirrors the
// android-style Record<major, floor> + default pattern. Capacitor 5/6 require
// iOS 13, 7/8 require iOS 14; unknown/newer majors default to 14.
const CAP_IOS_DEPLOYMENT_FLOORS: Record<number, number> = { 5: 13, 6: 13, 7: 14, 8: 14 }
const CAP_IOS_DEPLOYMENT_DEFAULT = 14

function capacitorDeploymentFloor(major: number): number {
  return CAP_IOS_DEPLOYMENT_FLOORS[major] ?? CAP_IOS_DEPLOYMENT_DEFAULT
}

/**
 * Lowest PRESENT IPHONEOS_DEPLOYMENT_TARGET across every project-level and app
 * target build config, parsed as a float; null when the key is absent everywhere
 * (inherited — cannot judge).
 */
function presentDeploymentTarget(pbxContent: string): number | null {
  return readMinimumIosDeploymentTarget(pbxContent)
}

export const deploymentTargetCapacitor: PrescanCheck = {
  id: 'ios/xcode-deployment-target-capacitor',
  platforms: ['ios'],
  appliesTo: (ctx) => {
    if (capacitorMajor(ctx.projectDir) === null)
      return false
    const pbx = pbxOf(ctx)
    return pbx !== null && presentDeploymentTarget(pbx) !== null
  },
  async run(ctx): Promise<Finding[]> {
    const pbx = pbxOf(ctx)
    if (!pbx)
      return []
    const major = capacitorMajor(ctx.projectDir)
    const target = presentDeploymentTarget(pbx)
    if (major === null || target === null)
      return []
    const floor = capacitorDeploymentFloor(major)
    if (target >= floor)
      return []
    return [{
      id: 'ios/xcode-deployment-target-capacitor',
      severity: 'error',
      title: `IPHONEOS_DEPLOYMENT_TARGET ${target} is below the Capacitor ${major} floor (${floor})`,
      detail: `Capacitor ${major} requires iOS deployment target >= ${floor}; the build will fail otherwise.`,
      fix: `Raise IPHONEOS_DEPLOYMENT_TARGET to >= ${floor} (project + app target) and the Podfile platform line if present.`,
    }]
  },
}

// ── ios/xcode-signing-team ───────────────────────────────────────────────────

const hasProvisioningMap = (ctx: ScanContext): boolean => parseProvisioningMap(ctx).length > 0

/**
 * Release-preferred (fallback Debug) lookup of a scalar within a single target's
 * configs. Mirrors the Release-vs-fallback walk readBuildSetting uses, but
 * scoped to one target's config set.
 */
function targetSetting(configs: { name: string, settings: Record<string, string> }[], key: string): string | undefined {
  const release = configs.find(c => c.name === 'Release')?.settings[key]
  if (release !== undefined)
    return release
  const debug = configs.find(c => c.name === 'Debug')?.settings[key]
  if (debug !== undefined)
    return debug
  for (const c of configs) {
    if (c.settings[key] !== undefined)
      return c.settings[key]
  }
  return undefined
}

/** Signable targets that set CODE_SIGN_STYLE but have no (non-empty) DEVELOPMENT_TEAM. */
function targetsMissingTeam(pbxContent: string): string[] {
  const out: string[] = []
  for (const { target, configs } of readTargetConfigs(pbxContent)) {
    const style = targetSetting(configs, 'CODE_SIGN_STYLE')
    if (style === undefined)
      continue // signing style inherited — nothing to judge
    const team = targetSetting(configs, 'DEVELOPMENT_TEAM')
    if (team === undefined || team.trim() === '')
      out.push(target.name)
  }
  return out
}

export const signingTeam: PrescanCheck = {
  id: 'ios/xcode-signing-team',
  platforms: ['ios'],
  appliesTo: (ctx) => {
    // Suppress entirely when a provisioning map is present: the builder injects
    // the team and switches to managed-manual signing, so a locally-absent
    // DEVELOPMENT_TEAM is not load-bearing.
    if (hasProvisioningMap(ctx))
      return false
    const pbx = pbxOf(ctx)
    return pbx !== null && targetsMissingTeam(pbx).length > 0
  },
  async run(ctx): Promise<Finding[]> {
    if (hasProvisioningMap(ctx))
      return []
    const pbx = pbxOf(ctx)
    if (!pbx)
      return []
    const missing = targetsMissingTeam(pbx)
    if (missing.length === 0)
      return []
    const uploading = willUploadToAppStore(ctx)
    return [{
      id: 'ios/xcode-signing-team',
      severity: uploading ? 'error' : 'warning',
      title: `${missing.length} signable target(s) set a code-signing style but no DEVELOPMENT_TEAM`,
      detail: `targets without a team: ${missing.join(', ')}`,
      fix: 'Set DEVELOPMENT_TEAM in Xcode (Signing & Capabilities), or supply signing creds/profiles to the cloud build so it switches to managed-manual signing.',
    }]
  },
}

// ── ios/xcode-bundle-id-mismatch-across-configs ──────────────────────────────

/** Signable targets that PRESENT >= 2 distinct PRODUCT_BUNDLE_IDENTIFIER values across configs. */
function targetsWithBundleIdConflict(pbxContent: string): { name: string, values: string[] }[] {
  const out: { name: string, values: string[] }[] = []
  for (const { target, configs } of readTargetConfigs(pbxContent)) {
    const present = configs
      .map(c => c.settings.PRODUCT_BUNDLE_IDENTIFIER)
      .filter((v): v is string => v !== undefined)
    if (present.length < 2)
      continue // single-config or all-inherited — nothing to compare
    const distinct = Array.from(new Set(present))
    if (distinct.length >= 2)
      out.push({ name: target.name, values: distinct })
  }
  return out
}

export const bundleIdMismatchAcrossConfigs: PrescanCheck = {
  id: 'ios/xcode-bundle-id-mismatch-across-configs',
  platforms: ['ios'],
  appliesTo: (ctx) => {
    const pbx = pbxOf(ctx)
    return pbx !== null && readTargetConfigs(pbx).some((t) => {
      const present = t.configs.map(c => c.settings.PRODUCT_BUNDLE_IDENTIFIER).filter(v => v !== undefined)
      return present.length >= 2
    })
  },
  async run(ctx): Promise<Finding[]> {
    const pbx = pbxOf(ctx)
    if (!pbx)
      return []
    const conflicts = targetsWithBundleIdConflict(pbx)
    if (conflicts.length === 0)
      return []
    return [{
      id: 'ios/xcode-bundle-id-mismatch-across-configs',
      severity: 'warning',
      title: `PRODUCT_BUNDLE_IDENTIFIER differs across build configs in ${conflicts.length} target(s)`,
      detail: conflicts.map(c => `${c.name}: ${c.values.join(' vs ')}`).join('; '),
      fix: 'Align PRODUCT_BUNDLE_IDENTIFIER across Debug/Release (or ignore if a Debug suffix is intentional).',
    }]
  },
}

// ── ios/xcode-enable-bitcode-leftover ────────────────────────────────────────

/** Config names (project + target) that PRESENT ENABLE_BITCODE == YES. */
function bitcodeYesConfigs(pbxContent: string): string[] {
  return readBuildConfigs(pbxContent)
    .filter(c => c.settings.ENABLE_BITCODE === 'YES')
    .map(c => (c.isProjectLevel ? `project ${c.name}` : c.name))
}

export const enableBitcodeLeftover: PrescanCheck = {
  id: 'ios/xcode-enable-bitcode-leftover',
  platforms: ['ios'],
  appliesTo: (ctx) => {
    const pbx = pbxOf(ctx)
    return pbx !== null && bitcodeYesConfigs(pbx).length > 0
  },
  async run(ctx): Promise<Finding[]> {
    const pbx = pbxOf(ctx)
    if (!pbx)
      return []
    const configs = bitcodeYesConfigs(pbx)
    if (configs.length === 0)
      return []
    return [{
      id: 'ios/xcode-enable-bitcode-leftover',
      severity: 'warning',
      title: 'ENABLE_BITCODE = YES is set (deprecated since Xcode 14)',
      detail: `present in: ${configs.join(', ')}`,
      fix: 'Set ENABLE_BITCODE = NO or delete it — Xcode 14+ ignores bitcode and Apple no longer accepts it.',
    }]
  },
}

// ── ios/xcode-swift-version-sanity ───────────────────────────────────────────

/** Signable targets whose PRESENT SWIFT_VERSION is < 5 or not a leading number. */
function targetsWithBadSwiftVersion(pbxContent: string): { name: string, value: string }[] {
  const out: { name: string, value: string }[] = []
  for (const { target, configs } of readTargetConfigs(pbxContent)) {
    const value = targetSetting(configs, 'SWIFT_VERSION')
    if (value === undefined)
      continue // absent — Obj-C-only target, skip
    const m = value.match(/^\s*(\d+(?:\.\d+)?)/)
    const major = m ? Number.parseFloat(m[1]) : Number.NaN
    if (Number.isNaN(major) || major < 5)
      out.push({ name: target.name, value })
  }
  return out
}

export const swiftVersionSanity: PrescanCheck = {
  id: 'ios/xcode-swift-version-sanity',
  platforms: ['ios'],
  appliesTo: (ctx) => {
    const pbx = pbxOf(ctx)
    return pbx !== null && readTargetConfigs(pbx).some(t => targetSetting(t.configs, 'SWIFT_VERSION') !== undefined)
  },
  async run(ctx): Promise<Finding[]> {
    const pbx = pbxOf(ctx)
    if (!pbx)
      return []
    const bad = targetsWithBadSwiftVersion(pbx)
    if (bad.length === 0)
      return []
    return [{
      id: 'ios/xcode-swift-version-sanity',
      severity: 'warning',
      title: `SWIFT_VERSION is below 5 (or unparseable) in ${bad.length} target(s)`,
      detail: bad.map(b => `${b.name}: ${b.value}`).join('; '),
      fix: 'Set SWIFT_VERSION = 5.0 (or your intended Swift >= 5) for the affected target(s).',
    }]
  },
}

// ── ios/xcode-no-app-target ──────────────────────────────────────────────────

export const noAppTarget: PrescanCheck = {
  id: 'ios/xcode-no-app-target',
  platforms: ['ios'],
  appliesTo: ctx => pbxOf(ctx) !== null,
  async run(ctx): Promise<Finding[]> {
    const pbx = pbxOf(ctx)
    if (!pbx)
      return []
    if (appTargets(pbx).length > 0)
      return []
    return [{
      id: 'ios/xcode-no-app-target',
      severity: 'error',
      title: 'No application target found in the Xcode project',
      detail: 'The pbxproj parsed but contains no com.apple.product-type.application target — the build has nothing to archive.',
      fix: 'Run `npx cap sync ios`, or restore the application target in Xcode.',
    }]
  },
}

// ── ios/xcode-multiple-app-targets ───────────────────────────────────────────

export const multipleAppTargets: PrescanCheck = {
  id: 'ios/xcode-multiple-app-targets',
  platforms: ['ios'],
  appliesTo: (ctx) => {
    const pbx = pbxOf(ctx)
    return pbx !== null && appTargets(pbx).length > 1
  },
  async run(ctx): Promise<Finding[]> {
    const pbx = pbxOf(ctx)
    if (!pbx)
      return []
    const apps = appTargets(pbx)
    if (apps.length <= 1)
      return []
    return [{
      id: 'ios/xcode-multiple-app-targets',
      severity: 'warning',
      title: `${apps.length} application targets found — the build may sign/archive the wrong one`,
      detail: `app targets: ${apps.map(t => `${t.name} (${t.bundleId})`).join(', ')}`,
      fix: 'Keep a single application target, remove the duplicate, or pass the intended scheme to the build.',
    }]
  },
}
