#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { shouldCapturePosthogException } from '../src/posthog.ts'
import { saveKeyInternal } from '../src/key.ts'
import { setConfigWriteTarget } from '../src/config/index.ts'
import {
  collectAppIdCandidates,
  isValidAppId,
  parsePackageJsonOptionPaths,
  resolveAppIdWithRecovery,
} from '../src/recovery/app-id.ts'
import {
  findBuildEntryJsPath,
  hasCallableCapacitorUpdaterBinding,
  injectNotifyAppReadyIntoBuildJs,
  injectNotifyAppReadyIntoJs,
  patchNotifyAppReadyInBuildFolder,
} from '../src/recovery/notify-app-ready.ts'
import { resolveLocalSemverFallback, resolveUpdaterPackageJsonPath, buildUpdaterInstallInvocation } from '../src/recovery/bundle-zip.ts'
import { zipBundleInternal } from '../src/bundle/zip.ts'

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

await test('findBuildEntryJsPath prefers the app bundle over polyfills in index.html', () => {
  const root = makeTempDir('entry-polyfill')
  writeFileSync(join(root, 'index.html'), [
    '<html><body>',
    '<script src="./polyfills.js"></script>',
    '<script src="./main.js"></script>',
    '</body></html>',
  ].join(''))
  writeFileSync(join(root, 'polyfills.js'), 'console.log("polyfill")')
  writeFileSync(join(root, 'main.js'), 'var CapacitorUpdater = {};\nconsole.log("boot")')
  assert.equal(findBuildEntryJsPath(root), join(root, 'main.js'))
})

await test('injectNotifyAppReadyIntoJs appends notifyAppReady when CapacitorUpdater is already imported', () => {
  const input = 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\'\nconsole.log("boot")\n'
  const output = injectNotifyAppReadyIntoJs('main.js', input)
  assert.match(output, /CapacitorUpdater\.notifyAppReady\(\)/)
})

await test('injectNotifyAppReadyIntoBuildJs refuses to add bare package imports', () => {
  const input = 'console.log("boot")\n'
  assert.equal(injectNotifyAppReadyIntoBuildJs(input), undefined)
})

await test('injectNotifyAppReadyIntoBuildJs ignores CapacitorUpdater string literals', () => {
  const input = 'console.log("CapacitorUpdater")\n'
  assert.equal(injectNotifyAppReadyIntoBuildJs(input), undefined)
  assert.equal(hasCallableCapacitorUpdaterBinding(input), false)
})

await test('injectNotifyAppReadyIntoBuildJs appends notifyAppReady to a real CapacitorUpdater binding', () => {
  const input = 'var CapacitorUpdater = { notifyAppReady() { CapacitorUpdater.ready = true }, ready: false };\n'
  const output = injectNotifyAppReadyIntoBuildJs(input)
  assert.match(output, /CapacitorUpdater\.notifyAppReady\(\)/)
  const sandbox = {}
  vm.runInNewContext(output, sandbox)
  assert.equal(sandbox.CapacitorUpdater.ready, true)
})

await test('injectNotifyAppReadyIntoJs uses require for CommonJS main.js projects', () => {
  const root = makeTempDir('cjs-main')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  const mainPath = join(root, 'main.js')
  const output = injectNotifyAppReadyIntoJs(mainPath, 'console.log("boot")\n')
  assert.match(output, /require\('@capgo\/capacitor-updater'\)/)
})

await test('saveKeyInternal keeps explicit keyData over a stale public key file', async () => {
  const root = makeTempDir('save-key')
  const previousCwd = process.cwd()
  process.chdir(root)
  try {
    const configPath = join(root, 'capacitor.config.json')
    writeFileSync(configPath, JSON.stringify({
      appId: 'com.example.app',
      appName: 'demo',
      webDir: 'www',
      plugins: { CapacitorUpdater: {} },
    }, null, 2))
    setConfigWriteTarget(configPath)
    const stalePublicKey = '-----BEGIN RSA PUBLIC KEY-----\nstale-public-key\n-----END RSA PUBLIC KEY-----'
    const suppliedPublicKey = '-----BEGIN RSA PUBLIC KEY-----\nsupplied-public-key\n-----END RSA PUBLIC KEY-----'
    writeFileSync('.capgo_key_v2.pub', stalePublicKey)
    await saveKeyInternal({ keyData: suppliedPublicKey }, true)
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(config.plugins.CapacitorUpdater.publicKey, suppliedPublicKey)
    assert.notEqual(config.plugins.CapacitorUpdater.publicKey, stalePublicKey)
  }
  finally {
    process.chdir(previousCwd)
  }
})

await test('patchNotifyAppReadyInBuildFolder writes notifyAppReady into the built bundle', () => {
  const root = makeTempDir('patch')
  writeFileSync(join(root, 'index.html'), '<html><body><script src="./index.js"></script></body></html>')
  writeFileSync(join(root, 'index.js'), 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\'\nconsole.log("boot")\n')
  const patched = patchNotifyAppReadyInBuildFolder(root)
  assert.equal(patched, join(root, 'index.js'))
  assert.match(readFileSync(join(root, 'index.js'), 'utf8'), /notifyAppReady/)
})

await test('patchNotifyAppReadyInBuildFolder skips bundles that already call notifyAppReady', () => {
  const root = makeTempDir('patch-present')
  writeFileSync(join(root, 'index.html'), '<html><body><script src="./index.js"></script></body></html>')
  writeFileSync(join(root, 'index.js'), 'var CapacitorUpdater = {};\nCapacitorUpdater.notifyAppReady();\n')
  assert.equal(patchNotifyAppReadyInBuildFolder(root), undefined)
})

await test('injectNotifyAppReadyIntoBuildJs uses aliased ESM updater binding', () => {
  const input = 'import { CapacitorUpdater as Updater } from \'@capgo/capacitor-updater\'\nconsole.log("boot")\n'
  const output = injectNotifyAppReadyIntoBuildJs(input)
  assert.match(output, /Updater\.notifyAppReady\(\)/)
})

await test('injectNotifyAppReadyIntoBuildJs uses aliased CommonJS updater binding', () => {
  const input = 'const { CapacitorUpdater: Updater } = require(\'@capgo/capacitor-updater\')\nconsole.log("boot")\n'
  const output = injectNotifyAppReadyIntoBuildJs(input)
  assert.match(output, /Updater\.notifyAppReady\(\)/)
})

await test('injectNotifyAppReadyIntoBuildJs uses CapacitorUpdater from mixed CommonJS destructuring', () => {
  const input = 'const { CapacitorUpdater, App } = require(\'@capgo/capacitor-updater\')\nconsole.log("boot")\n'
  const output = injectNotifyAppReadyIntoBuildJs(input)
  assert.match(output, /CapacitorUpdater\.notifyAppReady\(\)/)
})

await test('injectNotifyAppReadyIntoBuildJs skips empty CapacitorUpdater bindings', () => {
  const input = 'var CapacitorUpdater = {};\nconsole.log("boot")\n'
  assert.equal(injectNotifyAppReadyIntoBuildJs(input), undefined)
})

await test('resolveAppIdWithRecovery ignores invalid config appId values', async () => {
  const root = makeTempDir('appid-invalid-config')
  const previousCwd = process.cwd()
  process.chdir(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }))
  try {
    await assert.rejects(
      () => resolveAppIdWithRecovery({
        config: { appId: 'io.ionic.starter' },
        interactive: false,
        json: true,
      }),
      /missing_app_id/,
    )
  }
  finally {
    process.chdir(previousCwd)
  }
})

await test('patchNotifyAppReadyInBuildFolder skips bundles without CapacitorUpdater', () => {
  const root = makeTempDir('patch-skip')
  writeFileSync(join(root, 'index.html'), '<html><body><script src="./index.js"></script></body></html>')
  writeFileSync(join(root, 'index.js'), 'console.log("boot")\n')
  assert.equal(patchNotifyAppReadyInBuildFolder(root), undefined)
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

await test('parsePackageJsonOptionPaths splits comma-separated package.json paths', () => {
  assert.deepEqual(
    parsePackageJsonOptionPaths(' ./a/package.json , ./b/package.json '),
    ['./a/package.json', './b/package.json'],
  )
})

await test('collectAppIdCandidates reads appId from an explicit package.json path', () => {
  const root = makeTempDir('appid-package-json')
  const customPackageJson = join(root, 'custom-package.json')
  writeFileSync(customPackageJson, JSON.stringify({ capacitor: { appId: 'com.custom.package' } }))
  const candidates = collectAppIdCandidates(undefined, root, [customPackageJson])
  assert.deepEqual(candidates, ['com.custom.package'])
})

await test('isValidAppId rejects reserved and malformed ids', () => {
  assert.equal(isValidAppId('com.example.app'), true)
  assert.equal(isValidAppId('io.ionic.starter'), false)
  assert.equal(isValidAppId('bad id'), false)
})

await test('resolveLocalSemverFallback builds a local semver tag', () => {
  assert.equal(resolveLocalSemverFallback('abc123'), '0.0.1-beta.local-abc123')
})

await test('resolveUpdaterPackageJsonPath picks the first existing comma-separated package.json', () => {
  const root = makeTempDir('updater-pkg')
  writeFileSync(join(root, 'package.json'), '{}')
  const nested = join(root, 'apps', 'mobile')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'package.json'), '{}')
  const missing = join(root, 'missing', 'package.json')
  const resolved = resolveUpdaterPackageJsonPath(`${missing},${join(nested, 'package.json')}`)
  assert.equal(resolved, join(nested, 'package.json'))
})

await test('resolveUpdaterPackageJsonPath resolves root-relative package.json options', () => {
  const root = makeTempDir('updater-pkg-relative')
  writeFileSync(join(root, 'package.json'), '{}')
  const nested = join(root, 'apps', 'mobile')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'package.json'), '{}')
  const previousCwd = process.cwd()
  try {
    process.chdir(root)
    const resolved = resolveUpdaterPackageJsonPath('missing/package.json,apps/mobile/package.json')
    assert.equal(resolved, join(root, 'apps', 'mobile', 'package.json'))
  }
  finally {
    process.chdir(previousCwd)
  }
})

await test('buildUpdaterInstallInvocation uses yarn add when updater is not declared', () => {
  const invocation = buildUpdaterInstallInvocation({ pm: 'yarn', installCommand: 'yarn install' }, '^7.0.0', null)
  assert.deepEqual(invocation, { command: 'yarn', args: ['add', '@capgo/capacitor-updater@^7.0.0'] })
})

await test('buildUpdaterInstallInvocation uses bun add when updater is not declared', () => {
  const invocation = buildUpdaterInstallInvocation({ pm: 'bun', installCommand: 'bun install' }, 'latest', null)
  assert.deepEqual(invocation, { command: 'bun', args: ['add', '@capgo/capacitor-updater@latest'] })
})

await test('buildUpdaterInstallInvocation uses pnpm add when updater is not declared', () => {
  const invocation = buildUpdaterInstallInvocation({ pm: 'pnpm', installCommand: 'pnpm install' }, '^7.0.0', null)
  assert.deepEqual(invocation, { command: 'pnpm', args: ['add', '@capgo/capacitor-updater@^7.0.0'] })
})

await test('buildUpdaterInstallInvocation restores declared yarn deps via install', () => {
  const invocation = buildUpdaterInstallInvocation({ pm: 'yarn', installCommand: 'yarn install' }, '^7.0.0', '^7.0.0')
  assert.deepEqual(invocation, { command: 'yarn', args: ['install'] })
})

await test('zipBundleInternal silent notifyAppReady failure stays PostHog-capturable', async () => {
  const root = makeTempDir('zip-silent')
  const webDir = join(root, 'www')
  mkdirSync(webDir)
  writeFileSync(join(webDir, 'index.html'), '<html></html>')
  writeFileSync(join(webDir, 'main.js'), 'console.log("hello")')

  await assert.rejects(
    () => zipBundleInternal('com.example.app', { path: webDir, bundle: '1.0.0' }, true),
    (error) => {
      assert.match(error.message, /notifyAppReady\(\) is missing/)
      assert.equal(shouldCapturePosthogException(error), true)
      return true
    },
  )
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
