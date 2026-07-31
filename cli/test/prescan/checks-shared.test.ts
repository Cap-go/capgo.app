// test/prescan/checks-shared.test.ts
import { describe, expect, it } from 'bun:test'
import { bundleIdConsistency, capSyncStale, nodeLinkerLayout } from '../../src/build/prescan/checks/shared'
import { makeCtx, makeProject } from './helpers'

const PKG = JSON.stringify({ dependencies: { '@capacitor/core': '7.0.0', '@capacitor/camera': '7.0.0', '@capacitor/android': '7.0.0' } })
const CAMERA_ANDROID = {
  'node_modules/@capacitor/camera/package.json': JSON.stringify({ name: '@capacitor/camera' }),
  'node_modules/@capacitor/camera/android/build.gradle': 'android',
}

describe('shared/cap-sync-stale', () => {
  it('errors when webDir is missing', async () => {
    const dir = makeProject({ 'package.json': PKG })
    const ctx = makeCtx({ projectDir: dir, platform: 'android', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    const findings = await capSyncStale.run(ctx)
    expect(findings.some(f => f.id === 'shared/cap-sync-stale' && f.severity === 'error' && f.title.includes('webDir'))).toBe(true)
  })

  it('errors when an installed capacitor plugin is missing from capacitor.settings.gradle', async () => {
    const dir = makeProject({
      'package.json': PKG,
      'dist/index.html': '<html></html>',
      'android/capacitor.settings.gradle': `include ':capacitor-android'\n// no camera here`,
      ...CAMERA_ANDROID,
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'android', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    const findings = await capSyncStale.run(ctx)
    expect(findings.some(f => f.severity === 'error' && (f.detail ?? '').includes('@capacitor/camera'))).toBe(true)
  })

  it('passes on a synced android project', async () => {
    const dir = makeProject({
      'package.json': PKG,
      'dist/index.html': '<html></html>',
      'android/capacitor.settings.gradle': `include ':capacitor-android'\ninclude ':capacitor-camera'\nproject(':capacitor-camera').projectDir = new File('../node_modules/@capacitor/camera/android')`,
      ...CAMERA_ANDROID,
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'android', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    expect(await capSyncStale.run(ctx)).toEqual([])
  })

  it('passes when a web-only @capacitor plugin has no android native project', async () => {
    const dir = makeProject({
      'package.json': JSON.stringify({
        dependencies: {
          '@capacitor/core': '8.0.0',
          '@capacitor/android': '8.0.0',
          '@capacitor/camera': '8.0.0',
          '@capacitor/motion': '8.0.0',
        },
      }),
      'dist/index.html': '<html></html>',
      ...CAMERA_ANDROID,
      'node_modules/@capacitor/motion/package.json': JSON.stringify({ name: '@capacitor/motion' }),
      'node_modules/@capacitor/motion/dist/index.js': 'export {}',
      'android/capacitor.settings.gradle': `include ':capacitor-android'\ninclude ':capacitor-camera'\nproject(':capacitor-camera').projectDir = new File('../node_modules/@capacitor/camera/android')`,
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'android', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    expect(await capSyncStale.run(ctx)).toEqual([])
  })
})

describe('shared/node-linker-layout', () => {
  it('errors when node_modules/.bun exists', async () => {
    const dir = makeProject({ 'node_modules/.bun/placeholder': '', 'package.json': PKG })
    const findings = await nodeLinkerLayout.run(makeCtx({ projectDir: dir }))
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.fix).toContain('--linker=hoisted')
  })

  it('warns when node_modules/.pnpm exists', async () => {
    const dir = makeProject({ 'node_modules/.pnpm/placeholder': '', 'package.json': PKG })
    expect((await nodeLinkerLayout.run(makeCtx({ projectDir: dir })))[0]?.severity).toBe('warning')
  })

  it('passes with hoisted layout', async () => {
    const dir = makeProject({ 'node_modules/@capacitor/core/package.json': '{}', 'package.json': PKG })
    expect(await nodeLinkerLayout.run(makeCtx({ projectDir: dir }))).toEqual([])
  })
})

describe('shared/bundle-id-consistency', () => {
  it('warns when gradle applicationId differs from capacitor appId', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android { defaultConfig { applicationId "com.other.app" } }`,
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'android', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    const findings = await bundleIdConsistency.run(ctx)
    expect(findings[0]?.severity).toBe('warning')
    expect(findings[0]?.detail).toContain('com.other.app')
  })

  it('passes when they match', async () => {
    const dir = makeProject({
      'android/app/build.gradle': `android { defaultConfig { applicationId "com.demo.app" } }`,
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'android', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    expect(await bundleIdConsistency.run(ctx)).toEqual([])
  })
})

describe('shared/cap-sync-stale — platform sync-artifact errors', () => {
  it('errors on android when capacitor.settings.gradle is missing (cap sync never ran)', async () => {
    const dir = makeProject({
      'package.json': PKG,
      'dist/index.html': '<html></html>',
      ...CAMERA_ANDROID,
      // no android/capacitor.settings.gradle
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'android', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    const findings = await capSyncStale.run(ctx)
    expect(findings.some(f => f.severity === 'error' && f.title.includes('capacitor.settings.gradle'))).toBe(true)
  })

  it('errors on ios when CocoaPods and SPM sync artifacts are both missing', async () => {
    const dir = makeProject({
      'package.json': PKG,
      'dist/index.html': '<html></html>',
      // no ios/App/Podfile or ios/App/CapApp-SPM/Package.swift
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'ios', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    const findings = await capSyncStale.run(ctx)
    expect(findings.some(f => f.severity === 'error' && f.title.includes('sync artifacts') && f.detail?.includes('CapApp-SPM/Package.swift'))).toBe(true)
  })

  it('passes on a synced ios CocoaPods project', async () => {
    const dir = makeProject({
      'package.json': PKG,
      'dist/index.html': '<html></html>',
      'ios/App/Podfile': `platform :ios, '14.0'\npod 'CapacitorCamera'`,
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'ios', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    expect(await capSyncStale.run(ctx)).toEqual([])
  })

  it('passes on a synced ios SPM project', async () => {
    const dir = makeProject({
      'package.json': PKG,
      'dist/index.html': '<html></html>',
      'ios/App/CapApp-SPM/Package.swift': `// generated by cap sync`,
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'ios', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    expect(await capSyncStale.run(ctx)).toEqual([])
  })
})

// Minimal single-target pbxproj (format mirrors test/test-pbxproj-parser.mjs)
const ONE_TARGET_PBXPROJ = (bundleId: string) => `// !$*UTF8*$!
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
    13B07F931A680F5B00A75B9A /* Build configuration list for App */ = {
      isa = XCConfigurationList;
      buildConfigurations = (
        13B07F941A680F5B00A75B9A,
      );
    };
    13B07F941A680F5B00A75B9A /* Release */ = {
      isa = XCBuildConfiguration;
      buildSettings = {
        PRODUCT_BUNDLE_IDENTIFIER = ${bundleId};
      };
      name = Release;
    };
  };
  rootObject = 089C1665FE841187C02AAC07;
}`

describe('shared/bundle-id-consistency (ios pbxproj branch)', () => {
  it('warns when no Xcode target uses the Capacitor appId', async () => {
    const dir = makeProject({
      'ios/App/App.xcodeproj/project.pbxproj': ONE_TARGET_PBXPROJ('com.other.app'),
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'ios', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    const findings = await bundleIdConsistency.run(ctx)
    expect(findings[0]?.severity).toBe('warning')
    expect(findings[0]?.detail).toContain('com.other.app')
  })

  it('passes when a target bundle id matches the appId', async () => {
    const dir = makeProject({
      'ios/App/App.xcodeproj/project.pbxproj': ONE_TARGET_PBXPROJ('com.demo.app'),
    })
    const ctx = makeCtx({ projectDir: dir, platform: 'ios', config: { appId: 'com.demo.app', appName: 'x', webDir: 'dist' } as any })
    expect(await bundleIdConsistency.run(ctx)).toEqual([])
  })
})
