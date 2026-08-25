import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { CliUserError } from '../shared/cli-user-error'

const IV_SESSION_KEY_FORMAT_MESSAGE = 'Invalid ivSessionKey format. Expected "IV_BASE64:SESSION_KEY_BASE64" from the bundle encrypt output.'
const BASE64_PATTERN = /^[\d+/A-Za-z]+={0,2}$/

function isMissingString(value: string | undefined): value is undefined | '' {
  return typeof value !== 'string' || value.trim().length === 0
}

function decodeStrictBase64(value: string, componentLabel: string): Buffer {
  if (!BASE64_PATTERN.test(value)) {
    throw new CliUserError(`${IV_SESSION_KEY_FORMAT_MESSAGE} ${componentLabel} is not valid Base64.`)
  }

  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0) {
    throw new CliUserError(`${IV_SESSION_KEY_FORMAT_MESSAGE} ${componentLabel} is not valid Base64.`)
  }

  const normalizedInput = value.replace(/=+$/, '')
  const normalizedDecoded = decoded.toString('base64').replace(/=+$/, '')
  if (normalizedDecoded !== normalizedInput) {
    throw new CliUserError(`${IV_SESSION_KEY_FORMAT_MESSAGE} ${componentLabel} is not valid Base64.`)
  }

  return decoded
}

export function requireZipPath(zipPath: string | undefined): asserts zipPath is string {
  if (isMissingString(zipPath)) {
    throw new CliUserError(
      'Missing zip path. Provide the path to your zip file, for example: npx @capgo/cli@latest bundle encrypt ./myapp.zip CHECKSUM',
    )
  }
}

export function requireExistingZipPath(zipPath: string): void {
  if (!existsSync(zipPath)) {
    throw new CliUserError(`Zip not found at ${zipPath}`)
  }
}

export function requireChecksum(checksum: string | undefined): asserts checksum is string {
  if (isMissingString(checksum)) {
    throw new CliUserError(
      'Missing checksum. Run "bundle zip --json" to get the checksum, then pass it as the second argument.',
    )
  }
}

export function requireIvSessionKey(ivSessionKey: string | undefined): asserts ivSessionKey is string {
  if (isMissingString(ivSessionKey)) {
    throw new CliUserError(
      'Missing ivSessionKey. Pass the ivSessionKey from "bundle encrypt" as the second argument.',
    )
  }

  const normalizedIvSessionKey = ivSessionKey.trim()
  const parts = normalizedIvSessionKey.split(':')
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new CliUserError(IV_SESSION_KEY_FORMAT_MESSAGE)
  }

  const [ivB64, sessionKeyEncrypted] = parts
  const iv = decodeStrictBase64(ivB64.trim(), 'IV')
  if (iv.length !== 16) {
    throw new CliUserError(`${IV_SESSION_KEY_FORMAT_MESSAGE} IV must decode to 16 bytes.`)
  }

  decodeStrictBase64(sessionKeyEncrypted.trim(), 'session key')
}
