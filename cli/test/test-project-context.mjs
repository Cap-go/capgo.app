import assert from 'node:assert/strict'
import { constants, publicDecrypt } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import AdmZip from 'adm-zip'
import cliPackage from '../package.json'
import { CapgoSDK } from '../src/sdk.ts'
import { resolveDoctorProjectRoot } from '../src/app/info.ts'
import { withCwd } from '../src/build/cwd.ts'
import { patchNotifyAppReadyInSourceAsync } from '../src/recovery/notify-app-ready.ts'
import { createProjectDirQueue } from '../src/mcp/project-dir.ts'
import { findProjectRoot, findRoot, getAllPackagesDependencies, getBundleVersion, getDeclaredPackageVersionMap, getLocalDependencies, getPackageScripts, getPMAndCommand } from '../src/utils.ts'

const previousCwd = process.cwd()
const previousFetch = globalThis.fetch
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'capgo-project-context-')))
const app = join(workspace, 'apps', 'mobile')
const other = join(workspace, 'apps', 'other')
const writeJson = (file, content) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(content))
}
const install = (base, name, version, native = false) => {
  const directory = join(base, 'node_modules', name)
  writeJson(join(directory, 'package.json'), { name, version, ...(native ? { capacitor: { ios: { src: 'ios' } } } : {}) })
  if (native) {
    mkdirSync(join(directory, 'ios'), { recursive: true })
    writeFileSync(join(directory, 'ios', 'Plugin.swift'), 'import Foundation\n')
  }
}

try {
  process.env.CAPGO_DISABLE_TELEMETRY = '1'
  writeJson(join(workspace, 'package.json'), {
    private: true, workspaces: ['apps/*'], version: '9.9.9', packageManager: 'npm@10.0.0',
    scripts: { build: 'workspace-build' }, dependencies: { '@capgo/capacitor-updater': '^7.0.0' },
  })
  writeJson(join(app, 'package.json'), {
    name: 'example-mobile', version: '1.2.3', scripts: { build: 'mobile-build' },
    dependencies: { '@capacitor/core': '^8.0.0', '@capgo/capacitor-updater': '^8.4.0' },
  })
  writeJson(join(app, 'capacitor.config.json'), { appId: 'com.example.mobile', appName: 'Mobile', webDir: 'dist' })
  writeJson(join(other, 'package.json'), { name: 'example-other', version: '2.3.4', packageManager: 'pnpm@10.0.0' })
  writeJson(join(other, 'capacitor.config.json'), { appId: 'com.example.other', webDir: 'dist' })
  writeFileSync(join(other, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  mkdirSync(join(app, 'dist'), { recursive: true })
  writeFileSync(join(app, 'dist', 'index.html'), '<html><body>mobile</body></html>')
  mkdirSync(join(app, 'src'), { recursive: true })
  writeFileSync(join(app, 'src', 'main.ts'), 'console.log("mobile")\n')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'main.ts'), 'console.log("workspace")\n')
  install(workspace, '@capacitor/core', '8.5.3')
  install(workspace, '@capgo/capacitor-updater', '7.0.0', true)
  install(app, '@capgo/capacitor-updater', '8.4.0', true)

  process.chdir(app)
  assert.equal(findRoot(app), workspace)
  assert.equal(findProjectRoot(), app)
  assert.equal(resolveDoctorProjectRoot(), app)
  assert.equal(getBundleVersion(), '1.2.3')
  assert.deepEqual(getPackageScripts(), { build: 'mobile-build' })
  assert.deepEqual(Object.fromEntries(await getAllPackagesDependencies()), {
    '@capacitor/core': '8.5.3', '@capgo/capacitor-updater': '8.4.0',
  })
  assert.deepEqual(Object.fromEntries(await getDeclaredPackageVersionMap()), {
    '@capacitor/core': '^8.0.0', '@capgo/capacitor-updater': '^8.4.0',
  })
  const nativePackages = await getLocalDependencies()
  assert.deepEqual(nativePackages.map(({ name, version, requested_version, native }) => ({ name, version, requested_version, native })), [
    { name: '@capacitor/core', version: '8.5.3', requested_version: '^8.0.0', native: false },
    { name: '@capgo/capacitor-updater', version: '8.4.0', requested_version: '^8.4.0', native: true },
  ])
  assert.equal(getBundleVersion(undefined, join(workspace, 'package.json')), '9.9.9')
  assert.equal((await getAllPackagesDependencies(undefined, join(workspace, 'package.json'))).get('@capgo/capacitor-updater'), '7.0.0')
  process.chdir(other)
  assert.equal((await getLocalDependencies(join(app, 'package.json'))).find(dependency => dependency.name === '@capgo/capacitor-updater').version, '8.4.0')

  process.chdir(app)
  assert.equal(getPMAndCommand().pm, 'npm')
  process.chdir(other)
  assert.equal(getBundleVersion(), '2.3.4')
  assert.equal(getPMAndCommand().pm, 'pnpm')
  process.chdir(app)
  assert.equal(getPMAndCommand().pm, 'npm')

  globalThis.fetch = async input => Response.json({ 'dist-tags': { latest: decodeURIComponent(String(input)).endsWith('/@capgo/cli') ? cliPackage.version : '8.4.0' } })
  const sdk = new CapgoSDK({ apikey: 'example-test-key' })
  const doctor = await sdk.doctor()
  assert.equal(doctor.success, true, doctor.error)
  assert.equal(doctor.data.appId, 'com.example.mobile')
  assert.equal(doctor.data.appVersion, '1.2.3')
  assert.equal(doctor.data.installedDependencies['@capgo/capacitor-updater'], '8.4.0')
  const zipped = await sdk.zipBundle({ appId: 'com.example.mobile', path: 'dist', name: 'mobile.zip', forUpload: true, codeCheck: false, key: false })
  assert.equal(zipped.success, true, zipped.error)
  assert.equal(zipped.data.bundle, '1.2.3')
  assert.equal(zipped.data.updater_version, '8.4.0')
  assert.equal(zipped.data.native_packages.find(dependency => dependency.name === '@capgo/capacitor-updater').requested_version, '^8.4.0')
  assert.equal(existsSync(join(app, 'mobile.zip')), true)

  const keys = await sdk.generateEncryptionKeys()
  assert.equal(keys.success, true, keys.error)
  const encrypted = await sdk.encryptBundle({ zipPath: 'mobile.zip', checksum: zipped.data.checksum })
  assert.equal(encrypted.success, true, encrypted.error)
  assert.match(encrypted.data.checksum, /^[a-f0-9]{512}$/)
  const digest = publicDecrypt({ key: readFileSync(join(app, '.capgo_key_v2.pub'), 'utf8'), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(encrypted.data.checksum, 'hex'))
  assert.equal(digest.toString('hex'), zipped.data.checksum)
  const decrypted = await sdk.decryptBundle({ zipPath: encrypted.data.filename, ivSessionKey: encrypted.data.ivSessionKey, checksum: encrypted.data.checksum })
  assert.equal(decrypted.success, true, decrypted.error)
  assert.equal(decrypted.data.checksumMatches, true)
  assert.deepEqual(readFileSync(decrypted.data.outputPath), readFileSync(join(app, 'mobile.zip')))

  mkdirSync(join(app, 'android'), { recursive: true })
  writeFileSync(join(app, 'android', 'settings.gradle'), 'rootProject.name = "ExampleMobile"\n')
  const buildZip = await withCwd(app, () => sdk.zipBuild({ platform: 'android', syncAndroidVersion: false, output: 'native.zip' }))
  assert.equal(buildZip.success, true, buildZip.error)
  assert.equal(buildZip.data.app_id, 'com.example.mobile')
  assert.equal(JSON.parse(new AdmZip(buildZip.data.filename).readAsText('package.json')).version, '1.2.3')

  assert.equal(await patchNotifyAppReadyInSourceAsync(), join(app, 'src', 'main.ts'))
  assert.match(readFileSync(join(app, 'src', 'main.ts'), 'utf8'), /CapacitorUpdater.notifyAppReady\(\)/)
  assert.equal(readFileSync(join(workspace, 'src', 'main.ts'), 'utf8'), 'console.log("workspace")\n')

  const runInProject = createProjectDirQueue()
  let releaseFirst
  let firstStarted
  const started = new Promise(resolve => { firstStarted = resolve })
  const release = new Promise(resolve => { releaseFirst = resolve })
  const first = runInProject(async () => {
    process.chdir(app)
    firstStarted()
    await release
    return getBundleVersion()
  })
  await started
  const second = runInProject(async () => {
    process.chdir(other)
    return getBundleVersion()
  })
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second]), ['1.2.3', '2.3.4'])
  await assert.rejects(runInProject(async () => { throw new Error('example failure') }), /example failure/)
  assert.equal(await runInProject(async () => getBundleVersion()), '2.3.4')
  console.log('✅ Project context: metadata, hoisting, SDK doctor/bundle zip/encrypt/decrypt/native zip, source repair, package managers, and concurrent switches')
}
finally {
  globalThis.fetch = previousFetch
  process.chdir(previousCwd)
  rmSync(workspace, { recursive: true, force: true })
}
