import type { EmailPreferenceKey } from './org_email_notifications.ts'
import { z } from 'zod'

/** Org email toggles shown in Settings > Organization > Notifications. */
export const ORG_SETTINGS_EMAIL_PREFERENCE_KEYS = [
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
  'trial_usage_recap',
  'builder_onboarding',
] as const satisfies readonly EmailPreferenceKey[]

/** Personal email toggles shown in Settings > Account > Notifications. */
export const USER_SETTINGS_EMAIL_PREFERENCE_KEYS = [
  ...ORG_SETTINGS_EMAIL_PREFERENCE_KEYS,
  'bundle_incompatible',
  'cli_realtime_feed',
] as const satisfies readonly EmailPreferenceKey[]

/** Partial patch of known email preference keys; unknown keys fail validation. */
export function emailPreferencesPatchSchema(keys: readonly EmailPreferenceKey[]) {
  const allowed = new Set<string>(keys)
  return z.record(z.string(), z.boolean()).refine(
    value => Object.keys(value).every(key => allowed.has(key)),
    { message: `Unknown email preference key. Allowed keys: ${keys.join(', ')}` },
  )
}
