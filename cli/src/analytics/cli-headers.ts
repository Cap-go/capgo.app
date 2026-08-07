import { platform } from 'node:os'
import { version as nodeVersion } from 'node:process'
import pack from '../../package.json'

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
    'x-cli-version': pack.version,
    'x-cli-command': currentCliCommand,
    'x-cli-node': nodeVersion,
    'x-cli-os': platform(),
    ...extra,
  }
}
