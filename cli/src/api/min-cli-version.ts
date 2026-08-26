import { log } from '@clack/prompts'
import { canParse, lessThan, parse } from '@std/semver'
import pack from '../../package.json'
import { CliUserError } from '../shared/cli-user-error'

export interface MinCliVersionConfig {
  minCliVersion?: string
  minCliVersionReason?: string
}

export function isCliVersionBelowMin(currentVersion: string, minCliVersion: string): boolean {
  if (!canParse(currentVersion) || !canParse(minCliVersion))
    return false
  return lessThan(parse(currentVersion), parse(minCliVersion))
}

export function formatMinCliVersionMessage(currentVersion: string, minCliVersion: string, reason?: string): string {
  const why = reason?.trim() ? `\n${reason.trim()}` : ''
  return `This Capgo API requires @capgo/cli@${minCliVersion} or newer. You are using @capgo/cli@${currentVersion}.${why}\nPlease update: npx @capgo/cli@latest`
}

export function assertMinCliVersion(
  config: MinCliVersionConfig,
  currentVersion?: string,
  silent = false,
) {
  const version = currentVersion || pack.version
  const minCliVersion = config.minCliVersion?.trim()
  if (!minCliVersion || !isCliVersionBelowMin(version, minCliVersion))
    return

  const message = formatMinCliVersionMessage(version, minCliVersion, config.minCliVersionReason)
  if (!silent)
    log.error(message)
  throw new CliUserError(message, { minCliVersion, currentVersion: version })
}
