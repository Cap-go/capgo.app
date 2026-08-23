#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldCapturePosthogException } from '../src/posthog.ts'
import {
  collectAppIdCandidates,
  findBuildEntryJsPath,
  injectNotifyAppReadyIntoJs,
  isValidAppId,
  patchNotifyAppReadyInBuildFolder,
} from '../src/recovery/index.ts'

const tempDirs = []
let failures = 0

function makeTempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `capgo-cli-recovery-${name}-`))
  tempDirs.push(dir)
  return dir
}

async function test(name, fn) {
  try {
    await fn()
    console.log(`✅ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

await test('findBuildEntryJsPath reads the script referenced by index.html', () => {
  const root = makeTempDir('entry')
  writeFileSync(join(root, 'index.html'), '<html><body><script type="module" src="./assets/main.js"></script></body></html>')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'assets', 'main.js'), 'console.log("ready")')
  assert.equal(findBuildEntryJsPath(root), join(root, 'assets', 'main.js'))
})

await test('injectNotifyAppReadyIntoJs appends notifyAppReady when CapacitorUpdater is already imported', () => {
  const input = 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\'\nconsole.log("boot")\n'
  const output = injectNotifyAppReadyIntoJs('main.js', input)
  assert.match(output, /CapacitorUpdater\.notifyAppReady\(\)/)
})

await test('patchNotifyAppReadyInBuildFolder writes notifyAppReady into the built bundle', () => {
  const root = makeTempDir('patch')
  writeFileSync(join(root, 'index.html'), '<html><body><script src="./index.js"></script></body></html>')
  writeFileSync(join(root, 'index.js'), 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\'\nconsole.log("boot")\n')
  const patched = patchNotifyAppReadyInBuildFolder(root)
  assert.equal(patched, join(root, 'index.js'))
  assert.match(readFileSync(join(root, 'index.js'), 'utf8'), /notifyAppReady/)
})

await test('collectAppIdCandidates gathers config and gradle applicationId values', () => {
  const root = makeTempDir('appid')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', capacitor: { appId: 'com.package.app' } }))
  mkdirSync(join(root, 'android', 'app'), { recursive: true })
  writeFileSync(join(root, 'android', 'app', 'build.gradle'), 'android { defaultConfig { applicationId "com.gradle.app" } }')
  const candidates = collectAppIdCandidates({
    appId: 'com.config.app',
    plugins: { CapacitorUpdater: { appId: 'com.updater.app' } },
  }, root)
  assert.deepEqual(new Set(candidates), new Set(['com.config.app', 'com.updater.app', 'com.package.app', 'com.gradle.app']))
})

await test('isValidAppId rejects reserved and malformed ids', () => {
  assert.equal(isValidAppId('com.example.app'), true)
  assert.equal(isValidAppId('io.ionic.starter'), false)
  assert.equal(isValidAppId('bad id'), false)
})

await test('failed recovery errors stay visible to PostHog exception capture', () => {
  assert.equal(shouldCapturePosthogException(new Error('notifyAppReady() is missing in build folder')), true)
  assert.equal(shouldCapturePosthogException(new Error('Missing public key in config')), true)
  assert.equal(shouldCapturePosthogException(new Error('Missing appId')), true)
})

for (const dir of tempDirs) {
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n❌ ${failures} CLI recovery test(s) failed`)
  process.exit(1)
}

console.log('\n✅ CLI recovery tests passed')
