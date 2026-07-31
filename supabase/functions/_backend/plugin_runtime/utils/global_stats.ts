export const USAGE_GLOBAL_STATS_SHARDS = [
  'usage_updates',
  'usage_devices',
  'usage_device_platforms',
  'usage_registrations',
  'usage_storage',
  'usage_success_rate',
  'usage_demo_apps',
] as const

export const REQUIRED_GLOBAL_STATS_SHARDS = [
  'core',
  ...USAGE_GLOBAL_STATS_SHARDS,
  'revenue',
  'plugins',
  'builds',
  'retention',
  'paid_products',
  'ltv',
] as const

export const GLOBAL_STATS_SHARDS = [
  ...REQUIRED_GLOBAL_STATS_SHARDS,
  'notifications',
] as const
