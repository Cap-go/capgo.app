import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { brotliDecompressSync } from 'node:zlib'
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import { BundleUploadTokenError, signBundleUploadToken, verifyBundleUploadToken } from '../supabase/functions/_backend/utils/bundle_upload_token.ts'
import {
  BROTLI_MIN_SIZE,
  BundleZipError,
  checksumAlgorithmForUpdater,
  compressDeltaFile,
  containsAscii,
  Crc32,
  entryDataFromBuffer,
  findCentralDirectory,
  hasRootIndexHtml,
  inflateEntry,
  isJsEntry,
  parseCentralDirectory,
  parseDeltaPackManifest,
  readZipDirectory,
  selectDeltaEntries,
  updaterSupportsDelta,
  walkZipStream,
  ZIP_TAIL_READ_SIZE,
} from '../supabase/functions/_backend/utils/bundle_zip.ts'

const SECRET = 'unit-test-secret'

function buildZip(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files))
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content))
  return zip.toBuffer()
}

function chunkedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize))
      offset += chunkSize
    },
  })
}

function directoryOf(zip: Buffer) {
  const tail = zip.subarray(Math.max(0, zip.byteLength - ZIP_TAIL_READ_SIZE))
  const location = findCentralDirectory(tail, zip.byteLength)
  return parseCentralDirectory(zip.subarray(location.centralDirectoryOffset, location.centralDirectoryOffset + location.centralDirectorySize), location.entryCount)
}

describe('bundle upload token', () => {
  it('round-trips signed claims', async () => {
    const { token, expiresAt } = await signBundleUploadToken(SECRET, { version_id: 42, app_id: 'com.test.app' }, 1_000)
    expect(expiresAt).toBe(1_000 + 3600)
    const claims = await verifyBundleUploadToken<{ version_id: number, app_id: string }>(SECRET, token, 1_500)
    expect(claims.version_id).toBe(42)
    expect(claims.app_id).toBe('com.test.app')
  })

  it('rejects tampered payloads, wrong secrets and expired tokens', async () => {
    const { token } = await signBundleUploadToken(SECRET, { version_id: 42 }, 1_000)
    const [prefix, body, signature] = token.split('.')
    const forgedBody = Buffer.from(JSON.stringify({ version_id: 43, iat: 1_000, exp: 4_600 })).toString('base64url')
    await expect(verifyBundleUploadToken(SECRET, `${prefix}.${forgedBody}.${signature}`, 1_500)).rejects.toMatchObject({ reason: 'signature' })
    await expect(verifyBundleUploadToken('other-secret', token, 1_500)).rejects.toMatchObject({ reason: 'signature' })
    await expect(verifyBundleUploadToken(SECRET, token, 4_600)).rejects.toMatchObject({ reason: 'expired' })
    await expect(verifyBundleUploadToken(SECRET, `${prefix}.${body}`, 1_500)).rejects.toBeInstanceOf(BundleUploadTokenError)
    await expect(verifyBundleUploadToken(SECRET, 12, 1_500)).rejects.toMatchObject({ reason: 'malformed' })
  })

  it('accepts expired tokens when expiry is ignored (abort path)', async () => {
    const { token } = await signBundleUploadToken(SECRET, { version_id: 7 }, 1_000)
    await expect(verifyBundleUploadToken(SECRET, token, 0)).resolves.toMatchObject({ version_id: 7 })
  })
})

describe('updater version rules (CLI parity)', () => {
  it('picks the checksum algorithm like prepareBundleFile', () => {
    expect(checksumAlgorithmForUpdater('7.0.30')).toBe('sha256')
    expect(checksumAlgorithmForUpdater('7.0.29')).toBe('crc32')
    expect(checksumAlgorithmForUpdater('6.25.0')).toBe('sha256')
    expect(checksumAlgorithmForUpdater('6.24.9')).toBe('crc32')
    expect(checksumAlgorithmForUpdater('5.10.0')).toBe('sha256')
    expect(checksumAlgorithmForUpdater('5.9.0')).toBe('crc32')
    expect(checksumAlgorithmForUpdater('8.0.0')).toBe('sha256')
    expect(checksumAlgorithmForUpdater('link:@capgo/capacitor-updater')).toBe('sha256')
    expect(checksumAlgorithmForUpdater('^7.1.0')).toBe('crc32')
    expect(checksumAlgorithmForUpdater('1.0.0', '@capgo/cordova-updater')).toBe('sha256')
  })

  it('gates delta uploads on Brotli-capable updaters', () => {
    expect(updaterSupportsDelta('7.0.30')).toBe(true)
    expect(updaterSupportsDelta('7.0.29')).toBe(false)
    expect(updaterSupportsDelta('6.25.0')).toBe(true)
    expect(updaterSupportsDelta('5.9.9')).toBe(false)
    expect(updaterSupportsDelta(undefined)).toBe(false)
    expect(updaterSupportsDelta('not-a-version')).toBe(false)
  })
})

describe('checksums', () => {
  it('computes the CLI crc32 incrementally', () => {
    const crc = new Crc32()
    crc.update(Buffer.from('1234'))
    crc.update(Buffer.from('56789'))
    expect(crc.digestHex()).toBe('cbf43926')
  })
})

describe('zip inspection', () => {
  it('reads an AdmZip archive (the CLI zipper) and finds index.html and notifyAppReady', async () => {
    const js = `console.log("x");${'a'.repeat(20_000)};CapacitorUpdater.notifyAppReady()`
    const zip = buildZip({ 'index.html': '<html></html>', 'assets/app.js': js, 'assets/empty.txt': '' })
    const entries = directoryOf(zip)
    expect(entries.map(entry => entry.name).sort()).toEqual(['assets/app.js', 'assets/empty.txt', 'index.html'])
    expect(hasRootIndexHtml(entries)).toBe(true)

    const hash = createHash('sha256')
    let found = false
    await walkZipStream(chunkedStream(zip, 97), entries, isJsEntry, async (entry, compressed) => {
      found = containsAscii(await inflateEntry(entry, compressed), 'notifyAppReady')
    }, bytes => hash.update(bytes))
    expect(found).toBe(true)
    expect(hash.digest('hex')).toBe(createHash('sha256').update(zip).digest('hex'))
  })

  it('requires index.html at the zip root, like checkIndexPosition', () => {
    const zip = buildZip({ 'dist/index.html': '<html></html>' })
    expect(hasRootIndexHtml(directoryOf(zip))).toBe(false)
  })

  it('rejects non-zip data', () => {
    expect(() => findCentralDirectory(new Uint8Array(100), 100)).toThrow(BundleZipError)
  })

  it('selects delta files like generateManifest (no empty, ignored or directory entries)', () => {
    const zip = new AdmZip()
    zip.addFile('index.html', Buffer.from('<html></html>'))
    zip.addFile('empty.js', Buffer.alloc(0))
    zip.addFile('.DS_Store', Buffer.from('x'))
    zip.addFile('node_modules/x.js', Buffer.from('x'))
    zip.addFile('folder/', Buffer.alloc(0))
    const names = selectDeltaEntries(directoryOf(zip.toBuffer())).map(entry => entry.name)
    expect(names).toEqual(['index.html'])
  })
})

describe('delta file compression', () => {
  it('keeps small or incompressible files uncompressed', () => {
    const small = Buffer.from('a'.repeat(BROTLI_MIN_SIZE - 1))
    expect(compressDeltaFile(small).compression).toBe('none')
    const random = createHash('sha512').update('seed').digest()
    const noisy = Buffer.concat(Array.from({ length: 200 }, (_, i) => createHash('sha512').update(random).update(String(i)).digest()))
    expect(compressDeltaFile(noisy).compression).toBe('none')
  })

  it('uses Brotli for compressible files at or above the RFC minimum', () => {
    const content = Buffer.from('const value = 1;\n'.repeat(1000))
    const result = compressDeltaFile(content)
    expect(result.compression).toBe('brotli')
    expect(Buffer.from(brotliDecompressSync(result.payload)).equals(content)).toBe(true)
  })
})

describe('delta pack', () => {
  const blob = Buffer.from('console.log(1)')
  const blobSha = createHash('sha256').update(blob).digest('hex')

  function packManifest(overrides: Record<string, unknown> = {}) {
    return {
      protocol_version: 1,
      file_hash_format: 'sha256_hex',
      delta_encryption: { enabled: false },
      entries: [{ id: 0, file_name: 'app.js', file_hash: blobSha, compression: 'none', uploaded_bytes_sha256: blobSha, uploaded_bytes_size: blob.byteLength, pack_path: 'files/0' }],
      ...overrides,
    }
  }

  it('parses the CLI packer manifest and reads its blobs', async () => {
    const zip = buildZip({ 'capgo-delta-manifest.json': JSON.stringify(packManifest()), 'files/0': blob })
    const entries = readZipDirectory(zip)
    const manifestEntry = entries.find(entry => entry.name === 'capgo-delta-manifest.json')!
    const parsed = parseDeltaPackManifest(JSON.parse(Buffer.from(await inflateEntry(manifestEntry, entryDataFromBuffer(zip, manifestEntry))).toString()))
    expect(parsed.entries[0]).toMatchObject({ id: 0, file_name: 'app.js', compression: 'none', pack_path: 'files/0' })
    const blobEntry = entries.find(entry => entry.name === 'files/0')!
    expect(Buffer.from(await inflateEntry(blobEntry, entryDataFromBuffer(zip, blobEntry))).equals(blob)).toBe(true)
  })

  it('accepts brotli entries and rejects invalid manifests', () => {
    const brotli = packManifest({ entries: [{ ...packManifest().entries[0], file_name: 'app.js.br', compression: 'brotli' }] })
    expect(parseDeltaPackManifest(brotli).entries[0]!.compression).toBe('brotli')
    expect(() => parseDeltaPackManifest(packManifest({ entries: [{ ...packManifest().entries[0], compression: 'br' }] }))).toThrow(BundleZipError)
    expect(() => parseDeltaPackManifest(packManifest({ entries: [{ ...packManifest().entries[0], id: undefined }] }))).toThrow(BundleZipError)
    expect(() => parseDeltaPackManifest(packManifest({ protocol_version: 2 }))).toThrow(BundleZipError)
    expect(() => parseDeltaPackManifest(packManifest({ entries: [] }))).toThrow(BundleZipError)
    expect(() => parseDeltaPackManifest(packManifest({ entries: [{ ...packManifest().entries[0], pack_path: '../escape' }] }))).toThrow(BundleZipError)
    const duplicate = packManifest().entries[0]
    expect(() => parseDeltaPackManifest(packManifest({ entries: [duplicate, { ...duplicate, id: 1, file_name: 'b.js' }] }))).toThrow(BundleZipError)
    expect(() => parseDeltaPackManifest(packManifest({ entries: [duplicate, { ...duplicate, file_name: 'b.js', pack_path: 'files/1' }] }))).toThrow(BundleZipError)
  })
})
