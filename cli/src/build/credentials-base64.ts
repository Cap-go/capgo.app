import { Buffer } from 'node:buffer'

const INVALID_BASE64_MESSAGE = 'The stored value is not valid Base64'
export function canDecodeCredentialBase64(key: string, value: string): boolean {
  if (key === 'CAPGO_IOS_PROVISIONING_MAP')
    return false
  return key.endsWith('_BASE64')
    || ['APPLE_KEY_CONTENT', 'ANDROID_KEYSTORE_FILE', 'PLAY_CONFIG_JSON'].includes(key)
    || (value.length >= 32 && /^[A-Z0-9+/=\s]+$/i.test(value))
}

export function decodeCredentialBase64(value: string): Buffer {
  const normalized = value.replace(/[\t\n\v\f\r ]/g, '')
  if (normalized.length === 0)
    return Buffer.alloc(0)

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized))
    throw new Error(INVALID_BASE64_MESSAGE)
  const hasPadding = normalized.includes('=')
  if (hasPadding ? normalized.length % 4 !== 0 : normalized.length % 4 === 1)
    throw new Error(INVALID_BASE64_MESSAGE)

  const decoded = Buffer.from(normalized, 'base64')
  const canonical = decoded.toString('base64')
  const expected = hasPadding ? canonical : canonical.replace(/=+$/, '')
  if (normalized !== expected)
    throw new Error(INVALID_BASE64_MESSAGE)
  return decoded
}
