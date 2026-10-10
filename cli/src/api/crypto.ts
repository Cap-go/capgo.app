import { Buffer } from 'node:buffer'
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateEncrypt,
  publicDecrypt,
  randomBytes,
} from 'node:crypto'

const algorithm = 'aes-128-cbc'
const formatB64 = 'base64'
const formatHex = 'hex'
const padding = constants.RSA_PKCS1_PADDING

export function generateSessionKey(key: string): { sessionKey: Buffer, ivSessionKey: string } {
  const initVector = randomBytes(16)
  const sessionKey = randomBytes(16)
  const ivB64 = initVector.toString(formatB64)
  const sessionb64Encrypted = privateEncrypt(
    {
      key,
      padding,
    },
    sessionKey,
  ).toString(formatB64)

  return {
    sessionKey,
    ivSessionKey: `${ivB64}:${sessionb64Encrypted}`,
  }
}

export function encryptSource(source: Buffer, sessionKey: Buffer, ivSessionKey: string): Buffer {
  const [ivB64] = ivSessionKey.split(':')
  const initVector = Buffer.from(ivB64, formatB64)
  // AES-128-CBC remains required for updater backward compatibility; signed checksums provide integrity verification.
  const cipher = createCipheriv(algorithm, sessionKey, initVector) // NOSONAR
  cipher.setAutoPadding(true)
  const encryptedData = Buffer.concat([cipher.update(source), cipher.final()])
  return encryptedData
}

export function decryptSource(source: Buffer, ivSessionKey: string, key: string): Buffer {
  const [ivB64, sessionb64Encrypted] = ivSessionKey.split(':')
  const sessionKey: Buffer = publicDecrypt(
    {
      key,
      padding,
    },
    Buffer.from(sessionb64Encrypted, formatB64),
  )

  // ivB64 to uft-8
  const initVector = Buffer.from(ivB64, formatB64)
  // console.log('\nSessionB64', sessionB64)

  // Keep decrypt behavior aligned with legacy bundles encrypted with AES-128-CBC.
  const decipher = createDecipheriv(algorithm, sessionKey, initVector) // NOSONAR
  decipher.setAutoPadding(true)
  const decryptedData = Buffer.concat([decipher.update(source), decipher.final()])

  return decryptedData
}

export function encryptChecksum(checksum: string, key: string): string {
  // Note: This function incorrectly treats hex checksum as base64, but is kept for backwards compatibility
  // with older plugin versions. Use encryptChecksumV3 for new plugin versions.
  const checksumEncrypted = privateEncrypt(
    {
      key,
      padding,
    },
    Buffer.from(checksum, formatB64),
  ).toString(formatB64)

  return checksumEncrypted
}

export function encryptChecksumV3(checksum: string, key: string): string {
  // V3: Correctly treats checksum as hex string and outputs hex
  const checksumEncrypted = privateEncrypt(
    {
      key,
      padding,
    },
    Buffer.from(checksum, formatHex),
  ).toString(formatHex)

  return checksumEncrypted
}

export function decryptChecksum(checksum: string, key: string): string {
  const checksumDecrypted = publicDecrypt(
    {
      key,
      padding,
    },
    Buffer.from(checksum, formatB64),
  ).toString(formatB64)

  return checksumDecrypted
}

export function decryptChecksumV3(checksum: string, key: string): string {
  // V3: Correctly treats checksum as hex string and outputs hex
  const checksumDecrypted = publicDecrypt(
    {
      key,
      padding,
    },
    Buffer.from(checksum, formatHex),
  ).toString(formatHex)

  return checksumDecrypted
}

export const BUNDLE_SIGNATURE_HEADER = 'capgo-bundle-v1'
export const MANIFEST_SIGNATURE_HEADER = 'capgo-manifest-v1'

export interface ManifestSignatureEntry {
  file_name: string
  hash: string
}

/**
 * Build the byte-exact payload signed for a bundle (zip) upload.
 * Format (UTF-8, `\n` = 0x0A):
 *   capgo-bundle-v1\n
 *   version:<versionName>\n
 *   checksum:<plain sha256 hex of the zip, lowercase>\n
 */
export function buildBundleSignaturePayload(versionName: string, checksumHex: string): string {
  return `${BUNDLE_SIGNATURE_HEADER}\nversion:${versionName}\nchecksum:${checksumHex.toLowerCase()}\n`
}

/**
 * Compare two strings as UTF-8 byte arrays (unsigned lexicographic).
 * Mirrors the ordering used by the native plugins when rebuilding the payload.
 */
export function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * Build the byte-exact payload signed for a delta manifest.
 * Format (UTF-8, `\n` = 0x0A):
 *   capgo-manifest-v1\n
 *   version:<versionName>\n
 *   <file_name>:<plain sha256 hex of the file, lowercase>\n   (one line per entry, sorted by file_name as UTF-8 bytes)
 */
export function buildManifestSignaturePayload(versionName: string, entries: ManifestSignatureEntry[]): string {
  const sorted = [...entries].sort((a, b) => compareUtf8Bytes(a.file_name, b.file_name))
  let payload = `${MANIFEST_SIGNATURE_HEADER}\nversion:${versionName}\n`
  for (const entry of sorted)
    payload += `${entry.file_name}:${entry.hash.toLowerCase()}\n`
  return payload
}

function signPayload(payload: string, privateKeyPem: string): string {
  const digest = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest()
  return privateEncrypt({ key: privateKeyPem, padding }, digest).toString(formatHex)
}

function verifyPayload(payload: string, signatureHex: string, publicKeyPem: string): boolean {
  if (!/^[0-9a-f]{512}$/.test(signatureHex))
    return false
  try {
    const recovered = publicDecrypt({ key: publicKeyPem, padding }, Buffer.from(signatureHex, formatHex))
    const digest = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest()
    return recovered.length === digest.length && recovered.equals(digest)
  }
  catch {
    return false
  }
}

/**
 * Sign the bundle metadata (version name + plain zip checksum) with the RSA private key.
 * Returns 512 lowercase hex chars (RSA-2048, PKCS#1 v1.5 padding over sha256(payload)).
 */
export function signBundleMetadata(versionName: string, checksumHex: string, privateKeyPem: string): string {
  return signPayload(buildBundleSignaturePayload(versionName, checksumHex), privateKeyPem)
}

/**
 * Sign the delta manifest metadata (version name + every file_name/plain hash) with the RSA private key.
 * Returns 512 lowercase hex chars.
 */
export function signManifestMetadata(versionName: string, entries: ManifestSignatureEntry[], privateKeyPem: string): string {
  return signPayload(buildManifestSignaturePayload(versionName, entries), privateKeyPem)
}

export function verifyBundleSignature(versionName: string, checksumHex: string, signatureHex: string, publicKeyPem: string): boolean {
  return verifyPayload(buildBundleSignaturePayload(versionName, checksumHex), signatureHex, publicKeyPem)
}

export function verifyManifestSignature(versionName: string, entries: ManifestSignatureEntry[], signatureHex: string, publicKeyPem: string): boolean {
  return verifyPayload(buildManifestSignaturePayload(versionName, entries), signatureHex, publicKeyPem)
}

interface RSAKeys {
  publicKey: string
  privateKey: string
}
export function createRSA(): RSAKeys {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })

  // Generate RSA key pair
  return {
    publicKey: publicKey.export({
      type: 'pkcs1',
      format: 'pem',
    }) as string,
    privateKey: privateKey.export({
      type: 'pkcs1',
      format: 'pem',
    }) as string,
  }
}

export function derivePublicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: 'pkcs1', format: 'pem' }) as string
}

/**
 * Calculate the key ID from a public key
 * Shows the first 20 characters of base64-encoded key body for easy visual verification
 * Note: First 12 characters (MIIBCgKCAQEA) are always the same for 2048-bit RSA PKCS#1 keys,
 * but we show all of them so users can easily match with their key file
 * @param publicKey - RSA public key in PEM format
 * @returns 20-character key ID or empty string if key is invalid
 */
export function calcKeyId(publicKey: string): string {
  if (!publicKey) {
    return ''
  }

  // Remove PEM headers and whitespace to get the raw key data
  const cleanedKey = publicKey
    .replace(/-----BEGIN RSA PUBLIC KEY-----/g, '')
    .replace(/-----END RSA PUBLIC KEY-----/g, '')
    .replace(/\n/g, '')
    .replace(/\r/g, '')
    .replace(/ /g, '')

  // Return first 20 characters - includes the standard header plus 8 unique chars
  // This makes it easy for users to visually verify against their key file
  return cleanedKey.substring(0, 20)
}
