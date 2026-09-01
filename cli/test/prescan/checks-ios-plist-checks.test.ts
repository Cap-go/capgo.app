// test/prescan/checks-ios-plist-checks.test.ts
//
// §2.A Info.plist / App Store checks. The primary regression fixture is the real
// Capacitor-8 SPM tutorial project, which MUST scan clean (zero findings) across
// every check. Per-check failing fixtures are minimal mutations of a healthy
// in-memory plist; the unresolved-$() fixture proves the resolvePlistValue guard.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  plistAtsArbitraryLoads,
  plistBackgroundModesSanity,
  plistBundleIdFormat,
  plistDisplayName,
  plistEncryptionCompliance,
  plistLaunchStoryboard,
  plistOrientationsMultitasking,
  plistOrientationsPresent,
  plistRequiredDeviceArm64,
  plistVersionBuildFormat,
  plistVersionShortFormat,
} from '../../src/build/prescan/checks/ios-plist-checks'
import { makeCtx, makeProject } from './helpers'

const plist = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>`

// A pbxproj whose Release config resolves every $(VAR) the Capacitor Info.plist
// references to a healthy literal.
const PBX = `
		AAAA /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = app.capgo.plugin.TutorialBuild;
				MARKETING_VERSION = 1.0;
				CURRENT_PROJECT_VERSION = 1;
				PRODUCT_NAME = "Tutorial Build example app";
				TARGETED_DEVICE_FAMILY = "1,2";
			};
			name = Release;
		};
`

// Minimal healthy plist body (build-variable refs, like a real Capacitor app).
const HEALTHY_BODY = `<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>CFBundleDisplayName</key><string>Tutorial Build example app</string>
<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>UILaunchStoryboardName</key><string>LaunchScreen</string>
<key>UISupportedInterfaceOrientations</key><array>
<string>UIInterfaceOrientationPortrait</string>
<string>UIInterfaceOrientationLandscapeLeft</string>
<string>UIInterfaceOrientationLandscapeRight</string>
</array>
<key>UISupportedInterfaceOrientations~ipad</key><array>
<string>UIInterfaceOrientationPortrait</string>
<string>UIInterfaceOrientationPortraitUpsideDown</string>
<string>UIInterfaceOrientationLandscapeLeft</string>
<string>UIInterfaceOrientationLandscapeRight</string>
</array>`

/** Build a ctx whose Info.plist + pbxproj are written at the Capacitor paths. */
function ctxFor(plistBody: string, opts: { pbx?: string, partial?: Parameters<typeof makeCtx>[0] extends never ? never : Record<string, unknown> } = {}) {
  const files: Record<string, string> = { 'ios/App/App/Info.plist': plist(plistBody) }
  files['ios/App/App.xcodeproj/project.pbxproj'] = opts.pbx ?? PBX
  const dir = makeProject(files)
  return makeCtx({ projectDir: dir, platform: 'ios', ...(opts.partial as object) })
}

const ALL_CHECKS = [
  plistBundleIdFormat,
  plistVersionShortFormat,
  plistVersionBuildFormat,
  plistEncryptionCompliance,
  plistAtsArbitraryLoads,
  plistLaunchStoryboard,
  plistOrientationsMultitasking,
  plistOrientationsPresent,
  plistDisplayName,
  plistBackgroundModesSanity,
  plistRequiredDeviceArm64,
]

// Run a check honoring its appliesTo gate (returns [] when the gate is false),
// mirroring how the engine applies appliesTo before run().
async function runGated(check: typeof ALL_CHECKS[number], ctx: ReturnType<typeof makeCtx>) {
  if (check.appliesTo && !check.appliesTo(ctx))
    return []
  return check.run(ctx)
}

describe('§2.A regression baseline — real-shaped Capacitor-8 project scans clean', () => {
  // Self-contained inline fixture: HEALTHY_BODY + PBX mirror the real Capacitor-8
  // SPM tutorial project's Info.plist + pbxproj shape ($()-ref'd bundle id /
  // versions resolved by the Release config, all four ~ipad orientations, literal
  // display name). Written to a temp project dir so the grounding assertions are
  // REAL on CI — the previous external absolute path made every check early-return
  // [] vacuously (the plist reader returns null on a missing file).
  const groundedCtx = ctxFor(HEALTHY_BODY)

  for (const check of ALL_CHECKS) {
    it(`${check.id} produces no finding`, async () => {
      expect(await runGated(check, groundedCtx)).toEqual([])
    })
  }

  it('sanity: the inline fixture files are written and readable', () => {
    const infoPlist = join(groundedCtx.projectDir, 'ios', 'App', 'App', 'Info.plist')
    const pbxproj = join(groundedCtx.projectDir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj')
    expect(readFileSync(infoPlist, 'utf8')).toContain('CFBundleIdentifier')
    expect(readFileSync(pbxproj, 'utf8')).toContain('PRODUCT_BUNDLE_IDENTIFIER')
    expect(groundedCtx.platform).toBe('ios')
  })
})

describe('synthetic healthy plist scans clean', () => {
  for (const check of ALL_CHECKS) {
    it(`${check.id} produces no finding on the healthy in-memory plist`, async () => {
      expect(await runGated(check, ctxFor(HEALTHY_BODY))).toEqual([])
    })
  }
})

describe('ios/plist-bundle-id-format', () => {
  it('errors when CFBundleIdentifier is absent', async () => {
    const f = await plistBundleIdFormat.run(ctxFor(`<key>CFBundleVersion</key><string>1</string>`))
    expect(f.some(x => x.severity === 'error')).toBe(true)
  })
  it('errors on an underscore / space bundle id', async () => {
    const f = await plistBundleIdFormat.run(ctxFor(`<key>CFBundleIdentifier</key><string>com.my_app.bad id</string>`))
    expect(f.some(x => x.severity === 'error' && x.title.includes('com.my_app.bad id'))).toBe(true)
  })
  it('errors on a single-segment (non reverse-DNS) id', async () => {
    const f = await plistBundleIdFormat.run(ctxFor(`<key>CFBundleIdentifier</key><string>justone</string>`))
    expect(f.some(x => x.severity === 'error')).toBe(true)
  })
  it('skips an unresolved $() reference (no matching pbxproj setting)', async () => {
    const f = await plistBundleIdFormat.run(ctxFor(`<key>CFBundleIdentifier</key><string>$(UNRESOLVED_ID)</string>`, { pbx: '' }))
    expect(f).toEqual([])
  })
  it('passes a literal reverse-DNS id', async () => {
    const f = await plistBundleIdFormat.run(ctxFor(`<key>CFBundleIdentifier</key><string>app.capgo.plugin.TutorialBuild</string>`))
    expect(f).toEqual([])
  })
})

describe('ios/plist-version-short-format', () => {
  it('errors on a non-numeric marketing version (ITMS-90060)', async () => {
    const f = await plistVersionShortFormat.run(ctxFor(`<key>CFBundleShortVersionString</key><string>1.0-beta</string>`))
    expect(f.some(x => x.severity === 'error' && x.title.includes('1.0-beta'))).toBe(true)
  })
  it('errors on a 4-segment version', async () => {
    const f = await plistVersionShortFormat.run(ctxFor(`<key>CFBundleShortVersionString</key><string>1.2.3.4</string>`))
    expect(f.some(x => x.severity === 'error')).toBe(true)
  })
  it('SKIPS when the key is absent (presence owned by infoplist-sanity)', async () => {
    const f = await plistVersionShortFormat.run(ctxFor(`<key>CFBundleVersion</key><string>1</string>`))
    expect(f).toEqual([])
  })
  it('skips an unresolved $() reference', async () => {
    const f = await plistVersionShortFormat.run(ctxFor(`<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>`, { pbx: '' }))
    expect(f).toEqual([])
  })
  it('passes 1.4.2', async () => {
    const f = await plistVersionShortFormat.run(ctxFor(`<key>CFBundleShortVersionString</key><string>1.4.2</string>`))
    expect(f).toEqual([])
  })
  it('passes a legacy two-part version supported by the builder auto-bump', async () => {
    const f = await plistVersionShortFormat.run(ctxFor(`<key>CFBundleShortVersionString</key><string>1.5</string>`))
    expect(f).toEqual([])
  })
  it('errors on a one-part version rejected by the builder auto-bump', async () => {
    const f = await plistVersionShortFormat.run(ctxFor(`<key>CFBundleShortVersionString</key><string>1</string>`))
    expect(f.some(x => x.id === 'ios/plist-version-short-format' && x.severity === 'error')).toBe(true)
  })
})

describe('ios/plist-version-build-format', () => {
  it('errors on a non-numeric build version', async () => {
    const f = await plistVersionBuildFormat.run(ctxFor(`<key>CFBundleVersion</key><string>build-42</string>`))
    expect(f.some(x => x.severity === 'error')).toBe(true)
  })
  it('SKIPS when the key is absent', async () => {
    const f = await plistVersionBuildFormat.run(ctxFor(`<key>CFBundleShortVersionString</key><string>1.0</string>`))
    expect(f).toEqual([])
  })
  it('passes a numeric build (42)', async () => {
    const f = await plistVersionBuildFormat.run(ctxFor(`<key>CFBundleVersion</key><string>42</string>`))
    expect(f).toEqual([])
  })
  it('passes zero and the builder timestamp fallback allowed by Apple', async () => {
    const zero = await plistVersionBuildFormat.run(ctxFor(`<key>CFBundleVersion</key><string>0</string>`))
    const timestamp = await plistVersionBuildFormat.run(ctxFor(`<key>CFBundleVersion</key><string>20260801070000</string>`))
    expect(zero).toEqual([])
    expect(timestamp).toEqual([])
  })
})

describe('ios/plist-encryption-compliance (upload-gated)', () => {
  const uploadCreds = { APPLE_KEY_ID: 'ABCDE12345', APPLE_ISSUER_ID: '12345678-1234-1234-1234-123456789012', APPLE_KEY_CONTENT: 'x' }
  it('does not apply when not uploading', () => {
    const ctx = ctxFor(HEALTHY_BODY)
    expect(plistEncryptionCompliance.appliesTo?.(ctx)).toBe(false)
  })
  it('warns when uploading and the key is missing', async () => {
    const ctx = ctxFor(HEALTHY_BODY, { partial: { credentials: uploadCreds, distributionMode: 'app_store' } })
    expect(plistEncryptionCompliance.appliesTo?.(ctx)).toBe(true)
    const f = await plistEncryptionCompliance.run(ctx)
    expect(f.some(x => x.severity === 'warning')).toBe(true)
  })
  it('passes when uploading and the key is present', async () => {
    const body = `${HEALTHY_BODY}<key>ITSAppUsesNonExemptEncryption</key><false/>`
    const ctx = ctxFor(body, { partial: { credentials: uploadCreds, distributionMode: 'app_store' } })
    expect(await plistEncryptionCompliance.run(ctx)).toEqual([])
  })
})

describe('ios/plist-ats-arbitrary-loads', () => {
  it('warns when NSAllowsArbitraryLoads is true (no upload)', async () => {
    const body = `${HEALTHY_BODY}<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>`
    const f = await plistAtsArbitraryLoads.run(ctxFor(body))
    expect(f.length).toBe(1)
    expect(f[0].severity).toBe('warning')
  })
  it('escalates to error on upload + server.url dev config', async () => {
    const body = `${HEALTHY_BODY}<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>`
    const ctx = ctxFor(body, { partial: {
      credentials: { APPLE_KEY_ID: 'ABCDE12345', APPLE_ISSUER_ID: '12345678-1234-1234-1234-123456789012', APPLE_KEY_CONTENT: 'x' },
      distributionMode: 'app_store',
      config: { appId: 'x', appName: 'x', webDir: 'd', server: { url: 'http://10.0.0.2:3000' } } as never,
    } })
    const f = await plistAtsArbitraryLoads.run(ctx)
    expect(f.some(x => x.severity === 'error')).toBe(true)
  })
  it('no finding when NSAppTransportSecurity is absent', async () => {
    expect(await plistAtsArbitraryLoads.run(ctxFor(HEALTHY_BODY))).toEqual([])
  })
  it('no finding when NSAllowsArbitraryLoads is false', async () => {
    const body = `${HEALTHY_BODY}<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><false/></dict>`
    expect(await plistAtsArbitraryLoads.run(ctxFor(body))).toEqual([])
  })
  it('still detects NSAllowsArbitraryLoads=true when a nested NSExceptionDomains dict precedes it', async () => {
    // The nested NSExceptionDomains dict comes BEFORE NSAllowsArbitraryLoads —
    // a first-`</dict>` capture would truncate the ATS block and miss the flag.
    const ats = `<key>NSAppTransportSecurity</key><dict>`
      + `<key>NSExceptionDomains</key><dict><key>example.com</key><dict><key>NSIncludesSubdomains</key><true/></dict></dict>`
      + `<key>NSAllowsArbitraryLoads</key><true/>`
      + `</dict>`
    const f = await plistAtsArbitraryLoads.run(ctxFor(`${HEALTHY_BODY}${ats}`))
    expect(f.length).toBe(1)
    expect(f[0].severity).toBe('warning')
  })
})

describe('ios/plist-launch-storyboard', () => {
  it('errors when neither UILaunchStoryboardName nor UILaunchScreen is present', async () => {
    const f = await plistLaunchStoryboard.run(ctxFor(`<key>CFBundleVersion</key><string>1</string>`))
    expect(f.some(x => x.severity === 'error')).toBe(true)
  })
  it('passes with UILaunchScreen dict', async () => {
    const f = await plistLaunchStoryboard.run(ctxFor(`<key>UILaunchScreen</key><dict/>`))
    expect(f).toEqual([])
  })
})

describe('ios/plist-orientations-multitasking', () => {
  it('does not apply when device family lacks iPad (no "2")', () => {
    const pbx = PBX.replace('TARGETED_DEVICE_FAMILY = "1,2";', 'TARGETED_DEVICE_FAMILY = "1";')
    const ctx = ctxFor(HEALTHY_BODY, { pbx })
    expect(plistOrientationsMultitasking.appliesTo?.(ctx)).toBe(false)
  })
  it('does not apply when UIRequiresFullScreen is true', () => {
    const body = `${HEALTHY_BODY}<key>UIRequiresFullScreen</key><true/>`
    const ctx = ctxFor(body)
    expect(plistOrientationsMultitasking.appliesTo?.(ctx)).toBe(false)
  })
  it('warns when the ~ipad array is missing an orientation', async () => {
    const body = HEALTHY_BODY.replace('<string>UIInterfaceOrientationPortraitUpsideDown</string>\n', '')
    const ctx = ctxFor(body)
    expect(plistOrientationsMultitasking.appliesTo?.(ctx)).toBe(true)
    const f = await plistOrientationsMultitasking.run(ctx)
    expect(f.some(x => x.severity === 'warning' && x.title.includes('PortraitUpsideDown'))).toBe(true)
  })
  it('passes when ~ipad has all four (grounding)', async () => {
    const ctx = ctxFor(HEALTHY_BODY)
    expect(await plistOrientationsMultitasking.run(ctx)).toEqual([])
  })
})

describe('ios/plist-orientations-present', () => {
  it('warns when the key is absent', async () => {
    const f = await plistOrientationsPresent.run(ctxFor(`<key>CFBundleVersion</key><string>1</string>`))
    expect(f.some(x => x.severity === 'warning')).toBe(true)
  })
  it('warns when present but empty', async () => {
    const f = await plistOrientationsPresent.run(ctxFor(`<key>UISupportedInterfaceOrientations</key><array></array>`))
    expect(f.some(x => x.severity === 'warning')).toBe(true)
  })
  it('warns naming an invalid token', async () => {
    const f = await plistOrientationsPresent.run(ctxFor(`<key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationSideways</string></array>`))
    expect(f.some(x => x.severity === 'warning' && x.title.includes('UIInterfaceOrientationSideways'))).toBe(true)
  })
  it('passes the grounding three-orientation iPhone array', async () => {
    expect(await plistOrientationsPresent.run(ctxFor(HEALTHY_BODY))).toEqual([])
  })
})

describe('ios/plist-display-name', () => {
  it('warns when both display name and name are missing/empty', async () => {
    const f = await plistDisplayName.run(ctxFor(`<key>CFBundleVersion</key><string>1</string>`))
    expect(f.some(x => x.severity === 'warning')).toBe(true)
  })
  it('warns when both still unresolved $() with no pbx match', async () => {
    const body = `<key>CFBundleDisplayName</key><string>$(NO_SUCH)</string><key>CFBundleName</key><string>$(PRODUCT_NAME)</string>`
    const f = await plistDisplayName.run(ctxFor(body, { pbx: '' }))
    expect(f.some(x => x.severity === 'warning')).toBe(true)
  })
  it('passes a literal display name (grounding)', async () => {
    expect(await plistDisplayName.run(ctxFor(HEALTHY_BODY))).toEqual([])
  })
  it('passes when only CFBundleName resolves via pbx', async () => {
    const body = `<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>`
    expect(await plistDisplayName.run(ctxFor(body))).toEqual([])
  })
})

describe('ios/plist-background-modes-sanity', () => {
  it('does not apply without UIBackgroundModes', () => {
    expect(plistBackgroundModesSanity.appliesTo?.(ctxFor(HEALTHY_BODY))).toBe(false)
  })
  it('warns on an invalid background mode token', async () => {
    const body = `${HEALTHY_BODY}<key>UIBackgroundModes</key><array><string>teleport</string></array>`
    const ctx = ctxFor(body)
    expect(plistBackgroundModesSanity.appliesTo?.(ctx)).toBe(true)
    const f = await plistBackgroundModesSanity.run(ctx)
    expect(f.some(x => x.severity === 'warning' && x.title.includes('teleport'))).toBe(true)
  })
  it('passes a valid mode (audio) when not uploading', async () => {
    const body = `${HEALTHY_BODY}<key>UIBackgroundModes</key><array><string>audio</string></array>`
    expect(await plistBackgroundModesSanity.run(ctxFor(body))).toEqual([])
  })
  it('warns on location without a usage string ONLY when uploading', async () => {
    const body = `${HEALTHY_BODY}<key>UIBackgroundModes</key><array><string>location</string></array>`
    // not uploading -> no 2.5.4 sub-check finding
    expect(await plistBackgroundModesSanity.run(ctxFor(body))).toEqual([])
    // uploading -> warns
    const ctx = ctxFor(body, { partial: {
      credentials: { APPLE_KEY_ID: 'ABCDE12345', APPLE_ISSUER_ID: '12345678-1234-1234-1234-123456789012', APPLE_KEY_CONTENT: 'x' },
      distributionMode: 'app_store',
    } })
    const f = await plistBackgroundModesSanity.run(ctx)
    expect(f.some(x => x.severity === 'warning' && /location/i.test(`${x.title} ${x.detail ?? ''}`))).toBe(true)
  })
  it('passes location WITH a usage string when uploading', async () => {
    const body = `${HEALTHY_BODY}<key>UIBackgroundModes</key><array><string>location</string></array><key>NSLocationWhenInUseUsageDescription</key><string>To show nearby places</string>`
    const ctx = ctxFor(body, { partial: {
      credentials: { APPLE_KEY_ID: 'ABCDE12345', APPLE_ISSUER_ID: '12345678-1234-1234-1234-123456789012', APPLE_KEY_CONTENT: 'x' },
      distributionMode: 'app_store',
    } })
    expect(await plistBackgroundModesSanity.run(ctx)).toEqual([])
  })
})

describe('ios/plist-required-device-arm64 (upload-gated)', () => {
  const uploadCreds = { APPLE_KEY_ID: 'ABCDE12345', APPLE_ISSUER_ID: '12345678-1234-1234-1234-123456789012', APPLE_KEY_CONTENT: 'x' }
  it('does not apply when not uploading', () => {
    const ctx = ctxFor(`${HEALTHY_BODY}<key>UIRequiredDeviceCapabilities</key><array><string>armv7</string></array>`)
    expect(plistRequiredDeviceArm64.appliesTo?.(ctx)).toBe(false)
  })
  it('warns when uploading with armv7 and no arm64', async () => {
    const ctx = ctxFor(`${HEALTHY_BODY}<key>UIRequiredDeviceCapabilities</key><array><string>armv7</string></array>`, { partial: { credentials: uploadCreds, distributionMode: 'app_store' } })
    expect(plistRequiredDeviceArm64.appliesTo?.(ctx)).toBe(true)
    const f = await plistRequiredDeviceArm64.run(ctx)
    expect(f[0]?.severity).toBe('warning')
    expect(f[0]?.id).toBe('ios/plist-required-device-arm64')
  })
  it('passes when arm64 is present', async () => {
    const ctx = ctxFor(`${HEALTHY_BODY}<key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>`, { partial: { credentials: uploadCreds, distributionMode: 'app_store' } })
    expect(await plistRequiredDeviceArm64.run(ctx)).toEqual([])
  })
  it('passes when both armv7 and arm64 are present', async () => {
    const ctx = ctxFor(`${HEALTHY_BODY}<key>UIRequiredDeviceCapabilities</key><array><string>armv7</string><string>arm64</string></array>`, { partial: { credentials: uploadCreds, distributionMode: 'app_store' } })
    expect(await plistRequiredDeviceArm64.run(ctx)).toEqual([])
  })
  it('no finding when UIRequiredDeviceCapabilities is absent', async () => {
    const ctx = ctxFor(HEALTHY_BODY, { partial: { credentials: uploadCreds, distributionMode: 'app_store' } })
    expect(await plistRequiredDeviceArm64.run(ctx)).toEqual([])
  })
})

describe('partial / non-Capacitor project — all checks early-return []', () => {
  it('no Info.plist -> [] (no crash)', async () => {
    const dir = makeProject({})
    const ctx = makeCtx({ projectDir: dir, platform: 'ios' })
    for (const check of ALL_CHECKS)
      expect(await runGated(check, ctx)).toEqual([])
  })
})
