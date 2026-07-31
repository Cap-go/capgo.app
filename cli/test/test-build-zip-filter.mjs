#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import AdmZip from 'adm-zip'

import { shouldIncludeFile, zipDirectory } from '../src/build/request.ts'

async function t(name, fn) {
  try {
    await fn()
    process.stdout.write(`✅ ${name}\n`)
  }
  catch (error) {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`)
    throw error
  }
}

function writeFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
}

const nativeDeps = { packages: new Set(['@capacitor/app']), cordovaPackages: new Set(), usesSPM: false, usesCocoaPods: true }

await t('should include package metadata for @capacitor dependencies in zip filter', () => {
  assert.equal(
    shouldIncludeFile('node_modules/@capacitor/app/package.json', 'ios', nativeDeps, 'ios'),
    true,
  )
  assert.equal(
    shouldIncludeFile('node_modules/@capacitor/app/README.md', 'ios', nativeDeps, 'ios'),
    false,
  )
  assert.equal(
    shouldIncludeFile('node_modules/@capacitor/app/ios/App.swift', 'ios', nativeDeps, 'ios'),
    true,
  )
})

await t('generated build zip includes @capacitor plugin package.json for CocoaPods path resolution', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const zipPath = join(testRoot, 'build.zip')

  try {
    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor/core': '^6.0.0',
          '@capacitor/app': '^6.0.0',
        },
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'capacitor.config.json'),
      JSON.stringify({
        appId: 'com.example.app',
        appName: 'Example',
        webDir: 'www',
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'ios', 'App', 'Podfile'),
      "platform :ios, '14.0'\npod '@capacitor/app', :path => '../../node_modules/@capacitor/app'\n",
    )

    writeFile(
      join(testRoot, 'ios', 'App', 'Podfile.lock'),
      'PODFILE: ["/node_modules/@capacitor/app"]\n',
    )

    writeFile(join(testRoot, 'www', 'index.html'), '<!doctype html><html></html>')
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'package.json'),
      JSON.stringify({ name: '@capacitor/app', version: '6.0.0' }, null, 2),
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'CapacitorApp.podspec'),
      "Pod::Spec.new do |s|\n  s.name = 'CapacitorApp'\nend",
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'ios', 'Plugin.swift'),
      '// iOS source file',
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'README.md'),
      'should be filtered out',
    )
    writeFile(join(testRoot, 'node_modules', '@capacitor', 'app', 'android', 'build.gradle'), '')

    await zipDirectory(testRoot, zipPath, 'ios', {
      ios: { path: 'ios' },
    })

    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map(entry => entry.entryName).sort()

    assert.ok(entries.includes('node_modules/@capacitor/app/package.json'), 'missing plugin package.json in zip')
    assert.ok(entries.includes('node_modules/@capacitor/app/CapacitorApp.podspec'), 'missing plugin podspec in zip')
    assert.ok(entries.includes('node_modules/@capacitor/app/ios/Plugin.swift'), 'missing plugin ios code in zip')
    assert.ok(!entries.includes('node_modules/@capacitor/app/README.md'), 'non-native plugin file was not filtered')
    assert.ok(entries.includes('ios/App/Podfile'), 'native platform folder not included')
    assert.ok(entries.includes('package.json'), 'root package.json not included')
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

await t('generated build zip includes Capacitor plugin for ios Podfile at platform root', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const zipPath = join(testRoot, 'build.zip')

  try {
    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor/core': '^6.0.0',
          '@capacitor/app': '^6.0.0',
        },
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'capacitor.config.json'),
      JSON.stringify({
        ios: {
          path: 'apps/native/ios',
        },
        appId: 'com.example.app',
        appName: 'Example',
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'apps/native/ios/Podfile'),
      "pod 'CapacitorApp', :path => '../../../node_modules/@capacitor/app'\n",
    )

    writeFile(join(testRoot, 'www', 'index.html'), '<!doctype html><html></html>')
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'package.json'),
      JSON.stringify({ name: '@capacitor/app', version: '6.0.0' }, null, 2),
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'CapacitorApp.podspec'),
      "Pod::Spec.new do |s|\n  s.name = 'CapacitorApp'\nend",
    )

    await zipDirectory(testRoot, zipPath, 'ios', {
      ios: {
        path: 'apps/native/ios',
      },
    })

    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map(entry => entry.entryName).sort()

    assert.ok(entries.includes('node_modules/@capacitor/app/package.json'), 'missing plugin package.json in zip')
    assert.ok(entries.includes('apps/native/ios/Podfile'), 'root platform podfile not included')
    assert.ok(!entries.includes('apps/native/ios/App/Podfile'), 'unexpected nested podfile was included')
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

await t('generated build zip supports nested Capacitor Podfile paths in monorepo layouts', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const zipPath = join(testRoot, 'build.zip')

  try {
    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor/core': '^6.0.0',
          '@capacitor/app': '^6.0.0',
        },
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'capacitor.config.json'),
      JSON.stringify({
        ios: {
          path: 'apps/native/ios',
        },
        appId: 'com.example.app',
        appName: 'Example',
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'apps/native/ios/App/Podfile'),
      "platform :ios, '14.0'\npod 'CapacitorApp', :path => '../../../node_modules/@capacitor/app'\n",
    )
    writeFile(
      join(testRoot, 'apps/native/ios/App/CapApp-SPM/Package.swift'),
      'let package = Package(name: "CapApp-SPM", dependencies: [.package(name: "CapacitorApp", path: "../../../../../node_modules/.pnpm/@capacitor+app@6.0.0_@capacitor+core@6.0.0/node_modules/@capacitor/app")])\n',
    )

    writeFile(
      join(testRoot, 'apps/native/ios/App/Podfile.lock'),
      'PODFILE: ["/node_modules/@capacitor/app"]\n',
    )

    writeFile(join(testRoot, 'www', 'index.html'), '<!doctype html><html></html>')
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'package.json'),
      JSON.stringify({ name: '@capacitor/app', version: '6.0.0' }, null, 2),
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'CapacitorApp.podspec'),
      "Pod::Spec.new do |s|\n  s.name = 'CapacitorApp'\nend",
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'Package.swift'),
      'let package = Package(name: "CapacitorApp")\n',
    )

    await zipDirectory(testRoot, zipPath, 'ios', {
      ios: {
        path: 'apps/native/ios',
      },
    })

    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map(entry => entry.entryName).sort()

    assert.ok(entries.includes('apps/native/ios/App/Podfile'), 'native platform podfile not included')
    assert.ok(entries.includes('node_modules/@capacitor/app/package.json'), 'missing plugin package.json in zip')
    assert.ok(entries.includes('node_modules/@capacitor/app/CapacitorApp.podspec'), 'missing plugin podspec in zip')
    assert.equal(
      zip.readAsText('apps/native/ios/App/CapApp-SPM/Package.swift'),
      'let package = Package(name: "CapApp-SPM", dependencies: [.package(name: "CapacitorApp", path: "../../../../../node_modules/@capacitor/app")])\n',
    )
    assert.ok(!entries.includes('apps/native/ios/Podfile.lock'), 'unexpected root lockfile was included')
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

await t('generated build zip rewrites bun isolated-store paths to flat node_modules (ios Package.swift)', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const zipPath = join(testRoot, 'build.zip')

  try {
    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor/core': '^8.0.0',
          '@capacitor/action-sheet': '^8.1.1',
        },
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'capacitor.config.json'),
      JSON.stringify({
        ios: { path: 'ios' },
        appId: 'com.example.app',
        appName: 'Example',
      }, null, 2),
    )

    // `cap sync` run under bun's isolated linker bakes the .bun store path into Package.swift.
    writeFile(
      join(testRoot, 'ios/App/CapApp-SPM/Package.swift'),
      'let package = Package(name: "CapApp-SPM", dependencies: [.package(name: "CapacitorActionSheet", path: "../../../node_modules/.bun/@capacitor+action-sheet@8.1.1+1b808583819c2ac6/node_modules/@capacitor/action-sheet")])\n',
    )

    writeFile(join(testRoot, 'www', 'index.html'), '<!doctype html><html></html>')
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'action-sheet', 'package.json'),
      JSON.stringify({ name: '@capacitor/action-sheet', version: '8.1.1' }, null, 2),
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'action-sheet', 'Package.swift'),
      'let package = Package(name: "CapacitorActionSheet")\n',
    )

    await zipDirectory(testRoot, zipPath, 'ios', {
      ios: { path: 'ios' },
    })

    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map(entry => entry.entryName).sort()

    assert.ok(entries.includes('node_modules/@capacitor/action-sheet/package.json'), 'missing plugin package.json in zip')
    assert.equal(
      zip.readAsText('ios/App/CapApp-SPM/Package.swift'),
      'let package = Package(name: "CapApp-SPM", dependencies: [.package(name: "CapacitorActionSheet", path: "../../../node_modules/@capacitor/action-sheet")])\n',
    )
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

await t('generated build zip normalizes Windows path separators in ios Package.swift', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const zipPath = join(testRoot, 'build.zip')

  try {
    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor/core': '^8.0.0',
          '@capacitor/app': '^8.0.0',
        },
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'capacitor.config.json'),
      JSON.stringify({
        ios: { path: 'ios' },
        appId: 'com.example.app',
        appName: 'Example',
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'ios/App/CapApp-SPM/Package.swift'),
      'let package = Package(name: "CapApp-SPM", dependencies: [.package(name: "CapacitorApp", path: "..\\..\\..\\node_modules\\@capacitor\\app")])\n',
    )

    writeFile(join(testRoot, 'www', 'index.html'), '<!doctype html><html></html>')
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'package.json'),
      JSON.stringify({ name: '@capacitor/app', version: '8.0.0' }, null, 2),
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'Package.swift'),
      'let package = Package(name: "CapacitorApp")\n',
    )

    await zipDirectory(testRoot, zipPath, 'ios', {
      ios: { path: 'ios' },
    })

    const zip = new AdmZip(zipPath)
    assert.equal(
      zip.readAsText('ios/App/CapApp-SPM/Package.swift'),
      'let package = Package(name: "CapApp-SPM", dependencies: [.package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")])\n',
    )
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

await t('generated build zip rewrites bun isolated-store paths to flat node_modules (android settings.gradle)', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const zipPath = join(testRoot, 'build.zip')

  try {
    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor/core': '^8.0.0',
          '@capacitor/action-sheet': '^8.1.1',
        },
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'capacitor.config.json'),
      JSON.stringify({
        android: { path: 'android' },
        appId: 'com.example.app',
        appName: 'Example',
      }, null, 2),
    )

    // `cap sync` run under bun's isolated linker bakes the .bun store path into settings.gradle.
    writeFile(
      join(testRoot, 'android/capacitor.settings.gradle'),
      'include \':capacitor-action-sheet\'\nproject(\':capacitor-action-sheet\').projectDir = new File(\'../node_modules/.bun/@capacitor+action-sheet@8.1.1+1b808583819c2ac6/node_modules/@capacitor/action-sheet/android\')\n',
    )

    writeFile(join(testRoot, 'www', 'index.html'), '<!doctype html><html></html>')
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'action-sheet', 'package.json'),
      JSON.stringify({ name: '@capacitor/action-sheet', version: '8.1.1' }, null, 2),
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'action-sheet', 'android', 'build.gradle'),
      'apply plugin: \'com.android.library\'\n',
    )

    await zipDirectory(testRoot, zipPath, 'android', {
      android: { path: 'android' },
    })

    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map(entry => entry.entryName).sort()

    assert.ok(entries.includes('node_modules/@capacitor/action-sheet/android/build.gradle'), 'missing plugin android build.gradle in zip')
    assert.equal(
      zip.readAsText('android/capacitor.settings.gradle'),
      'include \':capacitor-action-sheet\'\nproject(\':capacitor-action-sheet\').projectDir = new File(\'../node_modules/@capacitor/action-sheet/android\')\n',
    )
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

await t('generated build zip includes SPM and CocoaPods metadata when both managers are configured', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const zipPath = join(testRoot, 'build.zip')

  try {
    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor/core': '^6.0.0',
          '@capacitor/app': '^6.0.0',
        },
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'capacitor.config.json'),
      JSON.stringify({
        ios: {
          path: 'ios',
        },
        appId: 'com.example.app',
        appName: 'Example',
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'ios/App/CapApp-SPM/Package.swift'),
      'let package = Package(name: "CapAppSPM", dependencies: [.package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app")])\n',
    )

    writeFile(
      join(testRoot, 'ios/App/Podfile'),
      "pod 'CapacitorApp', :path => '../../node_modules/@capacitor/app'\n",
    )

    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'package.json'),
      JSON.stringify({ name: '@capacitor/app', version: '6.0.0' }, null, 2),
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'CapacitorApp.podspec'),
      "Pod::Spec.new do |s|\n  s.name = 'CapacitorApp'\nend",
    )
    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'app', 'Package.swift'),
      'let package = Package(name: "CapacitorApp")\n',
    )

    await zipDirectory(testRoot, zipPath, 'ios', {
      ios: {
        path: 'ios',
      },
    })

    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map(entry => entry.entryName).sort()

    assert.ok(entries.includes('node_modules/@capacitor/app/package.json'), 'missing plugin package.json in zip')
    assert.ok(entries.includes('node_modules/@capacitor/app/CapacitorApp.podspec'), 'missing plugin podspec in zip')
    assert.ok(entries.includes('node_modules/@capacitor/app/Package.swift'), 'missing plugin Package.swift in zip')
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})
await t('generated build zip includes Cordova plugin files referenced from capacitor-cordova-android-plugins/build.gradle', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const zipPath = join(testRoot, 'build.zip')

  try {
    writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor/core': '^6.0.0',
          '@capacitor/android': '^6.0.0',
          'onesignal-cordova-plugin': '^5.3.0',
        },
      }, null, 2),
    )

    writeFile(
      join(testRoot, 'capacitor.config.json'),
      JSON.stringify({
        appId: 'com.example.app',
        appName: 'Example',
        webDir: 'www',
      }, null, 2),
    )

    writeFile(join(testRoot, 'www', 'index.html'), '<!doctype html><html></html>')

    // Capacitor settings.gradle only lists @capacitor/android — Cordova plugins are not here.
    writeFile(
      join(testRoot, 'android', 'capacitor.settings.gradle'),
      "include ':capacitor-android'\nproject(':capacitor-android').projectDir = new File('../node_modules/@capacitor/android/capacitor')\n",
    )

    // Cordova plugins are wired via apply from in this generated file.
    writeFile(
      join(testRoot, 'android', 'capacitor-cordova-android-plugins', 'build.gradle'),
      "apply from: \"cordova.variables.gradle\"\napply from: \"../../node_modules/onesignal-cordova-plugin/build-extras-onesignal.gradle\"\n",
    )

    writeFile(
      join(testRoot, 'node_modules', '@capacitor', 'android', 'package.json'),
      JSON.stringify({ name: '@capacitor/android', version: '6.0.0' }),
    )

    writeFile(
      join(testRoot, 'node_modules', 'onesignal-cordova-plugin', 'package.json'),
      JSON.stringify({ name: 'onesignal-cordova-plugin', version: '5.3.0' }),
    )
    writeFile(
      join(testRoot, 'node_modules', 'onesignal-cordova-plugin', 'build-extras-onesignal.gradle'),
      "// Onesignal extras\n",
    )
    writeFile(
      join(testRoot, 'node_modules', 'onesignal-cordova-plugin', 'plugin.xml'),
      "<plugin />\n",
    )
    writeFile(
      join(testRoot, 'node_modules', 'onesignal-cordova-plugin', 'src', 'android', 'OneSignal.java'),
      "package com.onesignal;",
    )

    // Simulated bundled transitive dependency that must NOT be included.
    writeFile(
      join(testRoot, 'node_modules', 'onesignal-cordova-plugin', 'node_modules', 'bundled-dep', 'package.json'),
      JSON.stringify({ name: 'bundled-dep', version: '1.0.0' }),
    )
    writeFile(
      join(testRoot, 'node_modules', 'onesignal-cordova-plugin', 'node_modules', 'bundled-dep', 'index.js'),
      "module.exports = {}",
    )

    await zipDirectory(testRoot, zipPath, 'android', {
      android: { path: 'android' },
    })

    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map(entry => entry.entryName).sort()

    assert.ok(
      entries.includes('node_modules/onesignal-cordova-plugin/build-extras-onesignal.gradle'),
      'missing Cordova plugin gradle script referenced via apply from',
    )
    assert.ok(
      entries.includes('node_modules/onesignal-cordova-plugin/plugin.xml'),
      'missing Cordova plugin.xml at package root',
    )
    assert.ok(
      entries.includes('node_modules/onesignal-cordova-plugin/src/android/OneSignal.java'),
      'missing Cordova plugin native source under src/android',
    )
    assert.ok(
      entries.includes('node_modules/onesignal-cordova-plugin/package.json'),
      'missing Cordova plugin package.json',
    )
    assert.ok(
      entries.includes('android/capacitor-cordova-android-plugins/build.gradle'),
      'missing capacitor-cordova-android-plugins build.gradle',
    )
    assert.ok(
      !entries.some(e => e.startsWith('node_modules/onesignal-cordova-plugin/node_modules/')),
      'bundled transitive deps under cordova plugin must be excluded',
    )
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

await t('generated build zip can pull native pnpm workspace packages from an explicit node_modules root', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const workspaceRoot = join(testRoot, 'typescript')
  const projectRoot = join(workspaceRoot, 'apps', 'pay-tablet')
  const zipPath = join(testRoot, 'build.zip')
  const keepAwakePath = join(
    workspaceRoot,
    'node_modules',
    '.pnpm',
    '@capacitor-community+keep-awake@8.0.0_@capacitor+core@8.2.0',
    'node_modules',
    '@capacitor-community',
    'keep-awake',
  )

  try {
    writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor-community/keep-awake': '^8.0.0',
        },
      }, null, 2),
    )

    writeFile(
      join(projectRoot, 'capacitor.config.json'),
      JSON.stringify({
        ios: {
          path: 'ios',
        },
        appId: 'com.example.pay',
        appName: 'Pay Tablet',
      }, null, 2),
    )

    writeFile(
      join(projectRoot, 'ios', 'App', 'Podfile'),
      "platform :ios, '14.0'\npod 'CapacitorCommunityKeepAwake', :path => '../../node_modules/@capacitor-community/keep-awake'\n",
    )
    writeFile(
      join(projectRoot, 'ios', 'App', 'CapApp-SPM', 'Package.swift'),
      'let package = Package(name: "CapApp-SPM", dependencies: [.package(name: "CapacitorCommunityKeepAwake", path: "../../../../../node_modules/.pnpm/@capacitor-community+keep-awake@8.0.0_@capacitor+core@8.2.0/node_modules/@capacitor-community/keep-awake")])\n',
    )

    writeFile(
      join(keepAwakePath, 'package.json'),
      JSON.stringify({ name: '@capacitor-community/keep-awake', version: '8.0.0' }, null, 2),
    )
    writeFile(
      join(keepAwakePath, 'Package.swift'),
      'let package = Package(name: "CapacitorCommunityKeepAwake")\n',
    )
    writeFile(
      join(keepAwakePath, 'KeepAwake.podspec'),
      "Pod::Spec.new do |s|\n  s.name = 'KeepAwake'\nend",
    )
    writeFile(
      join(keepAwakePath, 'ios', 'KeepAwakePlugin.swift'),
      '// iOS source file',
    )

    await zipDirectory(projectRoot, zipPath, 'ios', {
      ios: {
        path: 'ios',
      },
    }, {
      nodeModules: join(workspaceRoot, 'node_modules'),
    })

    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().map(entry => entry.entryName).sort()

    assert.ok(entries.includes('node_modules/@capacitor-community/keep-awake/package.json'), 'missing workspace plugin package.json in zip')
    assert.ok(entries.includes('node_modules/@capacitor-community/keep-awake/Package.swift'), 'missing workspace plugin Package.swift in zip')
    assert.ok(entries.includes('node_modules/@capacitor-community/keep-awake/KeepAwake.podspec'), 'missing workspace plugin podspec in zip')
    assert.ok(entries.includes('node_modules/@capacitor-community/keep-awake/ios/KeepAwakePlugin.swift'), 'missing workspace plugin ios code in zip')
    assert.ok(entries.includes('ios/App/Podfile'), 'native platform folder not included')
    assert.equal(
      zip.readAsText('ios/App/CapApp-SPM/Package.swift'),
      'let package = Package(name: "CapApp-SPM", dependencies: [.package(name: "CapacitorCommunityKeepAwake", path: "../../../node_modules/@capacitor-community/keep-awake")])\n',
    )
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

await t('generated build zip rejects ambiguous pnpm workspace package versions', async () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'capgo-build-zip-filter-'))
  const workspaceRoot = join(testRoot, 'typescript')
  const projectRoot = join(workspaceRoot, 'apps', 'pay-tablet')
  const zipPath = join(testRoot, 'build.zip')

  try {
    writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          '@capacitor-community/keep-awake': '^8.0.0',
        },
      }, null, 2),
    )

    writeFile(
      join(projectRoot, 'capacitor.config.json'),
      JSON.stringify({
        ios: {
          path: 'ios',
        },
        appId: 'com.example.pay',
        appName: 'Pay Tablet',
      }, null, 2),
    )

    writeFile(
      join(projectRoot, 'ios', 'App', 'Podfile'),
      "platform :ios, '14.0'\npod 'CapacitorCommunityKeepAwake', :path => '../../node_modules/@capacitor-community/keep-awake'\n",
    )

    for (const version of ['8.0.0', '8.1.0']) {
      writeFile(
        join(
          workspaceRoot,
          'node_modules',
          '.pnpm',
          `@capacitor-community+keep-awake@${version}_@capacitor+core@8.2.0`,
          'node_modules',
          '@capacitor-community',
          'keep-awake',
          'package.json',
        ),
        JSON.stringify({ name: '@capacitor-community/keep-awake', version }, null, 2),
      )
    }

    await assert.rejects(
      () => zipDirectory(projectRoot, zipPath, 'ios', {
        ios: {
          path: 'ios',
        },
      }, {
        nodeModules: join(workspaceRoot, 'node_modules'),
      }),
      /Multiple pnpm store entries found for @capacitor-community\/keep-awake/,
    )
  }
  finally {
    rmSync(testRoot, { recursive: true, force: true })
  }
})

process.stdout.write('OK\n')
