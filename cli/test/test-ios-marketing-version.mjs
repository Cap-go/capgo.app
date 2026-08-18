#!/usr/bin/env bun

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  const generateInfoPlist = options.generateInfoPlist ?? 'NO'
  const configurations = options.configurations ?? [
    { name: 'Debug', generateInfoPlist, infoPlistPath: 'App/Info.plist' },
    { name: 'Release', generateInfoPlist, infoPlistPath: 'App/Info.plist' },
  ]
  const infoPlists = options.infoPlists ?? (options.infoPlistVersion === undefined
    ? {}
    : { 'App/Info.plist': options.infoPlistVersion })

  mkdirSync(xcodeProjectDir, { recursive: true })
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: packageVersion }))
  writeFileSync(join(xcodeProjectDir, 'project.pbxproj'), configurations.map((configuration, index) => {
    const generateInfoPlistSetting = configuration.generateInfoPlist === 'DEFAULT'
      ? ''
      : `GENERATE_INFOPLIST_FILE = ${configuration.generateInfoPlist}; `
    return `${index} /* ${configuration.name} */ = { isa = XCBuildConfiguration; buildSettings = { ${generateInfoPlistSetting}INFOPLIST_FILE = ${configuration.infoPlistPath}; MARKETING_VERSION = 0.0.1; }; name = ${configuration.name}; };`
  }).join('\n'))

  for (const [relativePath, infoPlistVersion] of Object.entries(infoPlists)) {
    const infoPlistPath = join(cwd, 'ios/App', relativePath)
    mkdirSync(dirname(infoPlistPath), { recursive: true })
    const versionEntry = infoPlistVersion === null
      ? ''
      : `  <key>CFBundleShortVersionString</key>\n  <string>${infoPlistVersion}</string>\n`
    writeFileSync(infoPlistPath, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${versionEntry}</dict>\n</plist>\n`)
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
    assert.match(project, /\/\* Debug \*\/ = \{[^}]*MARKETING_VERSION = 1\.2\.3;/)
    assert.match(project, /\/\* Release \*\/ = \{[^}]*MARKETING_VERSION = 1\.2\.3;/)
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

await test('keeps generated and manually managed Info.plists scoped to their build configurations', () => {
  const cwd = createFixture('1.2.3', {
    configurations: [
      { name: 'Debug', generateInfoPlist: 'YES', infoPlistPath: 'Generated/Info.plist' },
      { name: 'Release', generateInfoPlist: 'NO', infoPlistPath: 'Manual/Info.plist' },
    ],
    infoPlists: {
      'Generated/Info.plist': '0.0.1',
      'Manual/Info.plist': '0.0.1',
    },
  })

  try {
    syncIosMarketingVersion({ path: cwd })

    const generatedPlist = readFileSync(join(cwd, 'ios/App/Generated/Info.plist'), 'utf8')
    const manualPlist = readFileSync(join(cwd, 'ios/App/Manual/Info.plist'), 'utf8')
    assert.match(generatedPlist, /<string>0\.0\.1<\/string>/)
    assert.match(manualPlist, /<string>1\.2\.3<\/string>/)
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

await test('rejects a malformed Info.plist without writing an update', () => {
  const cwd = createFixture('1.2.3', { infoPlistVersion: '0.0.1' })
  const infoPlistPath = join(cwd, 'ios/App/App/Info.plist')
  const malformedPlist = '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.0.1</string></plist>trailing'
  writeFileSync(infoPlistPath, malformedPlist)

  try {
    assert.throws(() => syncIosMarketingVersion({ path: cwd }), /malformed Info\.plist/)
    assert.equal(readFileSync(infoPlistPath, 'utf8'), malformedPlist)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

process.exit(failures > 0 ? 1 : 0)
