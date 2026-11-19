export type AccountEmailPreferenceKey = 'usage_limit' | 'credit_usage' | 'onboarding' | 'builder_onboarding' | 'weekly_stats' | 'monthly_stats' | 'billing_period_stats' | 'deploy_stats_24h' | 'bundle_created' | 'bundle_deployed' | 'device_error' | 'channel_self_rejected' | 'bundle_incompatible' | 'cli_realtime_feed' | 'security_updates'

export function defaultAccountEmailPref(key: string): boolean {
  return key !== 'security_updates'
}

export function resolveAccountEmailPref(
  prefs: Partial<Record<string, boolean>>,
  key: AccountEmailPreferenceKey,
): boolean {
  return prefs[key] ?? defaultAccountEmailPref(key)
}
