// test/prescan/checks-ios-xcode.test.ts
//
// Tests for the §2.B "Xcode project / build settings" check pack
// (checks/ios-xcode.ts). The clean fixture mirrors the real Capacitor-8 SPM
// tutorial project (Debug==Release bundle id, DEVELOPMENT_TEAM present, no
// ENABLE_BITCODE, SWIFT_VERSION 5.0, IPHONEOS_DEPLOYMENT_TARGET 15.0, a single
// application target) and MUST scan clean (zero findings) — it is the
// regression baseline. Each failing case is a minimal mutation of that fixture.
import type { ScanContext } from '../../src/build/prescan/types'
import { describe, expect, it } from 'bun:test'
import {
  bundleIdMismatchAcrossConfigs,
  deploymentTargetCapacitor,
  enableBitcodeLeftover,
  multipleAppTargets,
  noAppTarget,
  signingTeam,
  swiftVersionSanity,
} from '../../src/build/prescan/checks/ios-xcode'
import { makeProject } from './helpers'

const CAP8_PKG = JSON.stringify({ dependencies: { '@capacitor/core': '^8.0.0', '@capacitor/ios': '^8.0.0' } })

/**
 * Build a pbxproj from per-config settings dicts, modelled on the Capacitor SPM
 * layout: one project-level Debug/Release pair carrying only deployment target,
 * and one app-target Debug/Release pair carrying the signing/version settings.
 * `extraTargets` lets a test add extra targets (for the multi-target case);
 * includeAppTarget:false drops the application target entirely.
 */
function makePbx(opts: {
  projectSettings?: Record<string, string>
  targetDebug?: Record<string, string>
  targetRelease?: Record<string, string>
  extraTargets?: { name: string, productType: string, settings: Record<string, string> }[]
  includeAppTarget?: boolean
} = {}): string {
  const renderSettings = (s: Record<string, string>): string =>
    Object.entries(s)
      .map(([k, v]) => `\t\t\t\t${k} = ${v === '' || /[\s,]/.test(v) ? `"${v}"` : v};`)
      .join('\n')

  const projectSettings = opts.projectSettings ?? { IPHONEOS_DEPLOYMENT_TARGET: '15.0', SDKROOT: 'iphoneos' }
  const includeApp = opts.includeAppTarget !== false
  const targetDebug = opts.targetDebug ?? {
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: '1',
    DEVELOPMENT_TEAM: 'UVTJ336J2D',
    IPHONEOS_DEPLOYMENT_TARGET: '15.0',
    MARKETING_VERSION: '1.0',
    PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild',
    PRODUCT_NAME: 'Tutorial Build example app',
    SWIFT_VERSION: '5.0',
    TARGETED_DEVICE_FAMILY: '1,2',
  }
  const targetRelease = opts.targetRelease ?? { ...targetDebug }

  const targetBlocks: string[] = []
  const configBlocks: string[] = []
  const listBlocks: string[] = []
  const projectTargetRefs: string[] = []

  if (includeApp) {
    targetBlocks.push(`\t\tAAA1 /* App */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = LIST_APP /* Build configuration list for PBXNativeTarget "App" */;
\t\t\tname = App;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};`)
    configBlocks.push(`\t\tCFG_APP_DEBUG /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${renderSettings(targetDebug)}
\t\t\t};
\t\t\tname = Debug;
\t\t};`)
    configBlocks.push(`\t\tCFG_APP_RELEASE /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${renderSettings(targetRelease)}
\t\t\t};
\t\t\tname = Release;
\t\t};`)
    listBlocks.push(`\t\tLIST_APP /* Build configuration list for PBXNativeTarget "App" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\tCFG_APP_DEBUG /* Debug */,
\t\t\t\tCFG_APP_RELEASE /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationName = Release;
\t\t};`)
    projectTargetRefs.push('\t\t\t\tAAA1 /* App */,')
  }

  let i = 0
  for (const t of opts.extraTargets ?? []) {
    i++
    const id = `EXTRA${i}`
    targetBlocks.push(`\t\t${id} /* ${t.name} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = LIST_${id} /* Build configuration list for PBXNativeTarget "${t.name}" */;
\t\t\tname = ${t.name};
\t\t\tproductType = "${t.productType}";
\t\t};`)
    configBlocks.push(`\t\tCFG_${id}_RELEASE /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${renderSettings(t.settings)}
\t\t\t};
\t\t\tname = Release;
\t\t};`)
    listBlocks.push(`\t\tLIST_${id} /* Build configuration list for PBXNativeTarget "${t.name}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\tCFG_${id}_RELEASE /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationName = Release;
\t\t};`)
    projectTargetRefs.push(`\t\t\t\t${id} /* ${t.name} */,`)
  }

  return `// !$*UTF8*$!
{
\tobjects = {
/* Begin PBXNativeTarget section */
${targetBlocks.join('\n')}
/* End PBXNativeTarget section */
/* Begin PBXProject section */
\t\tPROJ /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {
\t\t\t\tTargetAttributes = {
\t\t\t\t\tAAA1 = { ProvisioningStyle = Automatic; };
\t\t\t\t};
\t\t\t};
\t\t\tbuildConfigurationList = LIST_PROJECT /* Build configuration list for PBXProject "App" */;
\t\t\ttargets = (
${projectTargetRefs.join('\n')}
\t\t\t);
\t\t};
/* End PBXProject section */
/* Begin XCBuildConfiguration section */
\t\tCFG_PROJ_DEBUG /* Debug */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${renderSettings(projectSettings)}
\t\t\t};
\t\t\tname = Debug;
\t\t};
\t\tCFG_PROJ_RELEASE /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
${renderSettings(projectSettings)}
\t\t\t};
\t\t\tname = Release;
\t\t};
${configBlocks.join('\n')}
/* End XCBuildConfiguration section */
/* Begin XCConfigurationList section */
\t\tLIST_PROJECT /* Build configuration list for PBXProject "App" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\tCFG_PROJ_DEBUG /* Debug */,
\t\t\t\tCFG_PROJ_RELEASE /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationName = Release;
\t\t};
${listBlocks.join('\n')}
/* End XCConfigurationList section */
\t};
}
`
}

/** Write a pbxproj into the Capacitor `ios/App/App.xcodeproj` location. */
function projectWith(pbx: string, extraFiles: Record<string, string> = {}): string {
  return makeProject({
    'package.json': CAP8_PKG,
    'ios/App/App.xcodeproj/project.pbxproj': pbx,
    ...extraFiles,
  })
}

function ctx(projectDir: string, partial: Partial<ScanContext> = {}): ScanContext {
  return { appId: 'app.capgo.plugin.TutorialBuild', platform: 'ios', projectDir, ...partial }
}

// ── Clean grounding baseline ────────────────────────────────────────────────

describe('ios-xcode: clean Capacitor-8 SPM fixture scans clean (regression baseline)', () => {
  const dir = projectWith(makePbx())
  const checks = [
    deploymentTargetCapacitor,
    signingTeam,
    bundleIdMismatchAcrossConfigs,
    enableBitcodeLeftover,
    swiftVersionSanity,
    noAppTarget,
    multipleAppTargets,
  ]
  for (const check of checks) {
    it(`${check.id} returns [] on the clean fixture`, async () => {
      const c = ctx(dir)
      const applies = check.appliesTo ? check.appliesTo(c) : true
      const findings = applies ? await check.run(c) : []
      expect(findings).toEqual([])
    })
  }
})

describe('ios-xcode: grounding against a real-shaped pbxproj fixture (every check clean)', () => {
  // Self-contained inline fixture mirroring the real Capacitor-8 SPM tutorial
  // project's distinctive build settings (real bundle id, team, AppIcon name,
  // version pair) so the grounding assertions are REAL on CI, where the external
  // tutorial-app checkout does not exist. Previously this read an absolute path
  // outside the repo, which made the grounding pass vacuously / crash on CI.
  const realShapedTarget = {
    ASSETCATALOG_COMPILER_APPICON_NAME: 'AppIcon',
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: '1',
    DEVELOPMENT_TEAM: 'UVTJ336J2D',
    IPHONEOS_DEPLOYMENT_TARGET: '15.0',
    MARKETING_VERSION: '1.0',
    PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild',
    PRODUCT_NAME: 'Tutorial Build example app',
    SWIFT_VERSION: '5.0',
    TARGETED_DEVICE_FAMILY: '1,2',
  }
  const realDir = projectWith(makePbx({
    projectSettings: { IPHONEOS_DEPLOYMENT_TARGET: '15.0', SDKROOT: 'iphoneos' },
    targetDebug: { ...realShapedTarget },
    targetRelease: { ...realShapedTarget },
  }))
  const checks = [
    deploymentTargetCapacitor,
    signingTeam,
    bundleIdMismatchAcrossConfigs,
    enableBitcodeLeftover,
    swiftVersionSanity,
    noAppTarget,
    multipleAppTargets,
  ]
  for (const check of checks) {
    it(`${check.id} returns [] against the real-shaped fixture`, async () => {
      const c = ctx(realDir)
      const applies = check.appliesTo ? check.appliesTo(c) : true
      const findings = applies ? await check.run(c) : []
      expect(findings).toEqual([])
    })
  }
})

// ── ios/xcode-deployment-target-capacitor ───────────────────────────────────

describe('ios/xcode-deployment-target-capacitor', () => {
  it('errors when IPHONEOS_DEPLOYMENT_TARGET is below the Capacitor 8 floor (14)', async () => {
    const dir = projectWith(makePbx({ projectSettings: { IPHONEOS_DEPLOYMENT_TARGET: '12.0', SDKROOT: 'iphoneos' } }))
    expect(deploymentTargetCapacitor.appliesTo!(ctx(dir))).toBe(true)
    const findings = await deploymentTargetCapacitor.run(ctx(dir))
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('error')
    expect(findings[0].id).toBe('ios/xcode-deployment-target-capacitor')
    expect(findings[0].title).toContain('12')
  })
  it('passes at exactly the floor (14.0 on Cap8)', async () => {
    const dir = projectWith(makePbx({ projectSettings: { IPHONEOS_DEPLOYMENT_TARGET: '14.0', SDKROOT: 'iphoneos' } }))
    expect(await deploymentTargetCapacitor.run(ctx(dir))).toEqual([])
  })
  it('reads the app-target value too (target below floor errors even if project-level is fine)', async () => {
    const low = { IPHONEOS_DEPLOYMENT_TARGET: '11.0', PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild', DEVELOPMENT_TEAM: 'UVTJ336J2D', CODE_SIGN_STYLE: 'Automatic', SWIFT_VERSION: '5.0' }
    const dir = projectWith(makePbx({ targetDebug: { ...low }, targetRelease: { ...low }, projectSettings: { IPHONEOS_DEPLOYMENT_TARGET: '15.0', SDKROOT: 'iphoneos' } }))
    const findings = await deploymentTargetCapacitor.run(ctx(dir))
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('error')
  })
  it('appliesTo false when the key is absent everywhere (inherited)', async () => {
    const noTarget = { PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild', DEVELOPMENT_TEAM: 'UVTJ336J2D', CODE_SIGN_STYLE: 'Automatic', SWIFT_VERSION: '5.0' }
    const dir = projectWith(makePbx({ projectSettings: { SDKROOT: 'iphoneos' }, targetDebug: { ...noTarget }, targetRelease: { ...noTarget } }))
    expect(deploymentTargetCapacitor.appliesTo!(ctx(dir))).toBe(false)
  })
  it('appliesTo false when capacitorMajor is null (no package.json)', async () => {
    const dir = makeProject({ 'ios/App/App.xcodeproj/project.pbxproj': makePbx() })
    expect(deploymentTargetCapacitor.appliesTo!(ctx(dir))).toBe(false)
  })
  it('does not throw on a missing project (returns [])', async () => {
    const dir = makeProject({ 'package.json': CAP8_PKG })
    expect(await deploymentTargetCapacitor.run(ctx(dir))).toEqual([])
  })
})

// ── ios/xcode-signing-team ───────────────────────────────────────────────────

describe('ios/xcode-signing-team', () => {
  const noTeam = {
    CODE_SIGN_STYLE: 'Automatic',
    IPHONEOS_DEPLOYMENT_TARGET: '15.0',
    PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild',
    SWIFT_VERSION: '5.0',
  }
  it('warns (no upload) when CODE_SIGN_STYLE present but DEVELOPMENT_TEAM absent', async () => {
    const dir = projectWith(makePbx({ targetDebug: { ...noTeam }, targetRelease: { ...noTeam } }))
    expect(signingTeam.appliesTo!(ctx(dir))).toBe(true)
    const findings = await signingTeam.run(ctx(dir))
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].id).toBe('ios/xcode-signing-team')
  })
  it('escalates to error when uploading to the App Store', async () => {
    const dir = projectWith(makePbx({ targetDebug: { ...noTeam }, targetRelease: { ...noTeam } }))
    const c = ctx(dir, { distributionMode: 'app_store', credentials: { APPLE_KEY_ID: 'k', APPLE_ISSUER_ID: 'i', APPLE_KEY_CONTENT: 'c' } })
    const findings = await signingTeam.run(c)
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('error')
  })
  it('treats an empty-string DEVELOPMENT_TEAM as missing', async () => {
    const dir = projectWith(makePbx({ targetDebug: { ...noTeam, DEVELOPMENT_TEAM: '' }, targetRelease: { ...noTeam, DEVELOPMENT_TEAM: '' } }))
    expect((await signingTeam.run(ctx(dir))).length).toBe(1)
  })
  it('also fires for Manual signing without a team', async () => {
    const manual = { ...noTeam, CODE_SIGN_STYLE: 'Manual' }
    const dir = projectWith(makePbx({ targetDebug: { ...manual }, targetRelease: { ...manual } }))
    expect((await signingTeam.run(ctx(dir))).length).toBe(1)
  })
  it('suppressed (appliesTo false) when a provisioning map is present', async () => {
    const dir = projectWith(makePbx({ targetDebug: { ...noTeam }, targetRelease: { ...noTeam } }))
    const c = ctx(dir, { credentials: { CAPGO_IOS_PROVISIONING_MAP: JSON.stringify({ 'app.capgo.plugin.TutorialBuild': { profile: 'AAAA', name: 'p' } }) } })
    expect(signingTeam.appliesTo!(c)).toBe(false)
  })
  it('appliesTo false when CODE_SIGN_STYLE is absent (nothing to judge)', async () => {
    const noStyle = { IPHONEOS_DEPLOYMENT_TARGET: '15.0', PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild', SWIFT_VERSION: '5.0' }
    const dir = projectWith(makePbx({ targetDebug: { ...noStyle }, targetRelease: { ...noStyle } }))
    expect(signingTeam.appliesTo!(ctx(dir))).toBe(false)
  })
})

// ── ios/xcode-bundle-id-mismatch-across-configs ──────────────────────────────

describe('ios/xcode-bundle-id-mismatch-across-configs', () => {
  it('warns when Debug and Release bundle ids differ', async () => {
    const dir = projectWith(makePbx({
      targetDebug: { CODE_SIGN_STYLE: 'Automatic', DEVELOPMENT_TEAM: 'UVTJ336J2D', SWIFT_VERSION: '5.0', IPHONEOS_DEPLOYMENT_TARGET: '15.0', PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild.debug' },
      targetRelease: { CODE_SIGN_STYLE: 'Automatic', DEVELOPMENT_TEAM: 'UVTJ336J2D', SWIFT_VERSION: '5.0', IPHONEOS_DEPLOYMENT_TARGET: '15.0', PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild' },
    }))
    expect(bundleIdMismatchAcrossConfigs.appliesTo!(ctx(dir))).toBe(true)
    const findings = await bundleIdMismatchAcrossConfigs.run(ctx(dir))
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].id).toBe('ios/xcode-bundle-id-mismatch-across-configs')
    expect(findings[0].detail).toContain('app.capgo.plugin.TutorialBuild.debug')
  })
  it('passes when Debug == Release (the clean case)', async () => {
    const dir = projectWith(makePbx())
    expect(await bundleIdMismatchAcrossConfigs.run(ctx(dir))).toEqual([])
  })
})

// ── ios/xcode-enable-bitcode-leftover ────────────────────────────────────────

describe('ios/xcode-enable-bitcode-leftover', () => {
  it('warns when ENABLE_BITCODE = YES anywhere', async () => {
    const dir = projectWith(makePbx({ projectSettings: { IPHONEOS_DEPLOYMENT_TARGET: '15.0', ENABLE_BITCODE: 'YES' } }))
    expect(enableBitcodeLeftover.appliesTo!(ctx(dir))).toBe(true)
    const findings = await enableBitcodeLeftover.run(ctx(dir))
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].id).toBe('ios/xcode-enable-bitcode-leftover')
  })
  it('appliesTo false when ENABLE_BITCODE = NO', async () => {
    const dir = projectWith(makePbx({ projectSettings: { IPHONEOS_DEPLOYMENT_TARGET: '15.0', ENABLE_BITCODE: 'NO' } }))
    expect(enableBitcodeLeftover.appliesTo!(ctx(dir))).toBe(false)
  })
  it('appliesTo false when absent (the clean case)', async () => {
    const dir = projectWith(makePbx())
    expect(enableBitcodeLeftover.appliesTo!(ctx(dir))).toBe(false)
  })
})

// ── ios/xcode-swift-version-sanity ───────────────────────────────────────────

describe('ios/xcode-swift-version-sanity', () => {
  it('warns when SWIFT_VERSION < 5', async () => {
    const s = { CODE_SIGN_STYLE: 'Automatic', DEVELOPMENT_TEAM: 'UVTJ336J2D', IPHONEOS_DEPLOYMENT_TARGET: '15.0', PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild', SWIFT_VERSION: '4.2' }
    const dir = projectWith(makePbx({ targetDebug: { ...s }, targetRelease: { ...s } }))
    expect(swiftVersionSanity.appliesTo!(ctx(dir))).toBe(true)
    const findings = await swiftVersionSanity.run(ctx(dir))
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].id).toBe('ios/xcode-swift-version-sanity')
  })
  it('warns when SWIFT_VERSION is non-numeric', async () => {
    const s = { CODE_SIGN_STYLE: 'Automatic', DEVELOPMENT_TEAM: 'UVTJ336J2D', IPHONEOS_DEPLOYMENT_TARGET: '15.0', PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild', SWIFT_VERSION: 'swift5' }
    const dir = projectWith(makePbx({ targetDebug: { ...s }, targetRelease: { ...s } }))
    expect((await swiftVersionSanity.run(ctx(dir))).length).toBe(1)
  })
  it('passes at 5.0 (clean)', async () => {
    const dir = projectWith(makePbx())
    expect(await swiftVersionSanity.run(ctx(dir))).toEqual([])
  })
  it('appliesTo false when SWIFT_VERSION is absent (Obj-C-only target)', async () => {
    const s = { CODE_SIGN_STYLE: 'Automatic', DEVELOPMENT_TEAM: 'UVTJ336J2D', IPHONEOS_DEPLOYMENT_TARGET: '15.0', PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild' }
    const dir = projectWith(makePbx({ targetDebug: { ...s }, targetRelease: { ...s } }))
    expect(swiftVersionSanity.appliesTo!(ctx(dir))).toBe(false)
  })
})

// ── ios/xcode-no-app-target ──────────────────────────────────────────────────

describe('ios/xcode-no-app-target', () => {
  it('errors when the pbxproj parses but has zero application targets', async () => {
    const dir = projectWith(makePbx({
      includeAppTarget: false,
      extraTargets: [{ name: 'Ext', productType: 'com.apple.product-type.app-extension', settings: { PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild.ext', IPHONEOS_DEPLOYMENT_TARGET: '15.0' } }],
    }))
    expect(noAppTarget.appliesTo!(ctx(dir))).toBe(true)
    const findings = await noAppTarget.run(ctx(dir))
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('error')
    expect(findings[0].id).toBe('ios/xcode-no-app-target')
  })
  it('passes with exactly one application target (clean)', async () => {
    const dir = projectWith(makePbx())
    expect(await noAppTarget.run(ctx(dir))).toEqual([])
  })
  it('appliesTo false (skip) when readPbxproj is null', async () => {
    const dir = makeProject({ 'package.json': CAP8_PKG })
    expect(noAppTarget.appliesTo!(ctx(dir))).toBe(false)
  })
})

// ── ios/xcode-multiple-app-targets ───────────────────────────────────────────

describe('ios/xcode-multiple-app-targets', () => {
  it('warns when two application targets exist', async () => {
    const dir = projectWith(makePbx({
      extraTargets: [{ name: 'App2', productType: 'com.apple.product-type.application', settings: { PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild2', IPHONEOS_DEPLOYMENT_TARGET: '15.0' } }],
    }))
    expect(multipleAppTargets.appliesTo!(ctx(dir))).toBe(true)
    const findings = await multipleAppTargets.run(ctx(dir))
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].id).toBe('ios/xcode-multiple-app-targets')
  })
  it('does not count extensions (single app target + extension is clean)', async () => {
    const dir = projectWith(makePbx({
      extraTargets: [{ name: 'Ext', productType: 'com.apple.product-type.app-extension', settings: { PRODUCT_BUNDLE_IDENTIFIER: 'app.capgo.plugin.TutorialBuild.ext', IPHONEOS_DEPLOYMENT_TARGET: '15.0' } }],
    }))
    expect(multipleAppTargets.appliesTo!(ctx(dir))).toBe(false)
  })
  it('appliesTo false with a single app target (clean)', async () => {
    const dir = projectWith(makePbx())
    expect(multipleAppTargets.appliesTo!(ctx(dir))).toBe(false)
  })
})
