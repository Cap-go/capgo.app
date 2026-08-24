import { platform } from 'node:os'
import { version as nodeVersion } from 'node:process'
import pack from '../../package.json'
import { CliUserError } from '../shared/cli-user-error'

/** Must match CAPGO_API_DEFAULT_VERSION until a newer version is intentionally adopted. */
export const CAPGO_CLI_API_VERSION = '2025-10-01'

let currentCliCommand = ''

const AUTH_HEADER_NAMES = new Set(['authorization', 'capgkey', 'x-capgo-log-token'])

export function setCurrentCliCommand(command: string) {
  currentCliCommand = command
}

export function getCurrentCliCommand(): string {
  return currentCliCommand
}

function isByteStringSafe(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0xFF)
      return false
  }
  return true
}

function missingAuthHeaderMessage(headerName: string): string {
  if (headerName.toLowerCase() === 'x-capgo-log-token')
    return 'Build log token is missing. Re-run the build command or pass a valid log token.'
  return 'Capgo API key is missing. Run `npx -y @capgo/cli@latest login` or pass `--apikey`.'
}

function invalidAuthHeaderMessage(headerName: string): string {
  if (headerName.toLowerCase() === 'x-capgo-log-token')
    return 'Build log token contains invalid characters (only ASCII is allowed). Re-run the build command to get a fresh token.'
  if (headerName.toLowerCase() === 'authorization')
    return 'Authorization header contains invalid characters (only ASCII is allowed). Check your Capgo API key or Supabase anon key configuration.'
  return 'Capgo API key contains invalid characters (only ASCII is allowed). Copy the key from the Capgo dashboard.'
}

/**
 * Validate a single outgoing HTTP header value before fetch/undici builds Headers.
 * Throws CliUserError with a user-facing message — never includes the secret value.
 */
export function validateCliRequestHeaderValue(headerName: string, value: unknown): string {
  if (value === undefined || value === null) {
    if (AUTH_HEADER_NAMES.has(headerName.toLowerCase()))
      throw new CliUserError(missingAuthHeaderMessage(headerName))
    throw new CliUserError(`HTTP header "${headerName}" is missing or invalid.`)
  }
  if (typeof value !== 'string') {
    if (AUTH_HEADER_NAMES.has(headerName.toLowerCase()))
      throw new CliUserError(missingAuthHeaderMessage(headerName))
    throw new CliUserError(`HTTP header "${headerName}" is missing or invalid.`)
  }
  if (!isByteStringSafe(value)) {
    if (AUTH_HEADER_NAMES.has(headerName.toLowerCase()))
      throw new CliUserError(invalidAuthHeaderMessage(headerName))
    throw new CliUserError(`HTTP header "${headerName}" contains invalid characters (only ASCII is allowed).`)
  }
  return value
}

/**
 * Build Capgo API request headers that identify this CLI invocation.
 * Does not invent an API key — callers merge Authorization/capgkey when available.
 */
export function buildCliRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'capgo_api': CAPGO_CLI_API_VERSION,
    'x-cli-version': pack.version,
    'x-cli-command': currentCliCommand,
    'x-cli-node': nodeVersion,
    'x-cli-os': platform(),
  }

  if (extra) {
    for (const [name, value] of Object.entries(extra))
      headers[name] = validateCliRequestHeaderValue(name, value)
  }

  return headers
}
