import { platform } from 'node:os'
import { version as nodeVersion } from 'node:process'
import pack from '../../package.json'

/** Must match CAPGO_API_DEFAULT_VERSION until a newer version is intentionally adopted. */
export const CAPGO_CLI_API_VERSION = '2025-10-01'

let currentCliCommand = ''

export function setCurrentCliCommand(command: string) {
  currentCliCommand = command
}

export function getCurrentCliCommand(): string {
  return currentCliCommand
}

/**
 * Build Capgo API request headers that identify this CLI invocation.
 * Does not invent an API key — callers merge Authorization/capgkey when available.
 */
export function buildCliRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'capgo_api': CAPGO_CLI_API_VERSION,
    'x-cli-version': pack.version,
    'x-cli-command': currentCliCommand,
    'x-cli-node': nodeVersion,
    'x-cli-os': platform(),
    ...extra,
  }
}
