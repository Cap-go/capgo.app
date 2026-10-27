import type { SemVer } from '@std/semver'
import { Buffer } from 'node:buffer'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { lessThan, parse } from '@std/semver'

// Server-side mirror of the CLI bundle rules (cli/src/utils.ts, cli/src/bundle/check.ts,
// cli/src/bundle/partial.ts) plus a bounded ZIP reader that never needs the whole archive
// in memory: the central directory comes from a range read and entry data is consumed
// from one sequential stream.

export const BROTLI_MIN_UPDATER_VERSION_V5 = '5.10.0'
export const BROTLI_MIN_UPDATER_VERSION_V6 = '6.25.0'
export const BROTLI_MIN_UPDATER_VERSION_V7 = '7.0.30'
export const BROTLI_MIN_SIZE = 8192
// Lower than the CLI default (11) so server-side compression fits the Workers CPU budget.
// Any valid Brotli stream decodes on devices; file_hash covers the original bytes.
export const SERVER_BROTLI_QUALITY = 5
export const DELTA_PACK_MANIFEST_NAME = 'capgo-delta-manifest.json'
const CORDOVA_UPDATER_PACKAGES = new Set(['@capgo/cordova-updater', 'cordova-plugin-capgo'])
const LOCAL_UPDATER_VERSIONS = new Set(['link:@capgo/capacitor-updater', 'file:..', 'file:../'])
const DELTA_IGNORED_FILES = ['.DS_Store', '.git', '.gitignore', 'node_modules', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.spec.json']

export class BundleZipError extends Error {
  constructor(readonly code: string, message: string, readonly moreInfo: Record<string, unknown> = {}) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Updater version rules
// ---------------------------------------------------------------------------

function tryParseSemver(value: string | null | undefined): SemVer | undefined {
  if (!value)
    return undefined
  try {
    return parse(value)
  }
  catch {
    return undefined
  }
}

export function isDeprecatedPluginVersion(version: SemVer, minFive = '5.10.0', minSix = '6.25.0', minSeven = '7.25.0'): boolean {
  if (version.major === 5 && lessThan(version, parse(minFive)))
    return true
  if (version.major === 6 && lessThan(version, parse(minSix)))
    return true
  if (version.major === 7 && lessThan(version, parse(minSeven)))
    return true
  return false
}

/**
 * The CLI reads the installed version from node_modules: an exact semver, or a local link.
 * A range like ^7.40.0 would silently fall back to CRC32, so it is rejected instead.
 */
/** Cordova updaters always use SHA-256, whatever their version string. */
export function isCordovaUpdaterPackage(updaterPackage: string | null | undefined): boolean {
  return !!updaterPackage && CORDOVA_UPDATER_PACKAGES.has(updaterPackage)
}

export function isExactUpdaterVersion(updaterVersion: string): boolean {
  return !!tryParseSemver(updaterVersion) || LOCAL_UPDATER_VERSIONS.has(updaterVersion)
}

/** Checksum algorithm the CLI picks for an unencrypted bundle (prepareBundleFile). */
export function checksumAlgorithmForUpdater(updaterVersion: string, updaterPackage?: string | null): 'sha256' | 'crc32' {
  if (updaterPackage && CORDOVA_UPDATER_PACKAGES.has(updaterPackage))
    return 'sha256'
  const coerced = tryParseSemver(updaterVersion)
  if (coerced)
    return isDeprecatedPluginVersion(coerced, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7) ? 'crc32' : 'sha256'
  return LOCAL_UPDATER_VERSIONS.has(updaterVersion) ? 'sha256' : 'crc32'
}

/** Delta (manifest) uploads need Brotli-aware updaters (validatePartialUpload). */
export function updaterSupportsDelta(updaterVersion: string | null | undefined): boolean {
  const coerced = tryParseSemver(updaterVersion)
  if (!coerced)
    return false
  return !isDeprecatedPluginVersion(coerced, undefined, undefined, BROTLI_MIN_UPDATER_VERSION_V7)
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let j = 0; j < 8; j++)
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1)
    table[i] = value >>> 0
  }
  return table
})()

export class Crc32 {
  private crc = 0xFFFFFFFF

  update(bytes: Uint8Array) {
    let crc = this.crc
    for (let i = 0; i < bytes.length; i++)
      crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xFF]! ^ (crc >>> 8)
    this.crc = crc
  }

  digestHex(): string {
    return ((this.crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0')
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Bundle content rules
// ---------------------------------------------------------------------------

/** `capgo bundle upload` requires index.html at the root of the uploaded folder. */
export function hasRootIndexHtml(entries: readonly ZipEntry[]): boolean {
  return entries.some(entry => !entry.isDirectory && entry.name === 'index.html')
}

export function isJsEntry(entry: ZipEntry): boolean {
  return !entry.isDirectory && entry.name.endsWith('.js')
}

export function isIgnoredDeltaFile(name: string): boolean {
  return DELTA_IGNORED_FILES.some(ignored => name.includes(ignored))
}

/** Files the CLI puts in a delta manifest (generateManifest): skip directories, ignored and empty files. */
export function selectDeltaEntries(entries: readonly ZipEntry[]): ZipEntry[] {
  return entries.filter(entry => !entry.isDirectory && entry.uncompressedSize > 0 && !isIgnoredDeltaFile(entry.name))
}

export function compressDeltaFile(bytes: Uint8Array): { payload: Uint8Array, compression: 'none' | 'brotli' } {
  if (bytes.byteLength < BROTLI_MIN_SIZE)
    return { payload: bytes, compression: 'none' }
  try {
    const compressed = brotliCompressSync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: SERVER_BROTLI_QUALITY,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
      },
    })
    if (compressed.byteLength >= bytes.byteLength - 10)
      return { payload: bytes, compression: 'none' }
    return { payload: new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength), compression: 'brotli' }
  }
  catch {
    return { payload: bytes, compression: 'none' }
  }
}

// ---------------------------------------------------------------------------
// ZIP structure
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string
  method: number
  flags: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  isDirectory: boolean
}

export interface ZipDirectoryLocation {
  centralDirectoryOffset: number
  centralDirectorySize: number
  entryCount: number
}

const EOCD_SIGNATURE = 0x06054B50
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064B50
const ZIP64_EOCD_SIGNATURE = 0x06064B50
const CENTRAL_HEADER_SIGNATURE = 0x02014B50
const LOCAL_HEADER_SIGNATURE = 0x04034B50
const EOCD_MIN_SIZE = 22
/** EOCD + max comment + zip64 locator + zip64 record. */
export const ZIP_TAIL_READ_SIZE = EOCD_MIN_SIZE + 0xFFFF + 20 + 56
/** A bundle with thousands of files has a central directory of a few hundred KB. */
export const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024
/** Default cap for one inflated entry (Workers have 128 MB of memory). */
export const MAX_INFLATED_ENTRY_BYTES = 48 * 1024 * 1024
const CENTRAL_HEADER_MIN_SIZE = 46
const decoder = new TextDecoder('utf-8')

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readUint64(data: DataView, offset: number): number {
  const value = data.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new BundleZipError('invalid_zip', 'ZIP offsets exceed the supported range')
  return Number(value)
}

/** Locate the central directory from the archive tail (`tail` ends at `fileSize`). */
export function findCentralDirectory(tail: Uint8Array, fileSize: number): ZipDirectoryLocation {
  const data = view(tail)
  const tailStart = fileSize - tail.byteLength
  for (let i = tail.byteLength - EOCD_MIN_SIZE; i >= 0; i--) {
    if (data.getUint32(i, true) !== EOCD_SIGNATURE)
      continue
    const commentLength = data.getUint16(i + 20, true)
    if (i + EOCD_MIN_SIZE + commentLength !== tail.byteLength)
      continue
    let entryCount = data.getUint16(i + 10, true)
    let centralDirectorySize = data.getUint32(i + 12, true)
    let centralDirectoryOffset = data.getUint32(i + 16, true)
    if (entryCount === 0xFFFF || centralDirectorySize === 0xFFFFFFFF || centralDirectoryOffset === 0xFFFFFFFF) {
      const locator = i - 20
      if (locator < 0 || data.getUint32(locator, true) !== ZIP64_EOCD_LOCATOR_SIGNATURE)
        throw new BundleZipError('invalid_zip', 'ZIP64 end of central directory locator is missing')
      const recordOffset = readUint64(data, locator + 8) - tailStart
      if (recordOffset < 0 || recordOffset + 56 > tail.byteLength || data.getUint32(recordOffset, true) !== ZIP64_EOCD_SIGNATURE)
        throw new BundleZipError('invalid_zip', 'ZIP64 end of central directory record is unreadable')
      entryCount = readUint64(data, recordOffset + 32)
      centralDirectorySize = readUint64(data, recordOffset + 40)
      centralDirectoryOffset = readUint64(data, recordOffset + 48)
    }
    if (centralDirectoryOffset + centralDirectorySize > fileSize)
      throw new BundleZipError('invalid_zip', 'ZIP central directory is out of bounds')
    if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES)
      throw new BundleZipError('zip_directory_too_large', `ZIP central directory is larger than ${MAX_CENTRAL_DIRECTORY_BYTES / 1024 / 1024} MB`, { size: centralDirectorySize })
    if (entryCount * CENTRAL_HEADER_MIN_SIZE > centralDirectorySize)
      throw new BundleZipError('invalid_zip', 'ZIP central directory entry count does not fit its size')
    return { centralDirectoryOffset, centralDirectorySize, entryCount }
  }
  throw new BundleZipError('invalid_zip', 'The uploaded file is not a ZIP archive (end of central directory not found)')
}

export function parseCentralDirectory(directory: Uint8Array, expectedEntries: number): ZipEntry[] {
  const data = view(directory)
  const entries: ZipEntry[] = []
  let offset = 0
  while (offset + 46 <= directory.byteLength && entries.length < expectedEntries) {
    if (data.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE)
      throw new BundleZipError('invalid_zip', 'ZIP central directory is corrupted')
    const flags = data.getUint16(offset + 8, true)
    const method = data.getUint16(offset + 10, true)
    const crc32 = data.getUint32(offset + 16, true)
    let compressedSize = data.getUint32(offset + 20, true)
    let uncompressedSize = data.getUint32(offset + 24, true)
    const nameLength = data.getUint16(offset + 28, true)
    const extraLength = data.getUint16(offset + 30, true)
    const commentLength = data.getUint16(offset + 32, true)
    let localHeaderOffset = data.getUint32(offset + 42, true)
    const nameStart = offset + 46
    if (nameStart + nameLength + extraLength + commentLength > directory.byteLength)
      throw new BundleZipError('invalid_zip', 'ZIP central directory is truncated')
    const name = decoder.decode(directory.subarray(nameStart, nameStart + nameLength)).replaceAll('\\', '/')
    let extra = nameStart + nameLength
    const extraEnd = extra + extraLength
    while (extra + 4 <= extraEnd) {
      const headerId = data.getUint16(extra, true)
      const size = data.getUint16(extra + 2, true)
      if (headerId === 0x0001) {
        let cursor = extra + 4
        if (uncompressedSize === 0xFFFFFFFF) {
          uncompressedSize = readUint64(data, cursor)
          cursor += 8
        }
        if (compressedSize === 0xFFFFFFFF) {
          compressedSize = readUint64(data, cursor)
          cursor += 8
        }
        if (localHeaderOffset === 0xFFFFFFFF)
          localHeaderOffset = readUint64(data, cursor)
      }
      extra += 4 + size
    }
    entries.push({
      name,
      method,
      flags,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith('/'),
    })
    offset = extraEnd + commentLength
  }
  if (entries.length !== expectedEntries)
    throw new BundleZipError('invalid_zip', 'ZIP central directory entry count mismatch')
  return entries
}

/**
 * Largest plausible compressed size for an entry. Stored entries are exact; deflate expands
 * incompressible data by at most ~1/8 (fixed Huffman), plus block headers.
 */
export function maxCompressedSize(entry: Pick<ZipEntry, 'method' | 'uncompressedSize'>): number {
  if (entry.method === 0)
    return entry.uncompressedSize
  return entry.uncompressedSize + Math.ceil(entry.uncompressedSize / 8) + 1024
}

/** Reject entries we cannot or will not read before buffering any of their bytes. */
export function assertReadableEntry(entry: ZipEntry, maxBytes = MAX_INFLATED_ENTRY_BYTES) {
  if (entry.flags & 0x1)
    throw new BundleZipError('zip_entry_encrypted', `ZIP entry ${entry.name} is password protected`)
  if (entry.method !== 0 && entry.method !== 8)
    throw new BundleZipError('zip_method_unsupported', `ZIP entry ${entry.name} uses unsupported compression method ${entry.method}`)
  if (entry.uncompressedSize > maxBytes)
    throw new BundleZipError('zip_entry_too_large', `ZIP entry ${entry.name} is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB`, { name: entry.name, max_bytes: maxBytes })
  if (entry.compressedSize > maxCompressedSize(entry))
    throw new BundleZipError('invalid_zip', `ZIP entry ${entry.name} declares an implausible compressed size`, { name: entry.name })
}

/** Inflate one entry. Output never exceeds the declared size, itself capped by `maxBytes`. */
export async function inflateEntry(entry: ZipEntry, compressed: Uint8Array, maxBytes = MAX_INFLATED_ENTRY_BYTES): Promise<Uint8Array> {
  assertReadableEntry(entry, maxBytes)
  if (compressed.byteLength !== entry.compressedSize)
    throw new BundleZipError('invalid_zip', `ZIP entry ${entry.name} is truncated`)
  if (entry.method === 0) {
    if (compressed.byteLength !== entry.uncompressedSize)
      throw new BundleZipError('invalid_zip', `ZIP entry ${entry.name} has an invalid size`)
    return compressed
  }
  const stream = new Blob([compressed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  // Collect chunks instead of trusting the declared size for an up-front allocation.
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      if (length + value.byteLength > entry.uncompressedSize)
        throw new BundleZipError('invalid_zip', `ZIP entry ${entry.name} inflates past its declared size`)
      chunks.push(value)
      length += value.byteLength
    }
  }
  catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof BundleZipError)
      throw error
    throw new BundleZipError('invalid_zip', `ZIP entry ${entry.name} cannot be decompressed`)
  }
  if (length !== entry.uncompressedSize)
    throw new BundleZipError('invalid_zip', `ZIP entry ${entry.name} has an invalid size`)
  if (chunks.length === 1)
    return chunks[0]!
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

/**
 * Pull exact byte counts from a stream; every byte read or skipped is passed to `onBytes`
 * (whole-archive checksum) so one pass covers hashing and entry extraction.
 */
class SequentialReader {
  private chunks: Uint8Array[] = []
  private buffered = 0
  position = 0
  private done = false

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>, private onBytes: (bytes: Uint8Array) => void) {}

  private async fill(minimum: number) {
    while (this.buffered < minimum && !this.done) {
      const { done, value } = await this.reader.read()
      if (done) {
        this.done = true
        break
      }
      if (value.byteLength) {
        this.onBytes(value)
        this.chunks.push(value)
        this.buffered += value.byteLength
      }
    }
  }

  async read(length: number): Promise<Uint8Array> {
    await this.fill(length)
    if (this.buffered < length)
      throw new BundleZipError('invalid_zip', 'Unexpected end of ZIP data')
    const output = new Uint8Array(length)
    let written = 0
    while (written < length) {
      const chunk = this.chunks[0]!
      const take = Math.min(chunk.byteLength, length - written)
      output.set(chunk.subarray(0, take), written)
      written += take
      if (take === chunk.byteLength)
        this.chunks.shift()
      else
        this.chunks[0] = chunk.subarray(take)
    }
    this.buffered -= length
    this.position += length
    return output
  }

  async skip(length: number) {
    let remaining = length
    while (remaining > 0) {
      await this.fill(1)
      if (!this.buffered)
        throw new BundleZipError('invalid_zip', 'Unexpected end of ZIP data')
      const chunk = this.chunks[0]!
      const take = Math.min(chunk.byteLength, remaining)
      if (take === chunk.byteLength)
        this.chunks.shift()
      else
        this.chunks[0] = chunk.subarray(take)
      this.buffered -= take
      this.position += take
      remaining -= take
    }
  }

  async drain() {
    this.chunks = []
    this.buffered = 0
    while (!this.done) {
      const { done, value } = await this.reader.read()
      if (done)
        this.done = true
      else
        this.onBytes(value)
    }
  }
}

/**
 * Walk a ZIP archive stream once. `onEntry` receives the compressed bytes of every entry
 * accepted by `want` (in file order); every byte of the archive goes through `onBytes`.
 * Wanted entries are size-checked (`maxEntryBytes`) before any of their bytes are buffered.
 */
export async function walkZipStream(
  stream: ReadableStream<Uint8Array>,
  entries: readonly ZipEntry[],
  want: (entry: ZipEntry) => boolean,
  onEntry: (entry: ZipEntry, compressed: Uint8Array) => Promise<void> | void,
  onBytes: (bytes: Uint8Array) => void,
  maxEntryBytes = MAX_INFLATED_ENTRY_BYTES,
): Promise<void> {
  const reader = stream.getReader()
  const sequential = new SequentialReader(reader, onBytes)
  try {
    const ordered = entries.filter(want).sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
    for (const entry of ordered)
      assertReadableEntry(entry, maxEntryBytes)
    for (const entry of ordered) {
      if (entry.localHeaderOffset < sequential.position)
        throw new BundleZipError('invalid_zip', 'ZIP entries overlap')
      await sequential.skip(entry.localHeaderOffset - sequential.position)
      const header = await sequential.read(30)
      const headerView = view(header)
      if (headerView.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE)
        throw new BundleZipError('invalid_zip', `ZIP local header for ${entry.name} is corrupted`)
      await sequential.skip(headerView.getUint16(26, true) + headerView.getUint16(28, true))
      await onEntry(entry, await sequential.read(entry.compressedSize))
    }
    await sequential.drain()
  }
  finally {
    reader.releaseLock()
  }
}

/** Read every entry of an in-memory ZIP (bounded delta packs only). */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const tail = bytes.subarray(Math.max(0, bytes.byteLength - ZIP_TAIL_READ_SIZE))
  const location = findCentralDirectory(tail, bytes.byteLength)
  return parseCentralDirectory(bytes.subarray(location.centralDirectoryOffset, location.centralDirectoryOffset + location.centralDirectorySize), location.entryCount)
}

export function entryDataFromBuffer(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (bytes.byteLength < entry.localHeaderOffset + 30)
    throw new BundleZipError('invalid_zip', `ZIP local header for ${entry.name} is corrupted`)
  const headerView = view(bytes.subarray(entry.localHeaderOffset, entry.localHeaderOffset + 30))
  if (headerView.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE)
    throw new BundleZipError('invalid_zip', `ZIP local header for ${entry.name} is corrupted`)
  const start = entry.localHeaderOffset + 30 + headerView.getUint16(26, true) + headerView.getUint16(28, true)
  if (start + entry.compressedSize > bytes.byteLength)
    throw new BundleZipError('invalid_zip', `ZIP entry ${entry.name} is truncated`)
  return bytes.subarray(start, start + entry.compressedSize)
}

export function containsAscii(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(needle)
}

// ---------------------------------------------------------------------------
// Delta pack (`capgo-delta-manifest.json` produced by the CLI packer)
// ---------------------------------------------------------------------------

export interface DeltaPackEntry {
  id: number
  file_name: string
  file_hash: string
  compression: 'none' | 'brotli'
  uploaded_bytes_sha256: string
  uploaded_bytes_size: number
  pack_path: string
}

export interface DeltaPackManifest {
  protocol_version: 1
  file_hash_format: 'sha256_hex' | 'rsa_v2_base64' | 'rsa_v3_hex'
  delta_encryption: { enabled: boolean }
  entries: DeltaPackEntry[]
}

function packError(field: string): never {
  throw new BundleZipError('delta_pack_invalid', `Delta pack manifest is invalid (${field})`, { field })
}

export function parseDeltaPackManifest(input: unknown): DeltaPackManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    packError('body')
  const raw = input as Record<string, unknown>
  if (raw.protocol_version !== 1)
    packError('protocol_version')
  if (!['sha256_hex', 'rsa_v2_base64', 'rsa_v3_hex'].includes(raw.file_hash_format as string))
    packError('file_hash_format')
  const encryption = raw.delta_encryption as Record<string, unknown> | undefined
  if (!encryption || typeof encryption.enabled !== 'boolean')
    packError('delta_encryption')
  if (!Array.isArray(raw.entries) || raw.entries.length === 0)
    packError('entries')
  const packPaths = new Set<string>()
  const ids = new Set<number>()
  const entries = raw.entries.map((rawEntry: unknown, index: number): DeltaPackEntry => {
    const entry = rawEntry as Record<string, unknown> | null
    if (!entry || typeof entry !== 'object')
      packError(`entries[${index}]`)
    if (typeof entry.id !== 'number' || !Number.isSafeInteger(entry.id) || entry.id < 0 || ids.has(entry.id))
      packError(`entries[${index}].id`)
    ids.add(entry.id)
    const compression = entry.compression === 'brotli' ? 'brotli' : entry.compression === 'none' ? 'none' : packError(`entries[${index}].compression`)
    for (const field of ['file_name', 'file_hash', 'uploaded_bytes_sha256', 'pack_path'] as const) {
      if (typeof entry[field] !== 'string' || !entry[field])
        packError(`entries[${index}].${field}`)
    }
    if (typeof entry.uploaded_bytes_size !== 'number' || !Number.isSafeInteger(entry.uploaded_bytes_size) || entry.uploaded_bytes_size < 0)
      packError(`entries[${index}].uploaded_bytes_size`)
    const packPath = entry.pack_path as string
    if (!/^files\/[\w.-]+$/.test(packPath) || packPaths.has(packPath))
      packError(`entries[${index}].pack_path`)
    packPaths.add(packPath)
    return {
      id: entry.id as number,
      file_name: entry.file_name as string,
      file_hash: entry.file_hash as string,
      compression,
      uploaded_bytes_sha256: entry.uploaded_bytes_sha256 as string,
      uploaded_bytes_size: entry.uploaded_bytes_size as number,
      pack_path: packPath,
    }
  })
  return {
    protocol_version: 1,
    file_hash_format: raw.file_hash_format as DeltaPackManifest['file_hash_format'],
    delta_encryption: { enabled: encryption.enabled as boolean },
    entries,
  }
}

export interface DeltaPackFile {
  file_name: string
  file_hash: string
  compression: 'none' | 'brotli'
  payload: Uint8Array
  sha256: string
}

export interface DeltaPackLimits {
  /** True when the bundle has a session_key (encrypted delta packs need one). */
  hasSessionKey: boolean
  maxEntries: number
  /** Running budget for every inflated blob of the pack together. */
  maxPayloadBytes: number
  maxManifestBytes?: number
  /** Appended to "too large" messages. */
  hint?: string
}

export const MAX_DELTA_PACK_MANIFEST_BYTES = 8 * 1024 * 1024

/** Read and verify an in-memory CLI delta pack within fixed memory budgets. */
export async function extractDeltaPack(bytes: Uint8Array, limits: DeltaPackLimits): Promise<{ manifest: DeltaPackManifest, files: DeltaPackFile[] }> {
  const hint = limits.hint ? ` ${limits.hint}` : ''
  const entries = readZipDirectory(bytes)
  const byName = new Map(entries.map(entry => [entry.name, entry]))
  const manifestEntry = byName.get(DELTA_PACK_MANIFEST_NAME)
  if (!manifestEntry)
    throw new BundleZipError('delta_pack_invalid', `The delta pack has no ${DELTA_PACK_MANIFEST_NAME}`)
  let manifestJson: unknown
  try {
    const manifestBytes = await inflateEntry(manifestEntry, entryDataFromBuffer(bytes, manifestEntry), limits.maxManifestBytes ?? MAX_DELTA_PACK_MANIFEST_BYTES)
    manifestJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))
  }
  catch (error) {
    if (error instanceof BundleZipError)
      throw error.code === 'zip_entry_too_large' ? new BundleZipError('delta_pack_invalid', `${DELTA_PACK_MANIFEST_NAME} is too large`) : error
    throw new BundleZipError('delta_pack_invalid', `${DELTA_PACK_MANIFEST_NAME} is not valid JSON`)
  }
  const manifest = parseDeltaPackManifest(manifestJson)
  if (manifest.delta_encryption.enabled && !limits.hasSessionKey)
    throw new BundleZipError('delta_pack_invalid', 'The delta pack is encrypted but the bundle has no session_key')
  if (manifest.entries.length > limits.maxEntries)
    throw new BundleZipError('delta_too_large_for_server', `The delta pack has ${manifest.entries.length} files, above the server limit of ${limits.maxEntries}.${hint}`)
  const withSpaces = manifest.entries.filter(entry => entry.file_name.includes(' '))
  if (withSpaces.length)
    throw new BundleZipError('delta_file_name_invalid', `Files with spaces in their names (${withSpaces.slice(0, 20).map(entry => entry.file_name).join(', ')}). Please rename the files.`)
  const declaredBytes = manifest.entries.reduce((sum, entry) => sum + entry.uploaded_bytes_size, 0)
  if (declaredBytes > limits.maxPayloadBytes)
    throw new BundleZipError('delta_too_large_for_server', `The delta pack holds ${Math.ceil(declaredBytes / 1024 / 1024)} MB of files, above the server limit of ${Math.floor(limits.maxPayloadBytes / 1024 / 1024)} MB.${hint}`, { bytes: declaredBytes })

  const files: DeltaPackFile[] = []
  let inflatedBytes = 0
  for (const [index, entry] of manifest.entries.entries()) {
    const blob = byName.get(entry.pack_path)
    if (!blob)
      throw new BundleZipError('delta_pack_invalid', `Delta pack entry ${index} points to a missing blob ${entry.pack_path}`, { index })
    // Check the declared size before inflating so a lying header cannot blow the budget.
    if (blob.uncompressedSize !== entry.uploaded_bytes_size)
      throw new BundleZipError('delta_pack_invalid', `Delta pack blob ${entry.pack_path} does not match its manifest entry`, { index })
    if (inflatedBytes + blob.uncompressedSize > limits.maxPayloadBytes)
      throw new BundleZipError('delta_too_large_for_server', `The delta pack is larger than the server limit of ${Math.floor(limits.maxPayloadBytes / 1024 / 1024)} MB.${hint}`)
    const payload = await inflateEntry(blob, entryDataFromBuffer(bytes, blob), entry.uploaded_bytes_size)
    inflatedBytes += payload.byteLength
    const digest = await sha256Hex(payload)
    if (payload.byteLength !== entry.uploaded_bytes_size || digest !== entry.uploaded_bytes_sha256)
      throw new BundleZipError('delta_pack_invalid', `Delta pack blob ${entry.pack_path} does not match its manifest entry`, { index })
    files.push({ file_name: entry.file_name, file_hash: entry.file_hash, compression: entry.compression, payload, sha256: digest })
  }
  return { manifest, files }
}
