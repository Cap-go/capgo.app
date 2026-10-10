#!/usr/bin/env node
/**
 * Test: Signed bundle metadata helpers
 *
 * Verifies the byte-exact payloads for `signature` (zip) and `manifest_signature`
 * (delta manifest), the UTF-8 byte-order sort of manifest entries, and that the
 * RSA signature round-trips through publicDecrypt back to sha256(payload).
 */

import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { constants, createHash, publicDecrypt } from 'node:crypto'
import {
  buildBundleSignaturePayload,
  buildManifestSignaturePayload,
  compareUtf8Bytes,
  createRSA,
  signBundleMetadata,
  signManifestMetadata,
  verifyBundleSignature,
  verifyManifestSignature,
} from '../src/api/crypto.ts'

let failures = 0

async function t(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  }
  catch (error) {
    failures += 1
    console.error(`❌ ${name}`)
    console.error(error)
  }
}

const { publicKey, privateKey } = createRSA()
const checksum = 'a'.repeat(32) + 'b'.repeat(32)
const versionName = '1.2.3-beta.4'

await t('bundle payload is byte exact', () => {
  const payload = buildBundleSignaturePayload(versionName, checksum)
  assert.equal(payload, `capgo-bundle-v1\nversion:${versionName}\nchecksum:${checksum}\n`)
  const bytes = Buffer.from(payload, 'utf8')
  assert.equal(bytes[bytes.length - 1], 0x0A)
  assert.ok(!payload.includes('\r'))
  // checksum is always lowercased
  assert.equal(buildBundleSignaturePayload(versionName, checksum.toUpperCase()), payload)
})

await t('manifest payload is byte exact and sorted by UTF-8 bytes', () => {
  const entries = [
    { file_name: 'index.html', hash: '1'.repeat(64) },
    { file_name: 'Zeta.js', hash: '2'.repeat(64) },
    { file_name: 'assets/é.png', hash: '3'.repeat(64) },
    { file_name: 'assets/z.png', hash: '4'.repeat(64) },
    { file_name: 'assets/main.js.br', hash: 'A'.repeat(64) },
  ]
  const payload = buildManifestSignaturePayload(versionName, entries)
  // Expected order: uppercase 'Z' (0x5A) < 'a' (0x61) < 'i' (0x69); within assets/: 'm' < 'z' < 'é' (0xC3 0xA9)
  const expected = `capgo-manifest-v1\nversion:${versionName}\n`
    + `Zeta.js:${'2'.repeat(64)}\n`
    + `assets/main.js.br:${'a'.repeat(64)}\n`
    + `assets/z.png:${'4'.repeat(64)}\n`
    + `assets/é.png:${'3'.repeat(64)}\n`
    + `index.html:${'1'.repeat(64)}\n`
  assert.equal(payload, expected)
  // Input order must not matter
  assert.equal(buildManifestSignaturePayload(versionName, [...entries].reverse()), expected)
  // Input array is not mutated
  assert.equal(entries[0].file_name, 'index.html')
  // Empty manifest still has the header + version
  assert.equal(buildManifestSignaturePayload(versionName, []), `capgo-manifest-v1\nversion:${versionName}\n`)
})

await t('compareUtf8Bytes matches Buffer.compare on UTF-8 bytes', () => {
  assert.equal(compareUtf8Bytes('Z', 'a'), -1)
  assert.equal(compareUtf8Bytes('z', 'é'), -1)
  assert.equal(compareUtf8Bytes('a', 'a'), 0)
  assert.equal(compareUtf8Bytes('b', 'a'), 1)
  // Locale-aware sort would put 'é' before 'z'; byte order must not
  assert.notEqual(compareUtf8Bytes('z', 'é'), 'z'.localeCompare('é'))
})

await t('bundle signature is 512 lowercase hex and recovers sha256(payload)', () => {
  const signature = signBundleMetadata(versionName, checksum, privateKey)
  assert.match(signature, /^[0-9a-f]{512}$/)
  const recovered = publicDecrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature, 'hex'))
  const digest = createHash('sha256').update(Buffer.from(buildBundleSignaturePayload(versionName, checksum), 'utf8')).digest()
  assert.equal(recovered.toString('hex'), digest.toString('hex'))
  assert.equal(verifyBundleSignature(versionName, checksum, signature, publicKey), true)
  // Deterministic (PKCS#1 v1.5 type 1 padding)
  assert.equal(signBundleMetadata(versionName, checksum, privateKey), signature)
})

await t('bundle signature fails for a different version or checksum', () => {
  const signature = signBundleMetadata(versionName, checksum, privateKey)
  assert.equal(verifyBundleSignature('1.2.4', checksum, signature, publicKey), false)
  assert.equal(verifyBundleSignature(versionName, 'c'.repeat(64), signature, publicKey), false)
  assert.equal(verifyBundleSignature(versionName, checksum, 'zz', publicKey), false)
  const otherKeys = createRSA()
  assert.equal(verifyBundleSignature(versionName, checksum, signature, otherKeys.publicKey), false)
})

await t('manifest signature round trips and binds the entry set', () => {
  const entries = [
    { file_name: 'index.html', hash: '1'.repeat(64) },
    { file_name: 'assets/é.png', hash: '3'.repeat(64) },
  ]
  const signature = signManifestMetadata(versionName, entries, privateKey)
  assert.match(signature, /^[0-9a-f]{512}$/)
  const recovered = publicDecrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature, 'hex'))
  const digest = createHash('sha256').update(Buffer.from(buildManifestSignaturePayload(versionName, entries), 'utf8')).digest()
  assert.equal(recovered.toString('hex'), digest.toString('hex'))
  assert.equal(verifyManifestSignature(versionName, entries, signature, publicKey), true)
  assert.equal(verifyManifestSignature(versionName, [...entries].reverse(), signature, publicKey), true)
  // dropped entry
  assert.equal(verifyManifestSignature(versionName, [entries[0]], signature, publicKey), false)
  // renamed entry
  assert.equal(verifyManifestSignature(versionName, [entries[0], { file_name: 'assets/e.png', hash: '3'.repeat(64) }], signature, publicKey), false)
  // added entry
  assert.equal(verifyManifestSignature(versionName, [...entries, { file_name: 'extra.js', hash: '5'.repeat(64) }], signature, publicKey), false)
  // other version
  assert.equal(verifyManifestSignature('9.9.9', entries, signature, publicKey), false)
})

if (failures > 0) {
  console.error(`\n${failures} bundle signature test(s) failed`)
  process.exit(1)
}
console.log('\nAll bundle signature tests passed')
