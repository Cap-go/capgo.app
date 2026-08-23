import { existsSync } from 'node:fs'
import { CliUserError } from '../shared/cli-user-error'

function isMissingString(value: string | undefined): value is undefined | '' {
  return typeof value !== 'string' || value.trim().length === 0
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
  const [ivB64, sessionKeyEncrypted] = normalizedIvSessionKey.split(':')
  if (!ivB64?.trim() || !sessionKeyEncrypted?.trim()) {
    throw new CliUserError(
      'Invalid ivSessionKey format. Expected "IV_BASE64:SESSION_KEY_BASE64" from the bundle encrypt output.',
    )
  }
}
