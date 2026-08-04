// test/prescan/checks-ios-pods-assets.test.ts
//
// §2.E (Pods / SPM) + §2.F (App icons / assets) of the iOS prescan expansion.
//
// Two fixture shapes: a CocoaPods-shaped project (Podfile + Pods/ + App.xcworkspace)
// and an SPM-shaped project (CapApp-SPM/Package.swift + Package.resolved). Both clean
// shapes scan with ZERO findings — the SPM clean case mirrors the real grounding
// tutorial-app exactly (single 1024 AppIcon, Package.resolved under the xcodeproj).
import { describe, expect, it } from 'bun:test'
import {
  appiconEmptyOrPlaceholder,
  appiconMarketingMissing,
  appiconReferencedFileMissing,
  podsCapacitorMissing,
  podsLockMissing,
  podsNotInstalled,
  spmCapacitorDependencyMissing,
  spmDeploymentTargetConsistency,
  spmPackageResolvedMissing,
} from '../../src/build/prescan/checks/ios-pods-assets'
import { makeCtx, makeProject } from './helpers'

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// Standard Capacitor Podfile (uses the capacitor_pods helper, NOT a literal pod 'Capacitor').
const CAPACITOR_PODFILE = `require_relative '../../node_modules/@capacitor/ios/scripts/pods_helpers'

platform :ios, '14.0'
use_frameworks!

install! 'cocoapods', :disable_input_output_paths => true

def capacitor_pods
  pod 'Capacitor', :path => '../../node_modules/@capacitor/ios'
  pod 'CapacitorCordova', :path => '../../node_modules/@capacitor/ios'
end

target 'App' do
  capacitor_pods
end`

// Standard CLI-managed SPM manifest (depends on capacitor-swift-pm + .product Capacitor).
const SPM_PACKAGE_SWIFT = `// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.3.1")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ]
        )
    ]
)`

const PACKAGE_RESOLVED = `{
  "originHash" : "abc123",
  "pins" : [],
  "version" : 3
}`

// pbxproj with a Release IPHONEOS_DEPLOYMENT_TARGET=15.0 (matches grounding).
function pbxproj(deploymentTarget = '15.0', iconName = 'AppIcon'): string {
  return `// !$*UTF8*$!
{
  ABCD0001 /* Release */ = {
    isa = XCBuildConfiguration;
    buildSettings = {
      IPHONEOS_DEPLOYMENT_TARGET = ${deploymentTarget};
      ASSETCATALOG_COMPILER_APPICON_NAME = ${iconName};
      PRODUCT_BUNDLE_IDENTIFIER = app.capgo.plugin.TutorialBuild;
    };
    name = Release;
  };
}`
}

function pbxprojWithDeploymentTargets(projectTarget: string, appTarget: string): string {
  return `// !$*UTF8*$!
{
  objects = {
    AAA1 /* App */ = { isa = PBXNativeTarget; buildConfigurationList = LIST_APP; name = App; productType = "com.apple.product-type.application"; };
    PROJ /* Project object */ = { isa = PBXProject; buildConfigurationList = LIST_PROJECT; targets = ( AAA1 ); };
    CFG_PROJECT_RELEASE /* Release */ = {
      isa = XCBuildConfiguration;
      buildSettings = {
        IPHONEOS_DEPLOYMENT_TARGET = ${projectTarget};
      };
      name = Release;
    };
    CFG_APP_RELEASE /* Release */ = {
      isa = XCBuildConfiguration;
      buildSettings = {
        IPHONEOS_DEPLOYMENT_TARGET = ${appTarget};
        PRODUCT_BUNDLE_IDENTIFIER = app.capgo.plugin.TutorialBuild;
      };
      name = Release;
    };
    LIST_PROJECT /* Build configuration list for PBXProject "App" */ = { isa = XCConfigurationList; buildConfigurations = ( CFG_PROJECT_RELEASE ); defaultConfigurationName = Release; };
    LIST_APP /* Build configuration list for PBXNativeTarget "App" */ = { isa = XCConfigurationList; buildConfigurations = ( CFG_APP_RELEASE ); defaultConfigurationName = Release; };
  };
}`
}

const APPICON_CONTENTS_1024 = `{
  "images": [
    {
      "idiom": "universal",
      "size": "1024x1024",
      "filename": "AppIcon-512@2x.png",
      "platform": "ios"
    }
  ],
  "info": { "author": "xcode", "version": 1 }
}`

// A healthy SPM project mirroring the grounding tutorial-app layout.
function cleanSpmFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'ios/App/CapApp-SPM/Package.swift': SPM_PACKAGE_SWIFT,
    'ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved': PACKAGE_RESOLVED,
    'ios/App/App.xcodeproj/project.pbxproj': pbxproj(),
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json': APPICON_CONTENTS_1024,
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png': 'PNGDATA',
    ...extra,
  }
}

// A healthy CocoaPods project: Podfile + Podfile.lock + Pods/ + App.xcworkspace + appicon.
function cleanPodsFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'ios/App/Podfile': CAPACITOR_PODFILE,
    'ios/App/Podfile.lock': 'PODFILE CHECKSUM: abc',
    'ios/App/Pods/Manifest.lock': 'PODFILE CHECKSUM: abc',
    'ios/App/App.xcworkspace/contents.xcworkspacedata': '<Workspace></Workspace>',
    'ios/App/App.xcodeproj/project.pbxproj': pbxproj(),
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json': APPICON_CONTENTS_1024,
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png': 'PNGDATA',
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// §2.E Pods checks
// ---------------------------------------------------------------------------

describe('ios/pods-not-installed', () => {
  it.each(['win32', 'linux'] as const)('does NOT apply on %s', (hostPlatform) => {
    const ctx = makeCtx({ projectDir: makeProject(cleanPodsFiles()), hostPlatform })
    expect(podsNotInstalled.appliesTo?.(ctx) ?? true).toBe(false)
  })

  it('does NOT apply to an SPM project (no Podfile)', () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()) })
    expect(podsNotInstalled.appliesTo?.(ctx) ?? true).toBe(false)
  })

  it('is clean when Pods/ and App.xcworkspace both exist', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanPodsFiles()) })
    expect(await podsNotInstalled.run(ctx)).toEqual([])
  })

  it('warns (not errors — builder runs pod install) when Pods/ is missing', async () => {
    const files = cleanPodsFiles()
    delete files['ios/App/Pods/Manifest.lock']
    const ctx = makeCtx({ projectDir: makeProject(files) })
    const f = await podsNotInstalled.run(ctx)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every(x => x.severity === 'warning')).toBe(true)
    expect(f.every(x => x.id === 'ios/pods-not-installed')).toBe(true)
  })

  it('warns when App.xcworkspace is missing', async () => {
    const files = cleanPodsFiles()
    delete files['ios/App/App.xcworkspace/contents.xcworkspacedata']
    const ctx = makeCtx({ projectDir: makeProject(files) })
    const f = await podsNotInstalled.run(ctx)
    expect(f.some(x => x.severity === 'warning')).toBe(true)
  })
})

describe('ios/pods-lock-missing', () => {
  it.each(['win32', 'linux'] as const)('does NOT apply on %s', (hostPlatform) => {
    const ctx = makeCtx({ projectDir: makeProject(cleanPodsFiles()), hostPlatform })
    expect(podsLockMissing.appliesTo?.(ctx) ?? true).toBe(false)
  })

  it('is clean when Podfile.lock exists', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanPodsFiles()) })
    expect(await podsLockMissing.run(ctx)).toEqual([])
  })

  it('warns when Podfile.lock is absent', async () => {
    const files = cleanPodsFiles()
    delete files['ios/App/Podfile.lock']
    const ctx = makeCtx({ projectDir: makeProject(files) })
    const f = await podsLockMissing.run(ctx)
    expect(f.some(x => x.severity === 'warning' && x.id === 'ios/pods-lock-missing')).toBe(true)
  })

  it('does NOT apply to an SPM project', () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()) })
    expect(podsLockMissing.appliesTo?.(ctx) ?? true).toBe(false)
  })
})

describe('ios/pods-capacitor-missing', () => {
  it('is clean when the Podfile wires Capacitor (capacitor_pods helper)', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanPodsFiles()) })
    expect(await podsCapacitorMissing.run(ctx)).toEqual([])
  })

  it('warns (not errors — high FP, builder builds from Podfile) when no Capacitor pod', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanPodsFiles({
        'ios/App/Podfile': `platform :ios, '14.0'\ntarget 'App' do\n  pod 'SomethingElse'\nend`,
      })),
    })
    const f = await podsCapacitorMissing.run(ctx)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every(x => x.severity === 'warning' && x.id === 'ios/pods-capacitor-missing')).toBe(true)
  })

  it('does NOT apply to an SPM project', () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()) })
    expect(podsCapacitorMissing.appliesTo?.(ctx) ?? true).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §2.E SPM checks
// ---------------------------------------------------------------------------

describe('ios/spm-package-resolved-missing', () => {
  it('is clean when Package.resolved exists under the xcodeproj (grounding layout)', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()) })
    expect(await spmPackageResolvedMissing.run(ctx)).toEqual([])
  })

  it('is clean when Package.resolved lives next to Package.swift instead', async () => {
    const files = cleanSpmFiles()
    delete files['ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved']
    files['ios/App/CapApp-SPM/Package.resolved'] = PACKAGE_RESOLVED
    const ctx = makeCtx({ projectDir: makeProject(files) })
    expect(await spmPackageResolvedMissing.run(ctx)).toEqual([])
  })

  it('warns (not errors — builder resolves SPM during build_app) when neither Package.resolved exists', async () => {
    const files = cleanSpmFiles()
    delete files['ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved']
    const ctx = makeCtx({ projectDir: makeProject(files) })
    const f = await spmPackageResolvedMissing.run(ctx)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every(x => x.severity === 'warning' && x.id === 'ios/spm-package-resolved-missing')).toBe(true)
  })

  it('does NOT apply to a Pods project (no Package.swift)', () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanPodsFiles()) })
    expect(spmPackageResolvedMissing.appliesTo?.(ctx) ?? true).toBe(false)
  })
})

describe('ios/spm-capacitor-dependency-missing', () => {
  it('is clean when Package.swift declares capacitor-swift-pm + .product Capacitor', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()) })
    expect(await spmCapacitorDependencyMissing.run(ctx)).toEqual([])
  })

  it('warns (not errors — builder does not cap-sync but high FP) when capacitor dep absent', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanSpmFiles({
        'ios/App/CapApp-SPM/Package.swift': `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "CapApp-SPM", platforms: [.iOS(.v15)], dependencies: [], targets: [])`,
      })),
    })
    const f = await spmCapacitorDependencyMissing.run(ctx)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every(x => x.severity === 'warning' && x.id === 'ios/spm-capacitor-dependency-missing')).toBe(true)
  })

  it('does NOT apply to a Pods project', () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanPodsFiles()) })
    expect(spmCapacitorDependencyMissing.appliesTo?.(ctx) ?? true).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// §2.F App icon checks
// ---------------------------------------------------------------------------

describe('ios/appicon-empty-or-placeholder', () => {
  it('is clean when the appiconset has a real icon image (grounding)', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()) })
    expect(await appiconEmptyOrPlaceholder.run(ctx)).toEqual([])
  })

  it('errors when the AppIcon.appiconset directory is missing', async () => {
    const files = cleanSpmFiles()
    delete files['ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json']
    delete files['ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png']
    const ctx = makeCtx({ projectDir: makeProject(files) })
    const f = await appiconEmptyOrPlaceholder.run(ctx)
    expect(f.some(x => x.id === 'ios/appicon-empty-or-placeholder')).toBe(true)
  })

  it('warns (not errors — actool tolerates empty for ad_hoc) when no icon images and NOT uploading', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanSpmFiles({
        'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json': `{ "images": [], "info": { "version": 1 } }`,
      })),
      distributionMode: 'ad_hoc',
    })
    const f = await appiconEmptyOrPlaceholder.run(ctx)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every(x => x.severity === 'warning')).toBe(true)
  })

  it('escalates to error when no icon images AND uploading to App Store (ITMS-90704 will block)', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanSpmFiles({
        'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json': `{ "images": [], "info": { "version": 1 } }`,
      })),
      distributionMode: 'app_store',
      credentials: { APPLE_KEY_ID: 'k', APPLE_ISSUER_ID: 'i', APPLE_KEY_CONTENT: 'c' },
    })
    const f = await appiconEmptyOrPlaceholder.run(ctx)
    expect(f.some(x => x.severity === 'error')).toBe(true)
  })

  it('errors when Contents.json is malformed', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanSpmFiles({
        'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json': `{ not valid json`,
      })),
      distributionMode: 'app_store',
      credentials: { APPLE_KEY_ID: 'k', APPLE_ISSUER_ID: 'i', APPLE_KEY_CONTENT: 'c' },
    })
    const f = await appiconEmptyOrPlaceholder.run(ctx)
    expect(f.some(x => x.severity === 'error')).toBe(true)
  })
})

describe('ios/appicon-referenced-file-missing', () => {
  it('is clean when every referenced filename exists on disk (grounding)', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()) })
    expect(await appiconReferencedFileMissing.run(ctx)).toEqual([])
  })

  it('does NOT apply when Contents.json is absent', () => {
    const files = cleanSpmFiles()
    delete files['ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json']
    const ctx = makeCtx({ projectDir: makeProject(files) })
    expect(appiconReferencedFileMissing.appliesTo?.(ctx) ?? true).toBe(false)
  })

  it('ERRORS (actool fails server-side) when a referenced PNG is missing from disk', async () => {
    const files = cleanSpmFiles()
    delete files['ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png']
    const ctx = makeCtx({ projectDir: makeProject(files) })
    const f = await appiconReferencedFileMissing.run(ctx)
    expect(f.length).toBeGreaterThan(0)
    expect(f.every(x => x.severity === 'error' && x.id === 'ios/appicon-referenced-file-missing')).toBe(true)
    // Filename is surfaced; no credential material ever appears in findings.
    expect(f.some(x => (x.detail ?? '').includes('AppIcon-512@2x.png'))).toBe(true)
  })
})

describe('ios/appicon-marketing-missing', () => {
  it('does NOT apply when not uploading to App Store (ad_hoc)', () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()), distributionMode: 'ad_hoc' })
    expect(appiconMarketingMissing.appliesTo?.(ctx) ?? true).toBe(false)
  })

  it('is clean (1024 present) when uploading to App Store', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanSpmFiles()),
      distributionMode: 'app_store',
      credentials: { APPLE_KEY_ID: 'k', APPLE_ISSUER_ID: 'i', APPLE_KEY_CONTENT: 'c' },
    })
    expect(await appiconMarketingMissing.run(ctx)).toEqual([])
  })

  it('errors (upload-gated, ITMS-90704) when the 1024 marketing icon is absent', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanSpmFiles({
        'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json': `{
          "images": [{ "idiom": "iphone", "size": "60x60", "scale": "3x", "filename": "icon-60.png" }],
          "info": { "version": 1 }
        }`,
      })),
      distributionMode: 'app_store',
      credentials: { APPLE_KEY_ID: 'k', APPLE_ISSUER_ID: 'i', APPLE_KEY_CONTENT: 'c' },
    })
    const f = await appiconMarketingMissing.run(ctx)
    expect(f.some(x => x.severity === 'error' && x.id === 'ios/appicon-marketing-missing')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// §2.F SPM deployment-target consistency
// ---------------------------------------------------------------------------

describe('ios/spm-deployment-target-consistency', () => {
  it('is clean when pbxproj target >= Package.swift min (grounding 15.0 vs .v15)', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()) })
    expect(await spmDeploymentTargetConsistency.run(ctx)).toEqual([])
  })

  it('warns when pbxproj target < Package.swift min (the dangerous direction)', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanSpmFiles({
        'ios/App/App.xcodeproj/project.pbxproj': pbxprojWithDeploymentTargets('14.0', '14.0'),
      })),
    })
    const f = await spmDeploymentTargetConsistency.run(ctx)
    expect(f.some(x => x.severity === 'warning' && x.id === 'ios/spm-deployment-target-consistency')).toBe(true)
  })

  it('warns when the app target is below Package.swift even if the project target is higher', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanSpmFiles({
        'ios/App/App.xcodeproj/project.pbxproj': pbxprojWithDeploymentTargets('16.0', '14.0'),
      })),
    })
    const findings = await spmDeploymentTargetConsistency.run(ctx)
    expect(findings.some(x => x.severity === 'warning' && x.id === 'ios/spm-deployment-target-consistency')).toBe(true)
  })

  it('is clean when pbxproj target > Package.swift min', async () => {
    const ctx = makeCtx({
      projectDir: makeProject(cleanSpmFiles({
        'ios/App/App.xcodeproj/project.pbxproj': pbxprojWithDeploymentTargets('16.0', '16.0'),
      })),
    })
    expect(await spmDeploymentTargetConsistency.run(ctx)).toEqual([])
  })

  it('does NOT apply when IPHONEOS_DEPLOYMENT_TARGET is absent (inherited/unknown)', () => {
    const files = cleanSpmFiles()
    files['ios/App/App.xcodeproj/project.pbxproj'] = `// !$*UTF8*$!
{
  ABCD0001 /* Release */ = {
    isa = XCBuildConfiguration;
    buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = app.capgo.plugin.TutorialBuild; };
    name = Release;
  };
}`
    const ctx = makeCtx({ projectDir: makeProject(files) })
    expect(spmDeploymentTargetConsistency.appliesTo?.(ctx) ?? true).toBe(false)
  })

  it('does NOT apply to a Pods project', () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanPodsFiles()) })
    expect(spmDeploymentTargetConsistency.appliesTo?.(ctx) ?? true).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Degradation / no-crash on partial projects
// ---------------------------------------------------------------------------

describe('ios-pods-assets - partial / non-Capacitor projects never crash', () => {
  const ALL = [
    podsNotInstalled,
    podsLockMissing,
    podsCapacitorMissing,
    spmPackageResolvedMissing,
    spmCapacitorDependencyMissing,
    appiconEmptyOrPlaceholder,
    appiconReferencedFileMissing,
    appiconMarketingMissing,
    spmDeploymentTargetConsistency,
  ]

  it('every check early-returns [] on an empty project dir - except appicon-empty (always reports a missing set)', async () => {
    const ctx = makeCtx({ projectDir: makeProject({}) })
    for (const check of ALL) {
      if (check.appliesTo && !check.appliesTo(ctx))
        continue
      // appicon-empty-or-placeholder is "always (iOS, degrade in run)" per §3: a
      // project with no AppIcon set must surface that, not stay silent.
      if (check.id === 'ios/appicon-empty-or-placeholder') {
        const f = await check.run(ctx)
        expect(f.length).toBe(1)
        expect(f[0].id).toBe('ios/appicon-empty-or-placeholder')
        expect(f[0].title).toContain('AppIcon.appiconset is missing')
        continue
      }
      expect(await check.run(ctx)).toEqual([])
    }
  })

  it('full clean SPM project (grounding mirror) yields ZERO findings across all checks', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanSpmFiles()), distributionMode: 'app_store', credentials: { APPLE_KEY_ID: 'k', APPLE_ISSUER_ID: 'i', APPLE_KEY_CONTENT: 'c' } })
    for (const check of ALL) {
      if (check.appliesTo && !check.appliesTo(ctx))
        continue
      expect(await check.run(ctx)).toEqual([])
    }
  })

  it('full clean CocoaPods project yields ZERO findings across all checks', async () => {
    const ctx = makeCtx({ projectDir: makeProject(cleanPodsFiles()), distributionMode: 'app_store', credentials: { APPLE_KEY_ID: 'k', APPLE_ISSUER_ID: 'i', APPLE_KEY_CONTENT: 'c' } })
    for (const check of ALL) {
      if (check.appliesTo && !check.appliesTo(ctx))
        continue
      expect(await check.run(ctx)).toEqual([])
    }
  })
})
