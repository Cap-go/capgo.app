// test/prescan/checks-ios-profiles.test.ts
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'bun:test'
import {
  certProfilePairing,
  parseProvisioningMap,
  profileBundleMatch,
  profileExpiry,
  profileTypeVsMode,
  targetsCovered,
  wildcardProfileTargets,
} from '../../src/build/prescan/checks/ios-profiles'
import { makeCtx, makeP12, makeProfileXml, makeProfileXmlWithCert, makeProject } from './helpers'

const b64 = (s: string) => Buffer.from(s).toString('base64')

// Real serialized shape of CAPGO_IOS_PROVISIONING_MAP, produced by buildProvisioningMap()
// in src/build/credentials-command.ts: { [bundleId]: { profile: base64, name: string } }
function mapWith(xml: string, bundleId = 'com.demo.app'): string {
  return JSON.stringify({ [bundleId]: { profile: b64(xml), name: 'Test Profile' } })
}

function ctxWith(creds: Record<string, string>, extra: object = {}) {
  return makeCtx({ projectDir: '/tmp', platform: 'ios', credentials: creds, distributionMode: 'app_store', ...extra })
}

describe('parseProvisioningMap', () => {
  it('parses the { bundleId: { profile, name } } shape produced by buildProvisioningMap', () => {
    const xml = makeProfileXml()
    const entries = parseProvisioningMap(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) }))
    expect(entries).toEqual([{ bundleId: 'com.demo.app', base64: b64(xml), name: 'Test Profile' }])
  })
  it('returns [] when the map is absent or malformed', () => {
    expect(parseProvisioningMap(ctxWith({}))).toEqual([])
    expect(parseProvisioningMap(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: 'not json' }))).toEqual([])
  })
})

describe('ios/profile-expiry', () => {
  it('errors on expired profile', async () => {
    const xml = makeProfileXml({ expiration: new Date(Date.now() - 86_400_000) })
    const f = await profileExpiry.run(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) }))
    expect(f[0]?.severity).toBe('error')
  })
  it('warns within 30 days', async () => {
    const xml = makeProfileXml({ expiration: new Date(Date.now() + 5 * 86_400_000) })
    expect((await profileExpiry.run(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) })))[0]?.severity).toBe('warning')
  })
  it('passes a far-future profile', async () => {
    const xml = makeProfileXml({ expiration: new Date(Date.now() + 90 * 86_400_000) })
    expect(await profileExpiry.run(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) }))).toEqual([])
  })
})

describe('ios/profile-bundle-match', () => {
  it('errors when the profile bundle id mismatches the bundle id it is assigned to', async () => {
    const xml = makeProfileXml({ bundleId: 'com.other.app' })
    const f = await profileBundleMatch.run(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) }))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.detail).toContain('com.other.app')
  })
  it('accepts wildcard profiles', async () => {
    const xml = makeProfileXml({ bundleId: '*' })
    expect(await profileBundleMatch.run(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) }))).toEqual([])
  })
  it('accepts prefix wildcard profiles', async () => {
    const xml = makeProfileXml({ bundleId: 'com.demo.*' })
    expect(await profileBundleMatch.run(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) }))).toEqual([])
  })
  it('accepts exact match', async () => {
    const xml = makeProfileXml({ bundleId: 'com.demo.app' })
    expect(await profileBundleMatch.run(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) }))).toEqual([])
  })
})

describe('ios/profile-type-vs-mode', () => {
  it('errors when ad_hoc profile is used for app_store distribution', async () => {
    const xml = makeProfileXml({ type: 'ad_hoc' })
    const f = await profileTypeVsMode.run(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) }))
    expect(f[0]?.severity).toBe('error')
  })
  it('passes matching app_store profile', async () => {
    const xml = makeProfileXml({ type: 'app_store' })
    expect(await profileTypeVsMode.run(ctxWith({ CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) }))).toEqual([])
  })
})

describe('ios/cert-profile-pairing', () => {
  it('errors when the P12 cert is not in DeveloperCertificates', async () => {
    const p12 = makeP12()
    const other = makeP12()
    const xml = makeProfileXmlWithCert(other) // profile carries a DIFFERENT cert
    const f = await certProfilePairing.run(ctxWith({
      BUILD_CERTIFICATE_BASE64: p12.base64,
      P12_PASSWORD: p12.password,
      CAPGO_IOS_PROVISIONING_MAP: mapWith(xml),
    }))
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.title).toContain('provisioning profile')
  })
  it('passes when the profile contains the P12 cert', async () => {
    const p12 = makeP12()
    const xml = makeProfileXmlWithCert(p12)
    expect(await certProfilePairing.run(ctxWith({
      BUILD_CERTIFICATE_BASE64: p12.base64,
      P12_PASSWORD: p12.password,
      CAPGO_IOS_PROVISIONING_MAP: mapWith(xml),
    }))).toEqual([])
  })
})

// Fixture format mirrors test/test-pbxproj-parser.mjs (verified against findSignableTargets).
const TWO_TARGET_PBXPROJ = `// !$*UTF8*$!
{
  archiveVersion = 1;
  objectVersion = 56;
  objects = {
    13B07F861A680F5B00A75B9A /* App */ = {
      isa = PBXNativeTarget;
      buildConfigurationList = 13B07F931A680F5B00A75B9A;
      name = App;
      productName = App;
      productType = "com.apple.product-type.application";
    };
    AA11BB22CC33DD44 /* Widget */ = {
      isa = PBXNativeTarget;
      buildConfigurationList = AA11BB22CC33DD55;
      name = Widget;
      productName = Widget;
      productType = "com.apple.product-type.app-extension";
    };
    13B07F931A680F5B00A75B9A /* Build configuration list for App */ = {
      isa = XCConfigurationList;
      buildConfigurations = (
        13B07F941A680F5B00A75B9A,
      );
    };
    13B07F941A680F5B00A75B9A /* Release */ = {
      isa = XCBuildConfiguration;
      buildSettings = {
        PRODUCT_BUNDLE_IDENTIFIER = com.demo.app;
      };
      name = Release;
    };
    AA11BB22CC33DD55 /* Build configuration list for Widget */ = {
      isa = XCConfigurationList;
      buildConfigurations = (
        AA11BB22CC33DD66,
      );
    };
    AA11BB22CC33DD66 /* Release */ = {
      isa = XCBuildConfiguration;
      buildSettings = {
        PRODUCT_BUNDLE_IDENTIFIER = com.demo.app.widget;
      };
      name = Release;
    };
  };
  rootObject = 089C1665FE841187C02AAC07;
}`

describe('ios/targets-covered', () => {
  it('errors when a signable target has no profile in the map', async () => {
    const dir = makeProject({ 'ios/App/App.xcodeproj/project.pbxproj': TWO_TARGET_PBXPROJ })
    const xml = makeProfileXml()
    const ctx = makeCtx({ projectDir: dir, platform: 'ios', credentials: { CAPGO_IOS_PROVISIONING_MAP: mapWith(xml) } })
    const f = await targetsCovered.run(ctx)
    expect(f[0]?.severity).toBe('error')
    expect(f[0]?.title).toContain('1 signable target')
    expect(f[0]?.detail).toContain('Widget')
    expect(f[0]?.fix).toContain('npx @capgo/cli@latest build credentials ios-provisioning')
  })
  it('passes when every signable target bundle id is covered', async () => {
    const dir = makeProject({ 'ios/App/App.xcodeproj/project.pbxproj': TWO_TARGET_PBXPROJ })
    const map = JSON.stringify({
      'com.demo.app': { profile: b64(makeProfileXml()), name: 'App Profile' },
      'com.demo.app.widget': { profile: b64(makeProfileXml({ bundleId: 'com.demo.app.widget' })), name: 'Widget Profile' },
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'ios', credentials: { CAPGO_IOS_PROVISIONING_MAP: map } })
    expect(await targetsCovered.run(ctx)).toEqual([])
  })

  it('reports present empty, malformed, and invalid maps without suggesting the command', async () => {
    const dir = makeProject({ 'ios/App/App.xcodeproj/project.pbxproj': TWO_TARGET_PBXPROJ })
    for (const raw of ['{}', 'not json', JSON.stringify({ bad: { profile: 'not-a-profile' } })]) {
      const ctx = makeCtx({ projectDir: dir, platform: 'ios', credentials: { CAPGO_IOS_PROVISIONING_MAP: raw } })
      const findings = await targetsCovered.run(ctx)
      expect(findings[0]?.severity).toBe('error')
      expect(findings[0]?.fix).toContain('Save or update')
      expect(findings[0]?.fix).not.toContain('ios-provisioning')
    }
  })

  it('keeps generic repair guidance for a single-target project', async () => {
    const singleTarget = TWO_TARGET_PBXPROJ
      .replace(/    AA11BB22CC33DD44[\s\S]*?    };\n    13B07F931A680F5B00A75B9A/, '    13B07F931A680F5B00A75B9A')
      .replace(/    AA11BB22CC33DD55[\s\S]*?    };\n  };/, '  };')
    const dir = makeProject({ 'ios/App/App.xcodeproj/project.pbxproj': singleTarget })
    const map = JSON.stringify({ other: { profile: b64(makeProfileXml({ bundleId: 'com.other.app' })), name: 'Other' } })
    const findings = await targetsCovered.run(makeCtx({ projectDir: dir, platform: 'ios', credentials: { CAPGO_IOS_PROVISIONING_MAP: map } }))
    expect(findings[0]?.fix).toContain('--ios-provisioning-profile')
    expect(findings[0]?.fix).not.toContain('build credentials ios-provisioning')
  })
})

describe('ios/wildcard-profile-targets', () => {
  it('owns matching wildcard targets and recommends the repair command', async () => {
    const dir = makeProject({ 'ios/App/App.xcodeproj/project.pbxproj': TWO_TARGET_PBXPROJ })
    const wildcard = b64(makeProfileXml({ bundleId: 'com.demo.*' }))
    const map = JSON.stringify({
      'com.demo.app': { profile: b64(makeProfileXml()), name: 'App' },
      wildcard: { profile: wildcard, name: 'Wildcard' },
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'ios', credentials: { CAPGO_IOS_PROVISIONING_MAP: map } })

    const findings = await wildcardProfileTargets.run(ctx)
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.detail).toContain('Widget')
    expect(findings[0]?.fix).toContain('npx @capgo/cli@latest build credentials ios-provisioning')
    expect(await targetsCovered.run(ctx)).toEqual([])
  })

  it('fails unsupported when different wildcard profiles match', async () => {
    const dir = makeProject({ 'ios/App/App.xcodeproj/project.pbxproj': TWO_TARGET_PBXPROJ })
    const map = JSON.stringify({
      'com.demo.app': { profile: b64(makeProfileXml()), name: 'App' },
      broad: { profile: b64(makeProfileXml({ bundleId: '*' })), name: 'Broad' },
      prefix: { profile: b64(makeProfileXml({ bundleId: 'com.demo.*' })), name: 'Prefix' },
    })
    const findings = await wildcardProfileTargets.run(makeCtx({ projectDir: dir, platform: 'ios', credentials: { CAPGO_IOS_PROVISIONING_MAP: map } }))
    expect(findings[0]?.title).toBe('Sorry, multiple matching wildcard provisioning profiles are not supported')
    expect(findings[0]?.fix).toContain('Remove or replace')
  })

  it('deduplicates identical wildcard bytes and ignores exact-complete or nonmatching maps', async () => {
    const dir = makeProject({ 'ios/App/App.xcodeproj/project.pbxproj': TWO_TARGET_PBXPROJ })
    const wildcard = b64(makeProfileXml({ bundleId: 'com.demo.*' }))
    const duplicateMap = JSON.stringify({ first: wildcard, second: { profile: wildcard, name: 'Duplicate' } })
    const duplicateFindings = await wildcardProfileTargets.run(makeCtx({ projectDir: dir, platform: 'ios', credentials: { CAPGO_IOS_PROVISIONING_MAP: duplicateMap } }))
    expect(duplicateFindings[0]?.title).not.toContain('multiple')

    const exactMap = JSON.stringify({
      'com.demo.app': b64(makeProfileXml()),
      'com.demo.app.widget': b64(makeProfileXml({ bundleId: 'com.demo.app.widget' })),
      wildcard: b64(makeProfileXml({ bundleId: 'org.other.*' })),
    })
    expect(await wildcardProfileTargets.run(makeCtx({ projectDir: dir, platform: 'ios', credentials: { CAPGO_IOS_PROVISIONING_MAP: exactMap } }))).toEqual([])
  })
})
