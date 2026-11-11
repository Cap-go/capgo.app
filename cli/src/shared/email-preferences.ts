import { CliUserError } from './cli-user-error'

/** Email notification toggles shown in the org Notifications settings page. */
export const ORG_EMAIL_PREFERENCE_KEYS = [
  'usage_limit',
  'credit_usage',
  'bundle_created',
  'bundle_deployed',
  'deploy_stats_24h',
  'weekly_stats',
  'monthly_stats',
  'billing_period_stats',
  'device_error',
  'channel_self_rejected',
  'onboarding',
  'builder_onboarding',
] as const

/** Email notification toggles shown in the account Notifications settings page. */
export const USER_EMAIL_PREFERENCE_KEYS = [
  ...ORG_EMAIL_PREFERENCE_KEYS,
  'bundle_incompatible',
  'cli_realtime_feed',
  'security_updates',
] as const

export type EmailPreferences = Record<string, boolean>

/**
 * Parse repeatable `key=true|false` flags (commas allowed) into an email preference patch.
 */
export function parseEmailPreferenceFlags(values: string[] | undefined, allowedKeys: readonly string[]): EmailPreferences | undefined {
  if (!values?.length)
    return undefined
  const preferences: EmailPreferences = {}
  for (const entry of values.flatMap(value => value.split(','))) {
    const trimmed = entry.trim()
    if (!trimmed)
      continue
    const separator = trimmed.indexOf('=')
    const key = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim()
    const rawValue = separator === -1 ? 'true' : trimmed.slice(separator + 1).trim().toLowerCase()
    if (!allowedKeys.includes(key))
      throw new CliUserError(`Unknown email preference "${key}". Allowed: ${allowedKeys.join(', ')}`)
    if (rawValue !== 'true' && rawValue !== 'false')
      throw new CliUserError(`Email preference "${key}" must be true or false`)
    preferences[key] = rawValue === 'true'
  }
  return Object.keys(preferences).length ? preferences : undefined
}
