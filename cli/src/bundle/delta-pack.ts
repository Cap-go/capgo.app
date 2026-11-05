import type { ManifestUploadFileHashFormat, ManifestUploadRequestEntry } from './manifest-upload'
import type { PartialEncryptionOptions } from './partial'
import type { OptionsUpload } from './upload_interface'
import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import AdmZip from 'adm-zip'
import { MANIFEST_UPLOAD_PROTOCOL_VERSION, manifestUploadFileHashFormat } from './manifest-upload'
import { generateDeltaManifest, prepareManifestUploadEntries } from './partial'
import { resolveDeltaEncryptionSettings } from './upload-artifact'

/**
 * Offline "delta pack": the exact per-file bytes the online delta upload
 * (`bundle upload --delta`) would send, plus the manifest request entries it
 * would post, so an agent can upload them through signed URLs.
 *
 * Layout (ZIP, STORE / no compression):
 * - `capgo-delta-manifest.json` (see DeltaPackManifest)
 * - `files/<id>`: uploaded bytes for entry `id` (brotli and/or encrypted exactly as uploaded)
 */
export const DELTA_PACK_MANIFEST_FILE = 'capgo-delta-manifest.json'

export interface DeltaPackEntry extends ManifestUploadRequestEntry {
  /** Path of the uploaded bytes inside the pack. */
  pack_path: string
}

export interface DeltaPackManifest {
  protocol_version: typeof MANIFEST_UPLOAD_PROTOCOL_VERSION
  file_hash_format: ManifestUploadFileHashFormat
  delta_encryption: { enabled: boolean }
  /** `compression` is 'none' | 'brotli' (backend manifest upload protocol values; brotli entries end in `.br`). */
  entries: DeltaPackEntry[]
}

export interface DeltaPackResult {
  filename: string
  manifest: DeltaPackManifest
}

export interface DeltaPackBundleInput {
  encryptionMethod: 'none' | 'v2' | 'v1'
  finalKeyData: string
  sessionKey?: Buffer
  ivSessionKey?: string
}

/**
 * Build the delta pack with the same steps as the online delta upload:
 * delta encryption settings, manifest generation, then entry preparation
 * (skip rules, brotli rules, encryption, validation, MAX_MANIFEST_ENTRIES).
 * `options` must be the upload-shaped options (with `delta: true`); it is
 * mutated the same way `bundle upload` mutates it (encryptDelta folding).
 */
export async function writeDeltaPack(
  filename: string,
  path: string,
  bundle: DeltaPackBundleInput,
  options: OptionsUpload,
): Promise<DeltaPackResult> {
  const { supportsHexChecksum } = await resolveDeltaEncryptionSettings(options, bundle.encryptionMethod)
  const manifest = await generateDeltaManifest(path, options.encryptDelta ? bundle.encryptionMethod : 'none', bundle.finalKeyData, supportsHexChecksum)

  // Same condition as upload.ts: session key present + delta encryption on.
  const encryptionData: PartialEncryptionOptions | undefined = bundle.ivSessionKey && options.encryptDelta && bundle.sessionKey
    ? { sessionKey: bundle.sessionKey, ivSessionKey: bundle.ivSessionKey }
    : undefined

  const zip = new AdmZip()
  const entries: DeltaPackEntry[] = []
  await prepareManifestUploadEntries(manifest, path, encryptionData, options, (entry, uploadedBytes) => {
    const packPath = `files/${entry.id}`
    addStoredFile(zip, packPath, uploadedBytes)
    entries.push({ ...entry, pack_path: packPath })
  })

  const packManifest: DeltaPackManifest = {
    protocol_version: MANIFEST_UPLOAD_PROTOCOL_VERSION,
    file_hash_format: manifestUploadFileHashFormat(!!encryptionData, supportsHexChecksum),
    delta_encryption: { enabled: !!encryptionData },
    entries,
  }
  addStoredFile(zip, DELTA_PACK_MANIFEST_FILE, Buffer.from(`${JSON.stringify(packManifest, null, 2)}\n`, 'utf-8'))
  writeFileSync(filename, zip.toBuffer())

  return { filename, manifest: packManifest }
}

function addStoredFile(zip: AdmZip, entryName: string, data: Buffer) {
  zip.addFile(entryName, data)
  const entry = zip.getEntry(entryName)
  // STORE: the bytes are already brotli/encrypted exactly as they will be uploaded.
  if (entry)
    entry.header.method = 0
}
