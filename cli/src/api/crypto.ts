import { Buffer } from 'node:buffer'
import {
  constants,
  createCipheriv,
  createDecipheriv,
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
