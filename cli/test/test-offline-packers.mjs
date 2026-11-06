#!/usr/bin/env node
// Offline packers: `bundle zip --for-upload [--delta-pack]` and `build zip`.
// They must produce the same artifacts as `bundle upload` / `build request`
// without an API key and without any network call.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import AdmZip from 'adm-zip'

process.env.CAPGO_DISABLE_TELEMETRY = 'true'
process.env.CAPGO_TOKEN = ''
// Any network call is a failure for an offline packer.
const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = async (...args) => {
  fetchCalls++
  throw new Error(`unexpected network call: ${String(args[0])}`)
}

const { createRSA, decryptChecksumV3, decryptSource } = await import('../src/api/crypto.ts')
const { getChecksum } = await import('../src/checksum.ts')
const { zipBundleInternal } = await import('../src/bundle/zip.ts')
const { prepareBundleArtifact } = await import('../src/bundle/upload-artifact.ts')
const { DELTA_PACK_MANIFEST_FILE } = await import('../src/bundle/delta-pack.ts')
const { runWithUploadReporter } = await import('../src/bundle/reporter.ts')
const { zipBuildInternal } = await import('../src/build/zip-command.ts')
const { zipDirectory } = await import('../src/build/request.ts')
const { applyCommandAnalyticsOptOut } = await import('../src/analytics/opt-out.ts')

async function t(name, fn) {
  try {
    await fn()
    process.stdout.write(`✅ ${name}\n`)
  }
  catch (error) {
    process.stderr.write(`❌ ${name}: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  }
}

function writeFile(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function makeWebProject({ updaterVersion = '7.30.0', withKey = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'capgo-offline-bundle-'))
  writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'offline-app',
    version: '1.2.3',
    dependencies: { '@capgo/capacitor-updater': updaterVersion },
  }))
  writeFile(join(root, 'node_modules/@capgo/capacitor-updater/package.json'), JSON.stringify({ name: '@capgo/capacitor-updater', version: updaterVersion }))
  const keys = createRSA()
  writeFile(join(root, 'capacitor.config.json'), JSON.stringify({
    appId: 'com.example.offline',
    appName: 'Offline',
    webDir: 'dist',
    plugins: { CapacitorUpdater: withKey ? { publicKey: keys.publicKey } : {} },
  }))
  if (withKey)
    writeFile(join(root, '.capgo_key_v2'), keys.privateKey)
  writeFile(join(root, 'dist/index.html'), '<html><script src="app.js"></script></html>')
  // > 8 KiB and very compressible: brotli path in the delta upload.
  writeFile(join(root, 'dist/app.js'), `CapacitorUpdater.notifyAppReady();\n${'console.log("capgo");\n'.repeat(2000)}`)
  writeFile(join(root, 'dist/small.txt'), 'tiny file')
  writeFile(join(root, 'dist/empty.txt'), '')
  return { root, keys }
}

async function inDir(dir, fn) {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  }
  finally {
    process.chdir(previous)
  }
}

await t('offline commands disable telemetry', () => {
  const env = {}
  assert.equal(applyCommandAnalyticsOptOut('bundle zip', {}, env), true)
  assert.equal(env.CAPGO_DISABLE_TELEMETRY, 'true')
  assert.equal(applyCommandAnalyticsOptOut('build zip', {}, {}), true)
  assert.equal(applyCommandAnalyticsOptOut('bundle upload', {}, {}), false)
})

await t('legacy bundle zip never encrypts and keeps bundle/filename/checksum', async () => {
  const { root } = makeWebProject({ withKey: true })
  try {
    await inDir(root, async () => {
      const result = await zipBundleInternal('', { path: 'dist', name: 'legacy.zip', json: true }, true)
      assert.equal(result.bundle, '1.2.3')
      assert.equal(result.filename, 'legacy.zip')
      const zip = readFileSync('legacy.zip')
      assert.equal(result.checksum, await getChecksum(zip, 'sha256'))
      assert.equal(result.checksum_algorithm, 'sha256')
      assert.equal(result.app_id, 'com.example.offline')
      assert.equal(result.updater_version, '7.30.0')
      assert.equal(result.size_bytes, zip.byteLength)
      assert.equal(result.session_key, undefined)
      assert.equal(result.encryption_method, undefined)
      // Still a readable zip (not encrypted).
      assert.ok(new AdmZip(zip).getEntry('index.html'))
    })
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await t('bundle zip --for-upload matches the bundle upload artifact (v2 encryption)', async () => {
  const { root, keys } = makeWebProject({ withKey: true })
  try {
    await inDir(root, async () => {
      const result = await zipBundleInternal('', { path: 'dist', name: 'upload.zip', forUpload: true, key: true }, true)
      assert.equal(result.encryption_method, 'v2')
      assert.ok(result.session_key)
      assert.ok(result.key_id)
      assert.deepEqual(result.native_packages, [])
      const encrypted = readFileSync('upload.zip')
      assert.equal(result.size_bytes, encrypted.byteLength)
      // Decrypts to a plain zip whose sha256 is the signed checksum (V3 for updater 7.30.0).
      const plain = decryptSource(encrypted, result.session_key, keys.publicKey)
      assert.ok(new AdmZip(plain).getEntry('index.html'))
      assert.equal(decryptChecksumV3(result.checksum, keys.publicKey), await getChecksum(plain, 'sha256'))

      // Same helper the online upload calls, same inputs: same algorithm and key id.
      const quiet = { info() {}, warn() {}, error() {}, success() {}, intro() {}, outro() {}, spinner: () => ({ start() {}, message() {}, stop() {}, error() {} }) }
      const reference = await runWithUploadReporter(quiet, () => prepareBundleArtifact('dist', { apikey: '', key: true }, keys.publicKey))
      assert.equal(reference.checksumAlgorithm, result.checksum_algorithm)
      assert.equal(reference.keyId, result.key_id)
      assert.equal(reference.encryptionMethod, 'v2')
    })
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await t('bundle zip --for-upload --no-key produces a clear zip', async () => {
  const { root } = makeWebProject({ withKey: true })
  try {
    await inDir(root, async () => {
      const result = await zipBundleInternal('', { path: 'dist', name: 'clear.zip', forUpload: true, key: false }, true)
      assert.equal(result.encryption_method, 'none')
      assert.equal(result.session_key, undefined)
      assert.equal(result.checksum, await getChecksum(readFileSync('clear.zip'), 'sha256'))
    })
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await t('bundle zip --delta-pack writes the delta upload entries and bytes', async () => {
  const { root, keys } = makeWebProject({ withKey: true })
  try {
    await inDir(root, async () => {
      const result = await zipBundleInternal('', { path: 'dist', name: 'full.zip', deltaPack: 'delta.zip', key: true }, true)
      assert.equal(result.encryption_method, 'v2')
      assert.equal(result.delta_pack, 'delta.zip')
      // empty.txt is skipped like the online manifest.
      assert.equal(result.delta_pack_entries, 3)
      // updater >= 6.14.4 auto-encrypts delta files; >= 7.30.0 uses hex (V3) signatures.
      assert.deepEqual(result.delta_encryption, { enabled: true })
      assert.equal(result.delta_file_hash_format, 'rsa_v3_hex')

      const pack = new AdmZip(readFileSync('delta.zip'))
      for (const entry of pack.getEntries())
        assert.equal(entry.header.method, 0, `${entry.entryName} must be STORE`)
      const manifest = JSON.parse(pack.readAsText(DELTA_PACK_MANIFEST_FILE))
      assert.equal(manifest.protocol_version, 1)
      assert.equal(manifest.file_hash_format, 'rsa_v3_hex')
      assert.equal(manifest.entries.length, 3)
      const byName = Object.fromEntries(manifest.entries.map(entry => [entry.file_name, entry]))
      assert.equal(byName['app.js.br'].compression, 'brotli')
      assert.equal(byName['small.txt'].compression, 'none')
      for (const entry of manifest.entries) {
        const bytes = pack.getEntry(entry.pack_path).getData()
        assert.equal(bytes.byteLength, entry.uploaded_bytes_size)
        assert.equal(sha256(bytes), entry.uploaded_bytes_sha256)
      }
      // file_hash is the signed sha256 of the original file.
      const smallHash = sha256(readFileSync('dist/small.txt'))
      assert.equal(decryptChecksumV3(byName['small.txt'].file_hash, keys.publicKey), smallHash)
      // Uploaded bytes are encrypted with the bundle session key.
      const smallBytes = pack.getEntry(byName['small.txt'].pack_path).getData()
      assert.equal(decryptSource(smallBytes, result.session_key, keys.publicKey).toString(), 'tiny file')
    })
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await t('bundle zip --delta-pack without key uses plain sha256 hashes', async () => {
  const { root } = makeWebProject()
  try {
    await inDir(root, async () => {
      const result = await zipBundleInternal('', { path: 'dist', name: 'full.zip', deltaPack: 'delta.zip', key: true }, true)
      assert.equal(result.encryption_method, 'none')
      assert.equal(result.delta_file_hash_format, 'sha256_hex')
      assert.deepEqual(result.delta_encryption, { enabled: false })
      const manifest = JSON.parse(new AdmZip(readFileSync('delta.zip')).readAsText(DELTA_PACK_MANIFEST_FILE))
      const small = manifest.entries.find(entry => entry.file_name === 'small.txt')
      assert.equal(small.file_hash, sha256(readFileSync('dist/small.txt')))
      assert.equal(small.uploaded_bytes_sha256, small.file_hash)
    })
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await t('build zip writes the same archive as build request and derives build options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capgo-offline-build-'))
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'native-app', version: '2.0.0', dependencies: { '@capacitor/android': '7.0.0' } }))
    writeFile(join(root, 'capacitor.config.json'), JSON.stringify({ appId: 'com.example.native', appName: 'Native', webDir: 'dist' }))
    writeFile(join(root, 'android/app/build.gradle'), 'android { defaultConfig { versionName "1.0.0" } }\n')
    writeFile(join(root, 'android/capacitor.settings.gradle'), '')
    writeFile(join(root, 'node_modules/@capacitor/android/capacitor/build.gradle'), '// core\n')
    writeFile(join(root, 'node_modules/left-pad/index.js'), 'module.exports = 1\n')
    writeFile(join(root, 'src/main.ts'), 'console.log(1)\n')

    const output = join(root, 'out', 'native.zip')
    mkdirSync(dirname(output), { recursive: true })
    const result = await zipBuildInternal(undefined, { platform: 'android', path: root, output }, true)
    assert.equal(result.app_id, 'com.example.native')
    assert.equal(result.platform, 'android')
    assert.equal(result.filename, output)
    const data = readFileSync(output)
    assert.equal(result.size_bytes, data.byteLength)
    assert.equal(result.sha256, sha256(data))
    assert.equal(result.ios_dependency_manager, undefined)
    assert.deepEqual(result.build_options, {
      platform: 'android',
      androidSourceDir: 'android',
      androidAppDir: 'android',
      androidProjectDir: 'android',
    })

    // Same archive contents as the build request path.
    const reference = join(root, 'out', 'reference.zip')
    await zipDirectory(root, reference, 'android', { appId: 'com.example.native', appName: 'Native', webDir: 'dist' })
    const names = zip => new AdmZip(zip).getEntries().map(entry => entry.entryName).sort()
    assert.deepEqual(names(output), names(reference))
    assert.ok(names(output).includes('android/app/build.gradle'))
    assert.ok(!names(output).some(name => name.startsWith('src/') || name.includes('left-pad')))
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await t('offline packers made no network call', () => {
  assert.equal(fetchCalls, 0)
})

globalThis.fetch = realFetch
