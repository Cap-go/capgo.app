#!/usr/bin/env bun

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveIosMarketingVersion,
  replaceMarketingVersionInPbxproj,
  syncIosMarketingVersion,
} from '../src/build/ios-marketing-version.ts'

let failures = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`✗ ${name}`)
    console.error(error)
  }
}

function createFixture(packageVersion, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'capgo-ios-version-'))
  const xcodeProjectDir = join(cwd, 'ios/App/App.xcodeproj')
  const infoPlistDir = join(cwd, 'ios/App/App')
  const generateInfoPlist = options.generateInfoPlist ?? 'NO'
  const generateInfoPlistSetting = generateInfoPlist === 'DEFAULT'
    ? ''
    : `GENERATE_INFOPLIST_FILE = ${generateInfoPlist}; `

  mkdirSync(xcodeProjectDir, { recursive: true })
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: packageVersion }))
  writeFileSync(join(xcodeProjectDir, 'project.pbxproj'), [
    `Debug = { ${generateInfoPlistSetting}INFOPLIST_FILE = App/Info.plist; MARKETING_VERSION = 0.0.1; };`,
    `Release = { ${generateInfoPlistSetting}INFOPLIST_FILE = App/Info.plist; MARKETING_VERSION = 0.0.1; };`,
  ].join('\n'))

  if (options.infoPlistVersion !== undefined) {
    mkdirSync(infoPlistDir, { recursive: true })
    const versionEntry = options.infoPlistVersion === null
      ? ''
      : `  <key>CFBundleShortVersionString</key>\n  <string>${options.infoPlistVersion}</string>\n`
    writeFileSync(join(infoPlistDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${versionEntry}</dict>\n</plist>\n`)
  }

  return cwd
}

await test('normalizes prerelease package versions to App Store marketing versions', () => {
  assert.equal(deriveIosMarketingVersion('1.2.3-alpha.0'), '1.2.3')
})

await test('rejects package versions that cannot produce an iOS marketing version', () => {
  assert.throws(() => deriveIosMarketingVersion('1.2'), /Cannot derive an iOS MARKETING_VERSION/)
})

await test('replaces all Xcode MARKETING_VERSION entries', () => {
  const result = replaceMarketingVersionInPbxproj('Debug = { MARKETING_VERSION = 0.0.1; };\nRelease = { MARKETING_VERSION = 0.0.2; };', '1.2.3')

  assert.equal(result.replacements, 2)
  assert.match(result.content, /Debug = \{ MARKETING_VERSION = 1\.2\.3; \};/)
  assert.match(result.content, /Release = \{ MARKETING_VERSION = 1\.2\.3; \};/)
})

await test('syncs a Capacitor iOS project from package.json', () => {
  const cwd = createFixture('1.2.3-alpha.0', { infoPlistVersion: '$(MARKETING_VERSION)' })

  try {
    const result = syncIosMarketingVersion({ path: cwd })
    const project = readFileSync(join(cwd, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')

    assert.equal(result.changed, true)
    assert.equal(result.marketingVersion, '1.2.3')
    assert.match(project, /Debug = \{[^}]*MARKETING_VERSION = 1\.2\.3;/)
    assert.match(project, /Release = \{[^}]*MARKETING_VERSION = 1\.2\.3;/)
    assert.match(readFileSync(join(cwd, 'ios/App/App/Info.plist'), 'utf8'), /<string>\$\(MARKETING_VERSION\)<\/string>/)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

await test('check mode reports drift without writing', () => {
  const cwd = createFixture('1.2.3', { infoPlistVersion: '$(MARKETING_VERSION)' })

  try {
    const result = syncIosMarketingVersion({ path: cwd, check: true })
    const project = readFileSync(join(cwd, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')

    assert.equal(result.changed, true)
    assert.match(project, /MARKETING_VERSION = 0\.0\.1;/)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

await test('uses MARKETING_VERSION when Xcode generates Info.plist', () => {
  const cwd = createFixture('1.2.3', { generateInfoPlist: 'YES', infoPlistVersion: '0.0.1' })

  try {
    syncIosMarketingVersion({ path: cwd })

    const project = readFileSync(join(cwd, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
    const plist = readFileSync(join(cwd, 'ios/App/App/Info.plist'), 'utf8')
    assert.match(project, /MARKETING_VERSION = 1\.2\.3;/)
    assert.match(plist, /<string>0\.0\.1<\/string>/)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

await test('treats an omitted GENERATE_INFOPLIST_FILE setting as a manually managed plist', () => {
  const cwd = createFixture('1.2.3', { generateInfoPlist: 'DEFAULT', infoPlistVersion: '0.0.1' })

  try {
    syncIosMarketingVersion({ path: cwd })

    const project = readFileSync(join(cwd, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
    const plist = readFileSync(join(cwd, 'ios/App/App/Info.plist'), 'utf8')
    assert.match(project, /MARKETING_VERSION = 0\.0\.1;/)
    assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.2\.3<\/string>/)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

await test('updates a literal CFBundleShortVersionString when Xcode does not generate Info.plist', () => {
  const cwd = createFixture('1.2.3', { infoPlistVersion: '0.0.1' })

  try {
    syncIosMarketingVersion({ path: cwd })

    const project = readFileSync(join(cwd, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
    const plist = readFileSync(join(cwd, 'ios/App/App/Info.plist'), 'utf8')
    assert.match(project, /MARKETING_VERSION = 0\.0\.1;/)
    assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.2\.3<\/string>/)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

await test('adds CFBundleShortVersionString when a manually managed Info.plist omits it', () => {
  const cwd = createFixture('1.2.3', { infoPlistVersion: null })

  try {
    syncIosMarketingVersion({ path: cwd })

    const project = readFileSync(join(cwd, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
    const plist = readFileSync(join(cwd, 'ios/App/App/Info.plist'), 'utf8')
    assert.match(project, /MARKETING_VERSION = 0\.0\.1;/)
    assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>1\.2\.3<\/string>/)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

await test('check mode reports a literal Info.plist version drift without writing', () => {
  const cwd = createFixture('1.2.3', { infoPlistVersion: '0.0.1' })

  try {
    const infoPlistPath = join(cwd, 'ios/App/App/Info.plist')
    const result = syncIosMarketingVersion({ path: cwd, check: true })
    const project = readFileSync(join(cwd, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')
    const plist = readFileSync(infoPlistPath, 'utf8')

    assert.equal(result.changed, true)
    assert.deepEqual(result.updatedFiles, [infoPlistPath])
    assert.match(project, /MARKETING_VERSION = 0\.0\.1;/)
    assert.match(plist, /<string>0\.0\.1<\/string>/)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

process.exit(failures > 0 ? 1 : 0)
