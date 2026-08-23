#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { validateIosUpdaterSync } from '../src/utils.ts'

let testsPassed = 0
let testsFailed = 0

function assert(condition, message) {
  if (!condition)
    throw new Error(message)
}

function writeFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
}

function makeProjectDir() {
  return mkdtempSync(join(tmpdir(), 'capgo-ios-sync-'))
}

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
    testsPassed++
  }
  catch (error) {
    console.error(`❌ ${name}`)
    console.error(`   ${error instanceof Error ? error.message : String(error)}`)
    testsFailed++
  }
}

console.log('🧪 Testing iOS updater sync validation...\n')

await test('valid iOS project returns shouldCheck=true and valid=true', () => {
  const root = makeProjectDir()
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@capgo/capacitor-updater': '^7.0.0',
      },
    }))

    const iosRoot = join(root, 'ios', 'App')
    writeFile(join(iosRoot, 'Podfile'), "pod '@capgo/capacitor-updater'\n")
    writeFile(join(iosRoot, 'Podfile.lock'), 'CapgoCapacitorUpdater\n')

    const result = validateIosUpdaterSync(root)
    assert(result.shouldCheck === true, 'Expected shouldCheck=true')
    assert(result.valid === true, 'Expected valid=true')
    assert(result.details.length === 0, 'Expected no details')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('spm iOS project with packageClassList returns shouldCheck=true and valid=true', () => {
  const root = makeProjectDir()
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@capgo/capacitor-updater': '^7.0.0',
      },
    }))

    const iosRoot = join(root, 'ios', 'App')
    writeFile(
      join(iosRoot, 'CapApp-SPM', 'Package.swift'),
            `.package(name: "CapgoCapacitorUpdater", path: "../../../node_modules/@capgo/capacitor-updater"),\n`,
    )
    writeFile(
      join(iosRoot, 'App', 'capacitor.config.json'),
      JSON.stringify({
        packageClassList: ['CapacitorUpdaterPlugin'],
      }),
    )

    const result = validateIosUpdaterSync(root)
    assert(result.shouldCheck === true, 'Expected shouldCheck=true')
    assert(result.valid === true, 'Expected valid=true')
    assert(result.details.length === 0, 'Expected no details')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('spm iOS project ignores CapacitorUpdaterPlugin outside packageClassList', () => {
  const root = makeProjectDir()
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@capgo/capacitor-updater': '^7.0.0',
      },
    }))

    const iosRoot = join(root, 'ios', 'App')
    writeFile(
      join(iosRoot, 'CapApp-SPM', 'Package.swift'),
      `.package(name: "CapgoCapacitorUpdater", path: "../../../node_modules/@capgo/capacitor-updater"),\n`,
    )
    writeFile(
      join(iosRoot, 'App', 'capacitor.config.json'),
      JSON.stringify({
        packageClassList: ['OtherPlugin'],
        note: 'CapacitorUpdaterPlugin',
      }),
    )

    const result = validateIosUpdaterSync(root)
    assert(result.shouldCheck === true, 'Expected shouldCheck=true')
    assert(result.valid === false, 'Expected valid=false')
    assert(result.details.some(detail => detail.includes('native project outputs')), 'Expected native-outputs detail')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('missing dependency file entries fails validation', () => {
  const root = makeProjectDir()
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@capgo/capacitor-updater': '^7.0.0',
      },
    }))

    const iosRoot = join(root, 'ios', 'App')
    writeFile(join(iosRoot, 'Podfile.lock'), 'CapgoCapacitorUpdater\n')

    const result = validateIosUpdaterSync(root)
    assert(result.shouldCheck === true, 'Expected shouldCheck=true')
    assert(result.valid === false, 'Expected valid=false')
    assert(result.details.some(detail => detail.includes('dependency files')), 'Expected dependency-files detail')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('missing native output entries fails validation', () => {
  const root = makeProjectDir()
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@capgo/capacitor-updater': '^7.0.0',
      },
    }))

    const iosRoot = join(root, 'ios', 'App')
    writeFile(join(iosRoot, 'Podfile'), "pod '@capgo/capacitor-updater'\n")

    const result = validateIosUpdaterSync(root)
    assert(result.shouldCheck === true, 'Expected shouldCheck=true')
    assert(result.valid === false, 'Expected valid=false')
    assert(result.details.some(detail => detail.includes('native project outputs')), 'Expected native-outputs detail')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('missing ios/App folder skips validation', () => {
  const root = makeProjectDir()
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@capgo/capacitor-updater': '^7.0.0',
      },
    }))

    const result = validateIosUpdaterSync(root)
    assert(result.shouldCheck === false, 'Expected shouldCheck=false')
    assert(result.valid === true, 'Expected valid=true')
    assert(result.details.length === 0, 'Expected no details')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('ios project without updater signals returns shouldCheck=false', () => {
  const root = makeProjectDir()
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeFile(join(root, 'ios', 'App', 'Podfile'), 'platform :ios, "14.0"\n')

    const result = validateIosUpdaterSync(root)
    assert(result.shouldCheck === false, 'Expected shouldCheck=false')
    assert(result.valid === true, 'Expected valid=true')
    assert(result.details.length === 0, 'Expected no details')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('monorepo packageJsonPath points validation to app iOS folder', () => {
  const root = makeProjectDir()
  try {
    const appRoot = join(root, 'apps', 'mobile')
    writeFile(join(appRoot, 'package.json'), JSON.stringify({
      dependencies: {
        '@capgo/capacitor-updater': '^7.0.0',
      },
    }))
    writeFile(join(appRoot, 'ios', 'App', 'Podfile'), "pod '@capgo/capacitor-updater'\n")
    writeFile(join(appRoot, 'ios', 'App', 'Podfile.lock'), 'CapgoCapacitorUpdater\n')

    const result = validateIosUpdaterSync(root, 'apps/mobile/package.json')
    assert(result.shouldCheck === true, 'Expected shouldCheck=true for monorepo app path')
    assert(result.valid === true, 'Expected valid=true for monorepo app path')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('promptAndSync throws CliUserError when iOS sync validation fails', () => {
  const utilsSource = readFileSync(new URL('../src/utils.ts', import.meta.url), 'utf-8')
  assert(
    utilsSource.includes("throw new CliUserError('iOS sync validation failed. Delete your iOS folder, then rerun the add and sync commands above and retry.')"),
    'Expected promptAndSync to throw CliUserError for iOS sync validation failure',
  )
})

await test('corrupted package.json does not crash validation', () => {
  const root = makeProjectDir()
  try {
    writeFile(join(root, 'package.json'), '{invalid json')
    const iosRoot = join(root, 'ios', 'App')
    writeFile(join(iosRoot, 'Podfile'), "pod '@capgo/capacitor-updater'\n")
    writeFile(join(iosRoot, 'Podfile.lock'), 'CapgoCapacitorUpdater\n')

    const result = validateIosUpdaterSync(root)
    assert(result.shouldCheck === true, 'Expected shouldCheck=true from iOS updater markers')
    assert(result.valid === true, 'Expected valid=true with both dependency/native markers present')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

console.log('\n' + '='.repeat(50))
console.log(`Passed: ${testsPassed}`)
console.log(`Failed: ${testsFailed}`)

if (testsFailed > 0)
  process.exit(1)
