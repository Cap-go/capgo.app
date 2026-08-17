import type { Context } from 'hono'
import type { ImagePathScope } from './storage.ts'
import { cloudlog, cloudlogErr } from './logging.ts'
import { assertAllowedImagePath, getStorageAllowedOrigins, normalizeImagePath } from './storage.ts'
import { supabaseAdmin } from './supabase.ts'

const JPEG_SIGNATURE = [0xFF, 0xD8]
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

function mimeFromFileBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 2 && bytes[0] === JPEG_SIGNATURE[0] && bytes[1] === JPEG_SIGNATURE[1]) {
    return 'image/jpeg'
  }

  if (bytes.length >= PNG_SIGNATURE.length) {
    const isPng = PNG_SIGNATURE.every((signatureByte, index) => bytes[index] === signatureByte)
    if (isPng)
      return 'image/png'
  }

  return null
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]) >>> 0
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(totalLength)
  let position = 0
  for (const part of parts) {
    out.set(part, position)
    position += part.length
  }
  return out
}

function shouldStripJpegSegment(marker: number): boolean {
  // APP0 (JFIF) is kept, APP1..APP15 are removed (EXIF, ICC, etc.)
  if (marker === 0xE0)
    return false
  if (marker >= 0xE1 && marker <= 0xEF)
    return true

  // Strip comments too
  return marker === 0xFE
}

function isSameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i])
      return false
  }
  return true
}

function stripJpegMetadata(input: Uint8Array): Uint8Array | null {
  if (input.length < 2 || input[0] !== JPEG_SIGNATURE[0] || input[1] !== JPEG_SIGNATURE[1])
    return null

  const out: Uint8Array[] = [input.slice(0, 2)]
  let offset = 2

  while (offset < input.length) {
    if (input[offset] !== 0xFF)
      return null

    const marker = input[offset + 1]

    if (marker === 0xD9) {
      out.push(input.slice(offset, offset + 2))
      break
    }

    // Standalone markers (RST, SOI, EOI) have no payload length
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      out.push(input.slice(offset, offset + 2))
      offset += 2
      continue
    }

    if (offset + 4 > input.length)
      return null

    const segmentLength = (input[offset + 2] << 8) | input[offset + 3]
    if (segmentLength < 2)
      return null

    const segmentEnd = offset + 2 + segmentLength
    if (segmentEnd > input.length)
      return null

    // Start of scan: keep the marker and payload and stop parsing there
    if (marker === 0xDA) {
      out.push(input.slice(offset))
      break
    }

    if (!shouldStripJpegSegment(marker)) {
      out.push(input.slice(offset, segmentEnd))
    }

    offset = segmentEnd
  }

  return concatUint8Arrays(out)
}

function stripPngMetadata(input: Uint8Array): Uint8Array | null {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (input[i] !== PNG_SIGNATURE[i])
      return null
  }

  const out: Uint8Array[] = [input.slice(0, PNG_SIGNATURE.length)]
  let offset = PNG_SIGNATURE.length

  while (offset < input.length) {
    if (offset + 8 > input.length)
      return null

    const length = readUint32(input, offset)
    const type = new TextDecoder().decode(input.slice(offset + 4, offset + 8))
    const chunkStart = offset
    const chunkDataStart = offset + 8
    const chunkEnd = chunkDataStart + length + 4

    if (chunkEnd > input.length)
      return null

    const shouldKeep = !['eXIf', 'iTXt', 'tEXt', 'zTXt', 'iCCP'].includes(type)
    if (shouldKeep)
      out.push(input.slice(chunkStart, chunkEnd))

    offset = chunkEnd

    if (type === 'IEND')
      break
  }

  return concatUint8Arrays(out)
}

function stripMetadataBytes(input: Uint8Array): Uint8Array | null {
  return stripJpegMetadata(input) ?? stripPngMetadata(input)
}

function mimeFromFilePath(path: string): string | null {
  const normalized = path.toLowerCase()

  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg'))
    return 'image/jpeg'
  if (normalized.endsWith('.png'))
    return 'image/png'
  return null
}

export async function cleanStoredImageMetadata(
  c: Context,
  rawImagePath: string,
  scope: ImagePathScope,
): Promise<void> {
  const requestId = c.get('requestId')
  const normalizedPath = normalizeImagePath(rawImagePath, {
    allowedOrigins: getStorageAllowedOrigins(c),
  })

  if (!normalizedPath) {
    cloudlog({ requestId, message: 'Cannot normalize image path', rawImagePath })
    return
  }

  // Fail closed: never admin-download/upsert a path outside the row's ownership scope.
  if (!assertAllowedImagePath(normalizedPath, scope)) {
    cloudlog({
      requestId,
      message: 'Skipping metadata cleanup for image path outside ownership scope',
      rawImagePath,
      normalizedPath,
      scope,
    })
    return
  }

  const supabase = supabaseAdmin(c)
  const { data: fileBlob, error: downloadError } = await supabase.storage.from('images').download(normalizedPath)

  if (downloadError || !fileBlob) {
    if (downloadError)
      cloudlogErr({ requestId, message: 'Failed to download image for metadata cleanup', path: normalizedPath, error: downloadError })
    return
  }

  const original = new Uint8Array(await fileBlob.arrayBuffer())
  const sanitized = stripMetadataBytes(original)

  if (!sanitized) {
    cloudlog({ requestId, message: 'Unsupported image format for metadata cleanup', path: normalizedPath })
    return
  }

  if (isSameBytes(sanitized, original)) {
    cloudlog({ requestId, message: 'No metadata found to remove', path: normalizedPath })
    return
  }

  const contentType = fileBlob.type || mimeFromFileBytes(original) || mimeFromFilePath(normalizedPath) || undefined
  const { error: uploadError } = await supabase.storage.from('images').upload(normalizedPath, sanitized, {
    upsert: true,
    ...(contentType ? { contentType } : {}),
  })

  if (uploadError) {
    throw uploadError
  }

  cloudlog({ requestId, message: 'Stripped image metadata', path: normalizedPath })
}
