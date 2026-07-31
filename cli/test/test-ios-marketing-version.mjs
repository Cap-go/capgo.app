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

function createFixture(packageVersion) {
  const cwd = mkdtempSync(join(tmpdir(), 'capgo-ios-version-'))
  const xcodeProjectDir = join(cwd, 'ios/App/App.xcodeproj')

  mkdirSync(xcodeProjectDir, { recursive: true })
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: packageVersion }))
  writeFileSync(join(xcodeProjectDir, 'project.pbxproj'), [
    'Debug = { MARKETING_VERSION = 0.0.1; };',
    'Release = { MARKETING_VERSION = 0.0.1; };',
  ].join('\n'))

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
  const cwd = createFixture('1.2.3-alpha.0')

  try {
    const result = syncIosMarketingVersion({ path: cwd })
    const project = readFileSync(join(cwd, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')

    assert.equal(result.changed, true)
    assert.equal(result.marketingVersion, '1.2.3')
    assert.match(project, /Debug = \{ MARKETING_VERSION = 1\.2\.3; \};/)
    assert.match(project, /Release = \{ MARKETING_VERSION = 1\.2\.3; \};/)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

await test('check mode reports drift without writing', () => {
  const cwd = createFixture('1.2.3')

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

process.exit(failures > 0 ? 1 : 0)
